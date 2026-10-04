// Voice chat with Atteo (vedu #1318; "Atteo", never "Grok", on screen: #1599): live speech-to-speech with xAI's Grok
// Voice Agent API, the server's src/voice.ts.
//   POST /api/app/voice/session {board?, voice?, hands_free?} → a short-lived client secret, the socket url/protocols,
//   and the `session` to send as session.update (instructions, turn detection, the function tools). The app opens the
//   socket itself. Hands-free (the default, vedu #1598): the mic streams as 24 kHz mono PCM16 the whole time, the
//   server's VAD hears where a turn starts and stops (input_audio_buffer.speech_started / speech_stopped) and answers by
//   itself; talking over Atteo stops its voice at once (barge-in: playback flushed, response.cancel, and the reply
//   truncated to what was heard). "Hold to talk" (the sheet's menu, remembered per device) is the old push-to-talk:
//   the mic streams while the button is held, then commit + response.create. It plays the audio deltas and shows both
//   sides as captions. Tools run here, against the Atteo API with the app's
//   own token (tool_routes), and go back as function_call_output + response.create. answer_approval only runs after a
//   yes: said out loud (the transcript) or tapped. Every exit settles the session: POST end {session_id, seconds}.
// The UI is TalkView.swift, the audio TalkAudio.swift, and the local fake (DEBUG only) TalkFake.swift.

import AVFoundation
import SwiftUI

// MARK: - The voice routes

enum TalkAPI {
    /// DEBUG runs with ATTEO_FAKE_VOICE=1 ask a local server (DEV_FAKE_VOICE=1, no key) for its fake provider.
    static var fake: Bool {
        #if DEBUG
        return API.environment("FAKE_VOICE") == "1"
        #else
        return false
        #endif
    }

    /// A voice route as the person: (status, JSON). Not retried: the person is waiting on it.
    static func call(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> (Int, [String: Any]) {
        guard let token = API.shared.token else { throw APIError.signedOut }
        var r = URLRequest(url: URL(string: path, relativeTo: API.shared.base)!)
        r.httpMethod = method
        r.timeoutInterval = 25
        r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        if fake { r.setValue("1", forHTTPHeaderField: "x-dev-fake-voice") }
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await URLSession.shared.data(for: r) } catch { throw APIError.offline }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        return (code, (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:])
    }
}

/// GET /api/app/voice/status, once a launch: whether Talk to Grok shows at all, and this month's minutes.
@MainActor
final class TalkStatus: ObservableObject {
    static let shared = TalkStatus()
    @Published private(set) var enabled: Bool?
    @Published private(set) var minutesUsed: Double = 0
    @Published private(set) var minutesBudget: Int = 0
    private var loading = false

    func load(force: Bool = false) async {
        guard !loading, force || enabled == nil else { return }
        loading = true
        defer { loading = false }
        guard let (code, j) = try? await TalkAPI.call("GET", "/api/app/voice/status"), code == 200 else { return }
        enabled = j["enabled"] as? Bool ?? false
        update(used: j["minutes_used"], budget: j["minutes_budget"])
    }

    func update(used: Any?, budget: Any?) {
        if let u = (used as? NSNumber)?.doubleValue { minutesUsed = u }
        if let b = (budget as? NSNumber)?.intValue { minutesBudget = b }
    }
}

// MARK: - The socket

/// One realtime conversation: JSON events both ways. The real one is xAI's WebSocket; DEBUG has a local fake.
@MainActor
protocol RealtimeLink: AnyObject {
    var events: AsyncStream<[String: Any]> { get }
    func send(_ event: [String: Any])
    func close()
}

/// xAI's realtime socket. The client secret rides as the subprotocol (what voice.ts hands out) and as a Bearer header
/// (its off-browser form), so either handshake works.
@MainActor
final class WebSocketLink: RealtimeLink {
    let events: AsyncStream<[String: Any]>
    private let out: AsyncStream<[String: Any]>.Continuation
    private let task: URLSessionWebSocketTask

    init(url: URL, protocols: [String], secret: String) {
        var r = URLRequest(url: url)
        r.setValue("Bearer \(secret)", forHTTPHeaderField: "authorization")
        if !protocols.isEmpty { r.setValue(protocols.joined(separator: ", "), forHTTPHeaderField: "Sec-WebSocket-Protocol") }
        task = URLSession.shared.webSocketTask(with: r)
        task.maximumMessageSize = 16 << 20
        (events, out) = AsyncStream.makeStream(of: [String: Any].self)
        task.resume()
        receive()
    }

    private func receive() {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let m):
                    let data: Data? = switch m {
                    case .string(let s): Data(s.utf8)
                    case .data(let d): d
                    @unknown default: nil
                    }
                    if let data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { self.out.yield(j) }
                    self.receive()
                case .failure:
                    self.out.finish()
                }
            }
        }
    }

    func send(_ event: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: event), let s = String(data: d, encoding: .utf8) else { return }
        task.send(.string(s)) { _ in }
    }

    func close() {
        task.cancel(with: .normalClosure, reason: nil)
        out.finish()
    }
}

// MARK: - A conversation

@MainActor
final class TalkSession: ObservableObject {
    struct Caption: Identifiable, Equatable {
        enum Who { case you, grok, note }
        let id: String
        let who: Who
        var text: String
        var done = false
    }

    /// An approval Grok wants to answer: nothing happens until a yes (out loud or tapped).
    struct Confirm: Equatable {
        let approval: String
        let decision: String // approve | deny
        var confirmed = false
        var verb: String { decision == "deny" ? "Deny" : "Approve" }
    }

    enum Phase: Equatable { case connecting, ready, ended }

    @Published private(set) var phase: Phase = .connecting
    @Published private(set) var captions: [Caption] = []
    @Published private(set) var holding = false
    /// Hands-free (server VAD) or hold to talk; the per-device choice (UserDefaults "talk-hold-to-talk").
    @Published private(set) var handsFree = !UserDefaults.standard.bool(forKey: TalkSession.holdKey)
    @Published private(set) var micMuted = false // hands-free: nothing is sent; Atteo can still talk
    @Published private(set) var hearing = false // the server's VAD hears you talking
    @Published private(set) var level: Float = 0 // the mic, 0…1
    @Published private(set) var speaking = false // Grok's voice is playing
    @Published private(set) var thinking = false // a response or a tool is under way
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var maxSeconds = 600
    @Published private(set) var monthLeft: Double? // minutes, after this session's cap
    @Published private(set) var confirm: Confirm?
    @Published var muted = false { didSet { audio.muted = muted } }
    @Published var problem: String?
    @Published private(set) var endNote: String?

    let board: Board?
    private var link: RealtimeLink?
    private let audio = TalkAudio()
    private var sessionId: String?
    private var endPath = "/api/app/voice/session/end"
    private var routes: [String: [String: Any]] = [:]
    private var openedAt: Date?
    private var ticker: Task<Void, Never>?
    private var reader: Task<Void, Never>?
    private var ended = false

    private var activeResponse: String? // the response Grok is giving now
    private var cancelled: Set<String> = [] // interrupted responses: their late deltas are dropped
    private var wantResponse = false // response.create waits for the active one to finish
    private var handledCalls: Set<String> = []
    private var toolsRunning = 0
    private var audioUntil = Date.distantPast
    private var holdStarted = Date.distantPast
    private var holdInterrupted = false
    private var appended = 0
    private var youCaption: String? // this turn's "you" line, until its transcript lands
    private var session: [String: Any] = [:] // what session.update sends; resent with new turn detection on a mode switch
    private var audioItem: String? // the assistant item whose audio is playing (for truncate on barge-in)
    private var itemAudio: TimeInterval = 0 // seconds of it queued so far
    private var stoppedAt: Date? // when the VAD last heard you stop

    static let holdKey = "talk-hold-to-talk"

    init(board: Board?) { self.board = board }

    var secondsLeft: Int { max(0, maxSeconds - Int(elapsed)) }
    /// This month's minutes left, counting this session as it goes (the server charged its whole cap up front).
    var monthMinutesLeft: Int? {
        guard let m = monthLeft else { return nil }
        return Int(phase == .ended || endNote != nil ? m : m + max(0, Double(maxSeconds) - elapsed) / 60)
    }

    // MARK: Start and end

    func start() async {
        ReadAloud.shared.hush()
        VoiceInput.shared.stop()
        var body: [String: Any] = [:]
        if let b = board, b.encrypted != true { body["board"] = b.id }
        body["hands_free"] = handsFree
        let code: Int, j: [String: Any]
        do { (code, j) = try await TalkAPI.call("POST", "/api/app/voice/session", body: body) } catch {
            finish(problem: error.localizedDescription); return
        }
        guard code == 200, let sid = j["session_id"] as? String, let session = j["session"] as? [String: Any] else {
            if code == 503 { TalkStatus.shared.objectWillChange.send(); await TalkStatus.shared.load(force: true) }
            finish(problem: j["error"] as? String ?? "Couldn't start talking (\(code)).")
            return
        }
        sessionId = sid
        if let p = (j["end"] as? [String: Any])?["path"] as? String { endPath = p }
        routes = j["tool_routes"] as? [String: [String: Any]] ?? [:]
        maxSeconds = (j["max_seconds"] as? NSNumber)?.intValue ?? 600
        if let used = (j["minutes_used"] as? NSNumber)?.doubleValue, let budget = (j["minutes_budget"] as? NSNumber)?.doubleValue {
            monthLeft = max(0, budget - used) // used already counts this session's whole cap
            TalkStatus.shared.update(used: used, budget: budget)
        }
        guard !ended else { await settle(); return } // closed while it was starting

        let provider = j["provider"] as? String ?? ""
        var made: RealtimeLink?
        #if DEBUG
        if provider == "fake" { made = FakeGrokLink() }
        #endif
        if made == nil {
            guard provider != "fake", let s = j["url"] as? String, let url = URL(string: s) else { finish(problem: "The voice service answered without a socket."); return }
            let secret = (j["token"] as? [String: Any])?["value"] as? String ?? ""
            made = WebSocketLink(url: url, protocols: j["protocols"] as? [String] ?? [], secret: secret)
        }
        guard let link = made else { return }
        self.link = link

        audio.useMic = provider != "fake" // the fake never asks for the microphone (no permission prompt in tests) nor plays
        audio.events = { [weak self] e in self?.audioEvent(e) }
        if audio.useMic, !(await AVAudioApplication.requestRecordPermission()) {
            problem = "Allow the microphone for Atteo in Settings to use voice chat. You can still read what Atteo says."
        }
        audio.onLevel = { [weak self] l in
            guard let self else { return }
            let on = self.handsFree ? !self.micMuted : self.holding
            self.level = on ? l : 0
        }
        // The fake stays silent (its "voice" is only timed): a simulator under test can hang starting audio I/O.
        if audio.useMic {
            do { try audio.start() } catch { problem = "Audio isn't working (\(error.localizedDescription)); captions still show." }
        }

        self.session = session
        link.send(["type": "session.update", "session": session])
        openedAt = Date()
        phase = .ready
        if handsFree { listen() }
        Haptics.play(.touch)
        reader = Task { [weak self] in
            for await e in link.events { self?.handle(e) }
            self?.finish(problem: self?.ended == false ? "The voice connection closed." : nil)
        }
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 250_000_000)
                self?.tick()
            }
        }
    }

    private func tick() {
        guard let openedAt, !ended else { return }
        elapsed = Date().timeIntervalSince(openedAt)
        let s = Date() < audioUntil
        if s != speaking { speaking = s }
        // The VAD heard something that never became a turn (a cough, a door): don't sit on "Thinking…".
        if thinking, activeResponse == nil, toolsRunning == 0, let t = stoppedAt, Date().timeIntervalSince(t) > 8 { thinking = false; stoppedAt = nil }
        if elapsed >= Double(maxSeconds) { finish(problem: "That's this session's time. Start another to keep talking.") }
    }

    /// Ends it: the socket closes, the audio stops, and the minutes not used go back to the month.
    func end() { finish(problem: nil) }

    private func finish(problem p: String?) {
        guard !ended else { return }
        ended = true
        if let p { problem = p }
        ticker?.cancel(); reader?.cancel()
        link?.close(); link = nil
        audio.stop()
        holding = false; speaking = false; thinking = false; hearing = false; level = 0; confirm = nil
        phase = .ended
        if let openedAt { elapsed = Date().timeIntervalSince(openedAt) }
        Task { await settle() }
    }

    private func settle() async {
        guard let sid = sessionId else { return }
        sessionId = nil
        let seconds = openedAt.map { Int(Date().timeIntervalSince($0).rounded(.up)) } ?? 0
        if let (code, j) = try? await TalkAPI.call("POST", endPath, body: ["session_id": sid, "seconds": seconds]), code == 200 {
            TalkStatus.shared.update(used: j["minutes_used"], budget: j["minutes_budget"])
            if let u = (j["minutes_used"] as? NSNumber)?.doubleValue, let b = (j["minutes_budget"] as? NSNumber)?.doubleValue {
                monthLeft = max(0, b - u)
                endNote = "\(Self.clock(seconds)) used · \(Int(max(0, b - u))) min left this month"
            }
        }
    }

    // MARK: Hands-free

    /// The mic streams from now on (unless muted); the server's VAD finds the turns. Without echo cancelling the mic
    /// pauses while Atteo talks, or the VAD would hear Atteo through the speaker and interrupt it.
    private func listen() {
        guard audio.useMic else { return } // the fake: its person speaks when the orb is tapped (orbTapped)
        audio.capture { [weak self] b64 in
            guard let self, self.handsFree, !self.micMuted, self.audio.echoCancelling || !self.speaking else { return }
            self.link?.send(["type": "input_audio_buffer.append", "audio": b64])
        }
    }

    /// Hold to talk on or off (the sheet's menu): remembered on this device, and switched live by resending the session
    /// with the other turn detection.
    func setHandsFree(_ on: Bool) {
        guard on != handsFree else { return }
        UserDefaults.standard.set(!on, forKey: Self.holdKey)
        if holding { holdEnded() }
        handsFree = on
        hearing = false; level = 0
        guard phase == .ready, !session.isEmpty else { return }
        audio.stopCapture()
        link?.send(["type": "input_audio_buffer.clear"])
        var s = session
        s["turn_detection"] = on ? ["type": "server_vad"] : NSNull()
        session = s
        link?.send(["type": "session.update", "session": s])
        if on { listen() }
        Haptics.play(.touch)
    }

    /// Mic off: nothing more goes to Atteo (it can still finish talking); on again: it listens.
    func toggleMic() {
        micMuted.toggle()
        Haptics.play(.touch)
        if micMuted {
            level = 0
            hearing = false
            if phase == .ready { link?.send(["type": "input_audio_buffer.clear"]) } // no half-heard turn left behind
        }
    }

    /// The orb, hands-free: while Atteo talks, a tap stops it. (DEBUG's fake: a tap is the person saying the next line.)
    func orbTapped() {
        guard phase == .ready else { return }
        #if DEBUG
        if let fake = link as? FakeGrokLink { if !micMuted { fake.personSpeaks() }; return }
        #endif
        if speaking || activeResponse != nil { interrupt() }
    }

    // MARK: Push to talk

    /// The big button went down: stop Grok if it's talking (barge in), then listen.
    func holdBegan() {
        guard phase == .ready, !holding else { return }
        holdInterrupted = speaking || activeResponse != nil
        if holdInterrupted { interrupt() }
        holding = true
        holdStarted = Date()
        appended = 0
        Haptics.play(.touch)
        if audio.useMic {
            audio.capture { [weak self] b64 in
                guard let self, self.holding else { return }
                self.appended += 1
                self.link?.send(["type": "input_audio_buffer.append", "audio": b64])
            }
        } else {
            // The fake: a breath of silence stands in for the microphone.
            appended += 1
            link?.send(["type": "input_audio_buffer.append", "audio": Data(count: 4800).base64EncodedString()])
        }
    }

    /// Let go: what was said goes to Grok (a quick tap that only stopped Grok sends nothing).
    func holdEnded() {
        guard holding else { return }
        holding = false
        audio.stopCapture()
        let short = Date().timeIntervalSince(holdStarted) < 0.35
        if appended == 0 || (holdInterrupted && short) {
            link?.send(["type": "input_audio_buffer.clear"])
            return
        }
        link?.send(["type": "input_audio_buffer.commit"])
        let id = "you-\(UUID().uuidString)"
        youCaption = id
        captions.append(Caption(id: id, who: .you, text: "…"))
        requestResponse()
    }

    /// Tap while Atteo talks, or start talking over it: stop its voice now, cancel the rest of the answer, and cut the
    /// reply in the conversation down to what was actually heard (conversation.item.truncate), so it knows.
    func interrupt() {
        let wasSpeaking = speaking || activeResponse.map { r in captions.last?.id == "grok-\(r)" } == true
        let left = max(0, audioUntil.timeIntervalSinceNow)
        audio.stopPlayback()
        audioUntil = .distantPast
        speaking = false
        if let r = activeResponse {
            cancelled.insert(r)
            link?.send(["type": "response.cancel"])
        }
        if let item = audioItem, itemAudio > 0 {
            let heard = max(0, itemAudio - left)
            link?.send(["type": "conversation.item.truncate", "item_id": item, "content_index": 0, "audio_end_ms": Int(heard * 1000)])
        }
        audioItem = nil; itemAudio = 0
        if wasSpeaking, let i = captions.lastIndex(where: { $0.who == .grok }), !captions[i].text.hasSuffix(" —") { captions[i].text += " —"; captions[i].done = true }
        Haptics.play(.touch)
    }

    // MARK: Approvals: a yes first

    func answerConfirm(_ yes: Bool) {
        guard let c = confirm else { return }
        confirm = nil
        Haptics.play(yes ? .approved : .denied)
        Task {
            var said = "I tapped No on the screen: don't \(c.decision) it."
            if yes {
                let out = await runRoute("answer_approval", ["approval_id": c.approval, "decision": c.decision])
                said = "I tapped Yes on the screen, so the app did it: \(c.decision) \(c.approval). Result: \(out)"
            }
            link?.send(["type": "conversation.item.create", "item": ["type": "message", "role": "user", "content": [["type": "input_text", "text": said]]]])
            requestResponse()
        }
    }

    /// A clear yes to this decision ("approve it" counts only for an approve, "deny it" only for a deny).
    static func saysYes(_ s: String, to decision: String) -> Bool {
        let t = words(s)
        if saysNo(s, to: decision) || t.range(of: #" (not|wait) "#, options: .regularExpression) != nil { return false }
        let mine = decision == "deny" ? "deny it|reject it" : "approve it"
        return t.range(of: " (yes|yeah|yep|yup|sure|confirm|confirmed|correct|go ahead|do it|\(mine)) ", options: .regularExpression) != nil
    }

    /// A no, or the opposite decision ("deny it" while an approve waits).
    static func saysNo(_ s: String, to decision: String) -> Bool {
        let other = decision == "deny" ? "approve" : "deny|reject"
        return words(s).range(of: " (no|nope|don't|dont|cancel|never mind|stop|\(other)) ", options: .regularExpression) != nil
    }

    private static func words(_ s: String) -> String {
        " " + s.lowercased().replacingOccurrences(of: #"[^a-z' ]"#, with: " ", options: .regularExpression) + " "
    }

    // MARK: Events from Grok

    private func requestResponse() {
        if activeResponse != nil { wantResponse = true } else { link?.send(["type": "response.create"]) }
    }

    private func handle(_ e: [String: Any]) {
        guard !ended, let type = e["type"] as? String else { return }
        let rid = (e["response_id"] as? String) ?? ((e["response"] as? [String: Any])?["id"] as? String)
        if let rid, cancelled.contains(rid), type != "response.done" { return }
        switch type {
        case "response.created":
            activeResponse = rid ?? "r-\(UUID().uuidString)"
            thinking = true
            stoppedAt = nil
        case "response.output_audio.delta", "response.audio.delta":
            guard let b64 = e["delta"] as? String, let pcm = Data(base64Encoded: b64) else { return }
            let d = audio.play(pcm)
            audioUntil = max(audioUntil, Date()) + d
            if !speaking { speaking = true }
            if let item = e["item_id"] as? String {
                if item != audioItem { audioItem = item; itemAudio = 0 }
                itemAudio += d
            }
        case "input_audio_buffer.speech_started":
            // You started talking: if Atteo was, it stops right now (barge-in).
            hearing = true
            stoppedAt = nil
            if speaking || activeResponse != nil { interrupt() }
            if youCaption == nil { let id = "you-\(UUID().uuidString)"; youCaption = id; captions.append(Caption(id: id, who: .you, text: "…")) }
        case "input_audio_buffer.speech_stopped":
            hearing = false
            thinking = true // the server answers by itself
            stoppedAt = Date()
        case "response.output_audio_transcript.delta", "response.audio_transcript.delta", "response.output_text.delta", "response.text.delta":
            guard let d = e["delta"] as? String else { return }
            grokSays(rid, append: d)
        case "response.output_audio_transcript.done", "response.audio_transcript.done", "response.output_text.done", "response.text.done":
            if let t = (e["transcript"] as? String) ?? (e["text"] as? String), !t.isEmpty { grokSays(rid, replace: t) }
        case "conversation.item.input_audio_transcription.delta", "conversation.item.input_audio_transcription.updated":
            if let d = e["delta"] as? String { youSaid(append: d) }
        case "conversation.item.input_audio_transcription.completed":
            youSaid(final: e["transcript"] as? String ?? "")
        case "response.function_call_arguments.done":
            call(name: e["name"] as? String, id: e["call_id"] as? String, arguments: e["arguments"])
        case "response.output_item.done":
            if let item = e["item"] as? [String: Any], item["type"] as? String == "function_call" {
                call(name: item["name"] as? String, id: item["call_id"] as? String, arguments: item["arguments"])
            }
        case "response.done":
            if let r = rid ?? activeResponse, let i = captions.lastIndex(where: { $0.id == "grok-\(r)" }) { captions[i].done = true }
            if let rid { cancelled.remove(rid) }
            activeResponse = nil
            thinking = toolsRunning > 0
            if let y = youCaption, let i = captions.firstIndex(where: { $0.id == y }), captions[i].text == "…" { captions[i].text = "(spoke)"; youCaption = nil }
            if wantResponse { wantResponse = false; link?.send(["type": "response.create"]) }
        case "error":
            let m = (e["error"] as? [String: Any])?["message"] as? String ?? "Grok had a problem."
            // Cancelling with nothing to cancel is harmless; anything else is worth a line.
            if !m.lowercased().contains("cancel"), !m.lowercased().contains("truncat") { captions.append(Caption(id: "err-\(UUID().uuidString)", who: .note, text: m, done: true)) }
        default: break
        }
    }

    private func grokSays(_ rid: String?, append: String? = nil, replace: String? = nil) {
        let id = "grok-\(rid ?? activeResponse ?? "x")"
        if let i = captions.lastIndex(where: { $0.id == id }) {
            if let replace { captions[i].text = replace } else if let append { captions[i].text += append }
        } else {
            captions.append(Caption(id: id, who: .grok, text: replace ?? append ?? ""))
        }
    }

    private func youSaid(append: String? = nil, final: String? = nil) {
        if youCaption == nil { let id = "you-\(UUID().uuidString)"; youCaption = id; captions.append(Caption(id: id, who: .you, text: "…")) }
        guard let y = youCaption, let i = captions.firstIndex(where: { $0.id == y }) else { return }
        if let append { captions[i].text = (captions[i].text == "…" ? "" : captions[i].text) + append }
        if let final {
            if !final.isEmpty { captions[i].text = final }
            captions[i].done = true
            youCaption = nil
            // The yes (or no) an approval is waiting on.
            if let c = confirm {
                if Self.saysYes(final, to: c.decision) { confirm?.confirmed = true } else if Self.saysNo(final, to: c.decision) { confirm = nil }
            }
        }
    }

    // MARK: Tools

    private func call(name: String?, id: String?, arguments: Any?) {
        guard let name, let id, !handledCalls.contains(id) else { return }
        handledCalls.insert(id)
        let args: [String: Any] = {
            if let d = arguments as? [String: Any] { return d }
            if let s = arguments as? String, let j = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] { return j }
            return [:]
        }()
        toolsRunning += 1
        thinking = true
        let note = Caption(id: "tool-\(id)", who: .note, text: Self.doing(name, args))
        captions.append(note)
        Task {
            let output = await runTool(name, args)
            toolsRunning -= 1
            if let i = captions.firstIndex(where: { $0.id == note.id }) { captions[i].done = true }
            guard !ended else { return }
            link?.send(["type": "conversation.item.create", "item": ["type": "function_call_output", "call_id": id, "output": output]])
            requestResponse()
        }
    }

    static func doing(_ name: String, _ a: [String: Any]) -> String {
        switch name {
        case "post_to_my_agent": return "Telling your agent"
        case "read_board": return "Reading the board"
        case "mailbox_summary": return "Checking what's waiting for you"
        case "recap": return "Catching up on the board"
        case "answer_approval": return (a["decision"] as? String == "deny" ? "Deny" : "Approve") + " — waiting for your yes"
        case "list_boards": return "Looking at your boards"
        default: return name
        }
    }

    private func runTool(_ name: String, _ a: [String: Any]) async -> String {
        guard name == "answer_approval" else { return await runRoute(name, a) }
        let id = a["approval_id"] as? String ?? "", decision = a["decision"] as? String ?? ""
        guard id.hasPrefix("ap_"), decision == "approve" || decision == "deny" else { return Self.json(["error": "Send approval_id (ap_…) and decision (approve or deny)."]) }
        // A second call after a yes for the same thing runs it; anything else asks first.
        if let c = confirm, c.approval == id, c.decision == decision, c.confirmed {
            confirm = nil
            return await runRoute(name, a)
        }
        confirm = Confirm(approval: id, decision: decision)
        Haptics.play(.warning)
        return Self.json(["done": false, "needs_confirmation": true,
                          "message": "Nothing was done yet. Say exactly what \(decision == "deny" ? "denying" : "approving") \(id) will do and ask for a clear yes. The app runs it only after the person says yes (or taps Yes); after a spoken yes, call answer_approval again."])
    }

    /// Runs a tool's Atteo route (voice.ts TOOL_ROUTES) as the person. The answer is short JSON for Grok.
    private func runRoute(_ name: String, _ a: [String: Any]) async -> String {
        let me = AppState.shared.me?.owner ?? ""
        let boards = AppState.shared.boards
        func boardArg() -> String? { (a["board"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? board?.id }
        func encrypted(_ id: String) -> Bool { boards.first { $0.id == id }?.encrypted == true }
        let locked = Self.json(["error": "That board is end-to-end encrypted: voice can't read or post there. Open it in the app."])
        do {
            switch name {
            case "list_boards":
                let j = try await getJSON("/api/me/boards")
                let list = (j["boards"] as? [[String: Any]] ?? []).filter { $0["archived"] as? Bool != true }.prefix(40).map { b in
                    ["id": b["id"] ?? "", "title": b["title"] ?? "", "kind": b["kind"] ?? "board", "messages": b["entry_count"] ?? 0, "encrypted": b["encrypted"] ?? false] as [String: Any]
                }
                return Self.json(["boards": Array(list)])
            case "mailbox_summary":
                return Self.trim(try await getRaw("/api/mailbox?peek=1"))
            case "read_board":
                guard let b = boardArg() else { return Self.json(["error": "Which board? Call list_boards."]) }
                if encrypted(b) { return locked }
                var since = (a["since"] as? NSNumber)?.intValue
                if since == nil {
                    let count = (try await getJSON("/api/me/boards")["boards"] as? [[String: Any]] ?? []).first { $0["id"] as? String == b }?["entry_count"] as? Int ?? 0
                    since = max(0, count - 30)
                }
                let j = try await getJSON("/api/boards/\(b)/entries?after=\(since ?? 0)&limit=30")
                let entries = (j["entries"] as? [[String: Any]] ?? []).map { e in
                    ["seq": e["seq"] ?? 0, "author": e["author"] ?? "", "via": e["via"] ?? "", "type": e["type"] ?? "", "text": String((e["text"] as? String ?? "").prefix(500))] as [String: Any]
                }
                return Self.json(["board": b, "entries": entries])
            case "recap":
                guard let b = boardArg() else { return Self.json(["error": "Which board? Call list_boards."]) }
                if encrypted(b) { return locked }
                let since = (a["since"] as? NSNumber).map { "?since=\($0.intValue)" } ?? ""
                return Self.trim(try await getRaw("/api/boards/\(b)/recap\(since)"))
            case "post_to_my_agent":
                let text = (a["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return Self.json(["error": "Nothing to send."]) }
                var target = (a["board"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                var body = text
                if let t = target {
                    if encrypted(t) { return locked }
                    body = "@\(me)'s agent " + text
                } else {
                    let d = try await API.shared.send("/api/me/agent-chat", body: [String: Any](), retries: false)
                    target = (try? JSONSerialization.jsonObject(with: d) as? [String: Any])?["board"] as? String
                }
                guard let t = target else { return Self.json(["error": "Couldn't find your agent's chat."]) }
                let d = try await API.shared.send("/api/boards/\(t)/entries", body: ["type": "note", "text": body], retries: false)
                let seq = (try? JSONSerialization.jsonObject(with: d) as? [String: Any])?["seq"] ?? NSNull()
                AppState.shared.pulse = AppState.Pulse(board: t, at: Date())
                return Self.json(["ok": true, "board": t, "seq": seq])
            case "answer_approval":
                let id = a["approval_id"] as? String ?? "", decision = a["decision"] as? String ?? "approve"
                let paths = routes[name]?["paths"] as? [String: String]
                let path = (paths?[decision] ?? (decision == "deny" ? "/api/approvals/{approval_id}/reject" : "/api/approvals/{approval_id}/approve"))
                    .replacingOccurrences(of: "{approval_id}", with: id)
                let d = try await API.shared.send(path, body: [String: Any](), retries: false)
                Haptics.play(decision == "deny" ? .denied : .approved)
                return Self.trim(d, fallback: Self.json(["ok": true]))
            default:
                return Self.json(["error": "Unknown tool \(name)."])
            }
        } catch {
            return Self.json(["error": error.localizedDescription])
        }
    }

    private func getRaw(_ path: String) async throws -> Data { try await API.shared.download(path) }
    private func getJSON(_ path: String) async throws -> [String: Any] {
        (try JSONSerialization.jsonObject(with: try await getRaw(path)) as? [String: Any]) ?? [:]
    }

    static func json(_ o: Any) -> String {
        (try? JSONSerialization.data(withJSONObject: o)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }

    /// At most about 8 KB back to Grok: it summarises, it doesn't read out.
    static func trim(_ d: Data, fallback: String = "{}") -> String {
        guard var s = String(data: d, encoding: .utf8), !s.isEmpty else { return fallback }
        if s.count > 8000 { s = json(["truncated": true, "data": String(s.prefix(7800))]) }
        return s
    }

    static func clock(_ s: Int) -> String { String(format: "%d:%02d", s / 60, s % 60) }

    // MARK: Audio

    private func audioEvent(_ e: TalkAudio.Event) {
        switch e {
        case .interrupted:
            holdEnded()
            audioUntil = .distantPast
            speaking = false
            hearing = false; level = 0
            problem = "Paused: another app or a call took the audio. Voice chat picks up when it's done."
        case .resumed:
            if problem?.hasPrefix("Paused") == true { problem = nil }
        case .failed(let m):
            problem = "Audio isn't working (\(m)); captions still show."
        }
    }
}
