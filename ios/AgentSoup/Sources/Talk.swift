// Voice chat with Atteo (vedu #1318; "Atteo", never "Grok", on screen: #1599): live speech-to-speech with xAI's Grok
// Voice Agent API, the server's src/voice.ts.
//   POST /api/app/voice/session {board?, voice?, hands_free?} → a short-lived client secret, the socket url/protocols,
//   and the `session` to send as session.update (instructions, turn detection, the function tools). The app opens the
//   socket itself. Hands-free (the default, vedu #1598): the mic streams as 24 kHz mono PCM16 the whole time, the
//   server's VAD hears where a turn starts and stops (input_audio_buffer.speech_started / speech_stopped) and answers by
//   itself; talking over Atteo stops its voice at once (barge-in: playback flushed, response.cancel, and the reply
//   truncated to what was heard). "Hold to talk" (the sheet's menu, remembered per device) is the old push-to-talk:
//   the mic streams while the button is held, then commit + response.create. It plays the audio deltas and captions
//   them calmly (#1796): Atteo a finished sentence at a time, your words once, when final; the sheet's menu picks All,
//   Atteo only (the default) or Off. Tools run here, against the Atteo API with the app's
//   own token (tool_routes), and go back as function_call_output + response.create. answer_approval and post_to_my_agent
//   only run after a yes (#1761): said out loud (a short, plain yes: TalkYes.swift) or tapped; a post is read back word
//   for word first, and only that exact text goes. Every exit settles the session: POST end {session_id, seconds}.
// A long hands-free call stands by when it goes quiet (TalkStandby.swift, jxn #2071): the socket closes and the
// session settles, the sheet stays; a tap or AirPods' play starts a new session that's told the last few turns. While
// it stands by, new messages are read aloud (/api/app/tts {board, seq, from: true}).
// When Atteo answers (vedu #2460, VoiceTurns.swift): hands-free "quick" is the server's VAD, as above; "pause" and "tap"
// (the session's turn_detection null) end the turn here, with commit + response.create: after a pause of quiet once you
// spoke, or on Done / AirPods' play-pause. Talking over Atteo still stops it (TalkTurns hears you start).
// The UI is TalkView.swift, the audio TalkAudio.swift, and the local fake (DEBUG only) TalkFake.swift.

import AVFoundation
import Combine
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
        let (code, data, _) = try await raw(method, path, body: body)
        return (code, (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:])
    }

    /// The same, answering the bytes and the response (audio from /api/app/tts).
    static func raw(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> (Int, Data, HTTPURLResponse?) {
        try AIConsent.check(path) // nothing reaches xAI before the person's OK (AIConsent.swift)
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
        let http = resp as? HTTPURLResponse
        return (http?.statusCode ?? 0, data, http)
    }
}

/// GET /api/app/voice/status, once a launch: whether Talk to Grok shows at all, and this month's minutes.
@MainActor
final class TalkStatus: ObservableObject {
    static let shared = TalkStatus()
    @Published private(set) var enabled: Bool?
    @Published private(set) var minutesUsed: Double = 0
    @Published private(set) var minutesBudget: Int = 0
    /// display.voice_autosend (vedu #2638): your own dictated words to your agent go without a yes, after 5 s with Undo.
    /// nil: a server from before it (the switch stays hidden).
    @Published private(set) var autosend: Bool?
    private var loading = false

    func load(force: Bool = false) async {
        guard !loading, force || enabled == nil else { return }
        loading = true
        defer { loading = false }
        guard let (code, j) = try? await TalkAPI.call("GET", "/api/app/voice/status"), code == 200 else { return }
        enabled = j["enabled"] as? Bool ?? false
        autosend = j["voice_autosend"] as? Bool
        AIConsent.sync(j["consent"]) // the OK to use xAI, as the server has it (another device may have changed it)
        update(used: j["minutes_used"], budget: j["minutes_budget"])
    }

    /// Settings → Voice chat → "Send what I dictate without asking": saved to display.voice_autosend (the web follows it).
    func setAutosend(_ on: Bool) async {
        let was = autosend
        autosend = on
        guard let (code, _) = try? await TalkAPI.call("POST", "/api/app/prefs", body: ["display": ["voice_autosend": on]]), code == 200 else { autosend = was; return }
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
        enum Who { case you, grok, note, heard } // heard: a new message read aloud while standing by ("theo: …")
        let id: String
        let who: Who
        var text: String
        var done = false
        var isPrivate = false // heard: a People only / Just mine message (shown and read to the person, never recapped)
    }

    /// Something Atteo wants to do for the person: nothing happens until a yes (out loud or tapped). A post carries the
    /// exact text and board that were read back (#1761): only that runs.
    struct Confirm: Equatable {
        enum Kind: Equatable {
            case approval(id: String, decision: String) // approve | deny
            case post(text: String, board: String?) // board nil: the person's agent chat
        }
        let kind: Kind
        var confirmed = false

        /// What a spoken yes is matched against (TalkYes): approve | deny | post.
        var decision: String {
            switch kind {
            case .approval(_, let d): return d
            case .post: return "post"
            }
        }
    }

    /// standby: the socket is closed and the session settled; the sheet waits for a tap or play (TalkStandby.swift).
    enum Phase: Equatable { case connecting, ready, standby, ended }

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
    @Published private(set) var reading = false // standing by: a new message is being read aloud
    @Published private(set) var standbyNote: String? // standing by: why it couldn't resume, or read-aloud is used up
    /// When Atteo answers (VoiceTurns.swift): what this call runs (the server's say, from the person's choice).
    @Published private(set) var turns: VoiceTurns = .quick
    @Published private(set) var turnHeard = false // pause / tap: you've said something this turn (Done can send it)
    @Published private(set) var pauseProgress: Double? // pause: how full the wait after you went quiet is (0…1)

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

    // Standing by (TalkStandby.swift).
    private var lastActive = Date() // the last moment something was going on in the live call
    private var liveSeconds: TimeInterval = 0 // every session of this call, live, so far
    private var settling: Task<Void, Never>? // the last session's /session/end, awaited before the next one starts
    private var instructions: String? // the first session's, which a resumed one gets again with the recap
    private let remote = TalkRemote()
    private var watching: [AnyCancellable] = []
    private var seenSeq = 0 // the board's newest message when it stood by: only later ones are read
    private var seenInbox = 0 // Ask: the newest For-you item when it stood by
    private var toRead: [Heard] = []
    private var readingTask: Task<Void, Never>? // reading the queue aloud
    private var player: AVAudioPlayer?
    private var playerDone: CheckedContinuation<Void, Never>?
    private var playerDelegate: PlayerDone?
    private var ttsOut = false // this month's read-aloud is used up: captions only
    private var fetchLater: Task<Void, Never>?
    private var generation = 0 // which session: a tool that finishes after its session closed is dropped

    /// A message to read aloud: where it is (the server reads exactly that one) and what the caption says.
    /// `isPrivate`: People only or Just mine (or not known to be everyone's): read to the person, never told to the model.
    struct Heard: Equatable { let board: String; let seq: Int; let who: String; let text: String; let encrypted: Bool; let isPrivate: Bool }

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
    private var grokPending: [String: String] = [:] // caption id → Atteo's words after its last finished sentence
    private var tracker = TalkTurns() // pause / tap: where you start and stop, from the mic level
    private var bufferSince = Date() // pause / tap: when the buffer was last cleared (or a turn sent)
    private var requestedTurns: VoiceTurns? // switched during this call: the next session asks for it
    // Auto-send (vedu #2638, jxn's agent #2644): your own last transcript can post to your agent without a yes.
    private var autosend = false // display.voice_autosend, from the session
    private var atteoEnd: Date? // when Atteo's voice stops (or stopped): playback queued until then, cut short by a barge-in
    private var youStartedAfter: Double? // ms after Atteo's voice stopped that this turn's speech began (negative: over it)
    private var youStartedSeen = false // this turn had a speech start of its own
    private struct LastYou { let text: String; let afterMs: Double?; var response: String? = nil }
    /// Your last final transcript, once and only while fresh: an auto-send uses it up, and it's dropped when Atteo's
    /// answer to it (the next response) finishes (opus-d #2726), so it can't qualify a later post.
    private var lastYou: LastYou?
    /// Your own words, held before they go (5 s, with Undo).
    struct PendingSend: Equatable { let id: UUID; let text: String; var secondsLeft: Int; var sending = false }
    @Published private(set) var pendingSend: PendingSend?
    private var pendingTask: Task<Void, Never>?

    static let holdKey = "talk-hold-to-talk"

    /// What the captions show (#1796), per device (UserDefaults "talk-captions"): Atteo only unless chosen otherwise.
    enum CaptionMode: String, CaseIterable, Identifiable {
        case all, atteo, off
        static let key = "talk-captions"
        static var saved: CaptionMode { UserDefaults.standard.string(forKey: key).flatMap(CaptionMode.init) ?? .atteo }
        var id: String { rawValue }
        var title: LocalizedStringKey {
            switch self {
            case .all: return "All"
            case .atteo: return "Atteo only"
            case .off: return "Off"
            }
        }
        func shows(_ c: Caption) -> Bool {
            switch self {
            case .all: return c.who != .you || c.done // your words once, when they're final
            case .atteo: return c.who != .you
            case .off: return false
            }
        }
    }

    init(board: Board?) {
        self.board = board
        AudioOut.shared.onChange { [weak self] on in self?.audio.setLoudspeaker(on) } // the speaker button (#2384)
    }

    var secondsLeft: Int { max(0, maxSeconds - Int(elapsed)) }
    /// This month's minutes left, counting this session as it goes (the server charged its whole cap up front).
    var monthMinutesLeft: Int? {
        guard let m = monthLeft else { return nil }
        return Int(phase == .ready && endNote == nil ? m + max(0, Double(maxSeconds) - elapsed) / 60 : m)
    }

    // MARK: Start and end

    func start() async {
        ReadAloud.shared.hush()
        VoiceInput.shared.stop()
        remote.on { [weak self] c in self?.remoteCommand(c) }
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 250_000_000)
                self?.tick()
            }
        }
        await connect(resuming: false)
    }

    /// One realtime session: POST /session, the socket, session.update. A resumed one gets the first session's
    /// instructions plus a short recap of the last turns, and a refusal (the minute's limit, the month) leaves the call
    /// standing by with the reason instead of ending it.
    private func connect(resuming: Bool) async {
        phase = .connecting
        var body: [String: Any] = [:]
        if let b = board, b.encrypted != true { body["board"] = b.id }
        body["hands_free"] = handsFree
        body["client_turns"] = true // this app can end a turn itself (pause, tap)
        body["voice_turns"] = (requestedTurns ?? VoiceTurns.chosen).rawValue
        let code: Int, j: [String: Any]
        do { (code, j) = try await TalkAPI.call("POST", "/api/app/voice/session", body: body) } catch {
            failed(error.localizedDescription, resuming: resuming); return
        }
        guard code == 200, let sid = j["session_id"] as? String, var session = j["session"] as? [String: Any] else {
            // The OK was withdrawn elsewhere: this phone forgets it and the sheet asks again (TalkSheet watches it).
            if AIConsent.isRefusal(code, j) { AIConsent.xai = false; failed(j["error"] as? String ?? "", resuming: resuming); return }
            if code == 503 { TalkStatus.shared.objectWillChange.send(); await TalkStatus.shared.load(force: true) }
            failed(j["error"] as? String ?? String(localized: "Couldn't start talking (\(code)).", bundle: .l10n), resuming: resuming)
            return
        }
        sessionId = sid
        if let p = (j["end"] as? [String: Any])?["path"] as? String { endPath = p }
        routes = j["tool_routes"] as? [String: [String: Any]] ?? [:]
        turns = VoiceTurns(server: j["voice_turns"])
        autosend = j["voice_autosend"] as? Bool ?? false
        tracker = TalkTurns(pause: ((j["pause_ms"] as? NSNumber)?.doubleValue ?? 1500) / 1000)
        turnHeard = false; pauseProgress = nil; bufferSince = Date()
        maxSeconds = (j["max_seconds"] as? NSNumber)?.intValue ?? 600
        if let used = (j["minutes_used"] as? NSNumber)?.doubleValue, let budget = (j["minutes_budget"] as? NSNumber)?.doubleValue {
            monthLeft = max(0, budget - used) // used already counts this session's whole cap
            TalkStatus.shared.update(used: used, budget: budget)
        }
        guard !ended else { await settle(sid, seconds: 0); return } // closed while it was starting

        let provider = j["provider"] as? String ?? ""
        var made: RealtimeLink?
        #if DEBUG
        if provider == "fake" { made = FakeGrokLink() }
        #endif
        if made == nil {
            guard provider != "fake", let s = j["url"] as? String, let url = URL(string: s) else { finish(problem: String(localized: "The voice service answered without a socket.", bundle: .l10n)); return }
            let secret = (j["token"] as? [String: Any])?["value"] as? String ?? ""
            made = WebSocketLink(url: url, protocols: j["protocols"] as? [String] ?? [], secret: secret)
        }
        guard let link = made else { return }
        self.link = link

        audio.useMic = provider != "fake" // the fake never asks for the microphone (no permission prompt in tests) nor plays
        audio.events = { [weak self] e in self?.audioEvent(e) }
        if audio.useMic, !resuming, !(await AVAudioApplication.requestRecordPermission()) {
            problem = String(localized: "Allow the microphone for Atteo in Settings to use voice chat. You can still read what Atteo says.", bundle: .l10n)
        }
        audio.onLevel = { [weak self] l in
            guard let self else { return }
            let on = self.handsFree ? !self.micMuted : self.holding
            self.level = on ? l : 0
            // As listen(): without echo cancelling the mic doesn't count while Atteo talks (that would be its own voice).
            if on, self.clientTurns, self.audio.echoCancelling || !self.speaking { self.heard(level: l) }
        }
        // The fake stays silent (its "voice" is only timed): a simulator under test can hang starting audio I/O.
        if audio.useMic {
            do { try audio.start() } catch { problem = String(localized: "Audio isn't working (\(error.localizedDescription)); captions still show.", bundle: .l10n) }
            if resuming { audio.resumed() }
        }

        // The first session's instructions, kept; a resumed one is told what was just said (a few short lines).
        if let i = session["instructions"] as? String {
            if instructions == nil { instructions = i }
            if resuming { session["instructions"] = (instructions ?? i) + TalkStandby.recap(recapTurns) }
        }
        self.session = session
        link.send(["type": "session.update", "session": session])
        openedAt = Date()
        lastActive = Date()
        elapsed = 0
        phase = .ready
        remote.nowPlaying(live: true, subtitle: subtitle)
        if handsFree { listen() }
        Haptics.play(.touch)
        reader = Task { [weak self] in
            for await e in link.events { self?.handle(e) }
            // Closed by us (standing by, or the end) isn't news; the service dropping it is.
            guard !Task.isCancelled, let self, self.link === link else { return }
            self.finish(problem: self.ended ? nil : String(localized: "The voice connection closed.", bundle: .l10n))
        }
    }

    /// Couldn't get a session: the call ends, unless it was resuming (then it keeps standing by, saying why).
    private func failed(_ why: String, resuming: Bool) {
        guard resuming, !ended else { finish(problem: why); return }
        standbyNote = why
        phase = .standby
        remote.nowPlaying(live: false, subtitle: subtitle)
        watchMessages()
    }

    private var subtitle: String {
        board.map { AppState.shared.displayName(for: $0) } ?? String(localized: "Voice chat", bundle: .l10n)
    }

    private func tick() {
        guard !ended, phase == .ready, let openedAt else { return }
        let now = Date()
        elapsed = now.timeIntervalSince(openedAt)
        let s = now < audioUntil
        if s != speaking { speaking = s }
        // The VAD heard something that never became a turn (a cough, a door): don't sit on "Thinking…".
        if thinking, activeResponse == nil, toolsRunning == 0, let t = stoppedAt, now.timeIntervalSince(t) > 8 { thinking = false; stoppedAt = nil }
        if elapsed >= Double(maxSeconds) {
            // A session's cap: hands-free stands by (play keeps talking, in a new session); hold to talk ends.
            if handsFree { standBy(note: String(localized: "That session reached its time limit. Tap or press play to keep talking.", bundle: .l10n)) }
            else { finish(problem: String(localized: "That's this session's time. Start another to keep talking.", bundle: .l10n)) }
            return
        }
        if clientTurns {
            pauseProgress = turns == .pause ? tracker.progress(now: now) : nil
            if turns == .pause, tracker.due(now: now) { endTurn() }
        } else if pauseProgress != nil { pauseProgress = nil }
        let a = activity
        if a.busy { lastActive = now }
        if TalkStandby.shouldStandBy(now: now, lastActive: lastActive, a) { standBy() }
    }

    private var activity: TalkStandby.Activity {
        TalkStandby.Activity(handsFree: handsFree, hearing: hearing || holding || turnHeard, speaking: speaking, thinking: thinking || activeResponse != nil,
                             toolsRunning: toolsRunning, confirmWaiting: confirm != nil)
    }

    /// Ends it: the socket closes, the audio stops, and the minutes not used go back to the month.
    func end() { finish(problem: nil) }

    private func finish(problem p: String?) {
        guard !ended else { return }
        ended = true
        if let p { problem = p }
        // A held auto-send never outlives the call (opus-b #2721): End, dismissing Talk and the app going to the
        // background all come here, and what was waiting is dropped unsent.
        if pendingSend?.sending != true { pendingTask?.cancel(); pendingTask = nil; pendingSend = nil }
        let (sid, seconds) = closeSession()
        ticker?.cancel()
        stopReading()
        watching = []
        fetchLater?.cancel()
        remote.off()
        audio.stop()
        audio.release() // standing by it kept the audio (for AirPods' play): let it go
        holding = false; speaking = false; thinking = false; hearing = false; level = 0; confirm = nil
        phase = .ended
        let before = settling
        Task {
            await before?.value
            await settle(sid, seconds: seconds)
            if let m = monthLeft {
                endNote = String(localized: "\(Self.clock(Int(liveSeconds.rounded(.up)))) used · \(Int(m)) min left this month", bundle: .l10n)
            }
        }
    }

    /// Closes the live session (the socket, the reader): answers its id and the whole seconds it was open, to settle.
    private func closeSession() -> (String?, Int) {
        generation += 1
        reader?.cancel(); reader = nil
        link?.close(); link = nil
        let sid = sessionId
        sessionId = nil
        let open = openedAt.map { Date().timeIntervalSince($0) } ?? 0
        if openedAt != nil { liveSeconds += open; elapsed = open }
        openedAt = nil
        return (sid, Int(open.rounded(.up)))
    }

    /// POST end {session_id, seconds}: the session's unused minutes go back to the month.
    private func settle(_ sid: String?, seconds: Int) async {
        guard let sid else { return }
        if let (code, j) = try? await TalkAPI.call("POST", endPath, body: ["session_id": sid, "seconds": seconds]), code == 200 {
            TalkStatus.shared.update(used: j["minutes_used"], budget: j["minutes_budget"])
            if let u = (j["minutes_used"] as? NSNumber)?.doubleValue, let b = (j["minutes_budget"] as? NSNumber)?.doubleValue {
                monthLeft = max(0, b - u)
            }
        }
    }

    // MARK: Standing by

    /// Quiet for a while (or pause on AirPods): the socket closes and the session settles now (xAI bills every minute
    /// it's open); the sheet stays with what was said, and new messages are read aloud until a tap or play.
    func standBy(note: String? = nil) {
        guard !ended, phase == .ready, handsFree else { return }
        if let r = activeResponse { flushGrok("grok-\(r)"); if let i = captions.lastIndex(where: { $0.id == "grok-\(r)" }) { captions[i].done = true } }
        if let y = youCaption, let i = captions.firstIndex(where: { $0.id == y }), captions[i].text == "…" { captions.remove(at: i) }
        let used = openedAt.map { Date().timeIntervalSince($0) } ?? 0
        if let m = monthLeft { monthLeft = m + max(0, Double(maxSeconds) - used) / 60 } // what settling gives back, until it says
        let (sid, seconds) = closeSession()
        settling = Task { [weak self] in await self?.settle(sid, seconds: seconds) }
        if audio.useMic { audio.standBy() } else { audio.stopCapture() }
        resetTurn()
        confirm = nil // it was waiting for a yes: nothing was done, and the new session can ask again
        standbyNote = note
        phase = .standby
        remote.nowPlaying(live: false, subtitle: subtitle)
        Haptics.play(.touch)
        watchMessages()
    }

    /// A tap or play: a fresh session (after the last one has settled), listening again, told the last few turns.
    func resume() {
        guard !ended, phase == .standby else { return }
        stopReading()
        watching = []
        fetchLater?.cancel()
        standbyNote = nil
        micMuted = false // play means "I want to talk"
        phase = .connecting
        Haptics.play(.touch)
        let before = settling
        Task { [weak self] in
            await before?.value
            guard let self, !self.ended, self.phase == .connecting else { return }
            await self.connect(resuming: true)
        }
    }

    /// AirPods, headphones, the lock screen or Control Center.
    private func remoteCommand(_ c: TalkStandby.Command) {
        let state: TalkStandby.State = switch phase {
        case .connecting: .connecting
        case .ready: .live
        case .standby: .standby
        case .ended: .ended
        }
        // One AirPods press can arrive twice during a live call (the mute gesture and a play/pause): act on the first.
        guard Date().timeIntervalSince(lastRemote) > 1 else { return }
        switch TalkStandby.action(c, state, handsFree: handsFree, endsTurn: clientTurns && turns == .tap && tracker.heard) {
        case .standBy: lastRemote = Date(); standBy()
        case .resume: lastRemote = Date(); resume()
        case .endTurn: lastRemote = Date(); endTurn()
        case .none: break
        }
    }

    private var lastRemote = Date.distantPast

    /// A new session starts clean: no answer, voice, turn or tool in flight from the last one.
    private func resetTurn() {
        activeResponse = nil; cancelled = []; wantResponse = false; toolsRunning = 0
        audioUntil = .distantPast; audioItem = nil; itemAudio = 0; stoppedAt = nil; youCaption = nil; grokPending = [:]
        holding = false; speaking = false; thinking = false; hearing = false; level = 0
        tracker.reset(); turnHeard = false; pauseProgress = nil
        elapsed = 0
    }

    /// The turns the next session is told: your words, Atteo's, and what was read aloud (only everyone's messages).
    private var recapTurns: [(who: String, text: String)] { Self.recapTurns(captions) }

    static func recapTurns(_ captions: [Caption]) -> [(who: String, text: String)] {
        captions.compactMap { c in
            switch c.who {
            case .you: return c.done ? ("The user", c.text) : nil
            case .grok: return ("You (Atteo)", c.text)
            case .heard: return c.isPrivate ? nil : ("Read aloud to the user while paused", c.text) // private: never to the model
            case .note: return nil
            }
        }
    }

    // MARK: New messages while standing by

    /// The call's board (the chat under the sheet keeps its live socket, so its messages arrive in AppState), or for
    /// Ask, what's for you (the app's live feed refreshes it): what's newer than now gets read.
    private func watchMessages() {
        guard phase == .standby, watching.isEmpty else { return }
        let st = AppState.shared
        if let b = board {
            seenSeq = max(seenSeq, (st.entries[b.id] ?? []).map(\.seq).max() ?? 0)
            st.$entries.map { $0[b.id] ?? [] }.removeDuplicates().dropFirst()
                .sink { [weak self] list in self?.arrived(list, on: b) }.store(in: &watching)
            // Just in case nothing has the chat open: the feed's pulse for this board fetches it (when no update came).
            st.$pulse.compactMap { $0 }.filter { $0.board == b.id }
                .sink { [weak self] _ in self?.fetchSoon(b) }.store(in: &watching)
        } else {
            seenInbox = max(seenInbox, st.inbox.map(\.id).max() ?? 0)
            st.$inbox.dropFirst().sink { [weak self] items in self?.arrived(items) }.store(in: &watching)
        }
    }

    private func fetchSoon(_ b: Board) {
        let seen = seenSeq
        fetchLater?.cancel()
        fetchLater = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard let self, !Task.isCancelled, self.phase == .standby, self.seenSeq == seen else { return }
            await AppState.shared.loadEntries(b)
        }
    }

    private func arrived(_ list: [Entry], on b: Board) {
        guard phase == .standby else { return }
        let me = AppState.shared.me?.owner ?? ""
        let fresh = list.filter { $0.seq > seenSeq && $0.pending != true }.sorted { $0.seq < $1.seq }
        guard let top = fresh.last?.seq else { return }
        seenSeq = top
        let mine = Set(list.filter { $0.author.lowercased() == me.lowercased() && $0.via != "agent" }.map(\.seq))
        for e in fresh where TalkStandby.worthReading(e, me: me, agentChat: b.isAgentChat, parentIsMine: { mine.contains($0) }) {
            let who = e.byAgent ? agentLabel(AppState.shared.displayName(for: e.author), e.agentName ?? AppState.shared.agentNames[b.id]?[e.author]?.name) : AppState.shared.displayName(for: e.author)
            toRead.append(Heard(board: b.id, seq: e.seq, who: who, text: e.text, encrypted: b.encrypted == true, isPrivate: e.audience != nil))
        }
        readNext()
    }

    private func arrived(_ items: [InboxItem]) {
        guard phase == .standby else { return }
        let fresh = items.filter { $0.id > seenInbox && $0.readAt == nil }.sorted { $0.id < $1.id }
        guard let top = fresh.last?.id else { return }
        seenInbox = top
        let me = (AppState.shared.me?.owner ?? "").lowercased()
        for i in fresh where i.seq > 0 && !(i.actor.lowercased() == me && i.actorVia != "agent") {
            let encrypted = AppState.shared.boards.first { $0.id == i.boardId }?.encrypted == true
            toRead.append(Heard(board: i.boardId, seq: i.seq, who: AppState.shared.displayName(for: i.actor, agent: i.actorVia == "agent"), text: i.excerpt, encrypted: encrypted, isPrivate: true)) // For you doesn't say if it was private: never recapped
        }
        readNext()
    }

    /// One at a time: the caption, then the server's voice reading exactly that message ("theo: …"), in the person's
    /// saved voice and against their read-aloud allowance. Encrypted boards (the server can't read them) and a used-up
    /// allowance: the caption only.
    private func readNext() {
        guard readingTask == nil, phase == .standby, !toRead.isEmpty else { return }
        let h = toRead.removeFirst()
        captions.append(Caption(id: "heard-\(h.board)-\(h.seq)", who: .heard, text: "\(h.who): \(String(h.text.prefix(400)))", done: true, isPrivate: h.isPrivate))
        readingTask = Task { [weak self] in
            await self?.read(h)
            guard let self, !Task.isCancelled else { return }
            self.readingTask = nil
            self.readNext()
        }
    }

    private func read(_ h: Heard) async {
        guard !ttsOut, !h.encrypted else { return }
        reading = true
        defer { reading = false }
        guard let (code, data, resp) = try? await TalkAPI.raw("POST", "/api/app/tts", body: ["board": h.board, "seq": h.seq, "from": true]),
              !Task.isCancelled, phase == .standby else { return }
        if code == 429, resp?.value(forHTTPHeaderField: "retry-after") == nil {
            // The month's read-aloud is used up (the per-minute limit says when to retry instead): stop asking.
            ttsOut = true
            standbyNote = String(localized: "This month's read-aloud is used up: new messages show here instead.", bundle: .l10n)
            return
        }
        guard code == 200 else { return } // not set up, a moment's limit, the service down: the caption is there
        if !audio.useMic { try? await Task.sleep(nanoseconds: 500_000_000); return } // the fake: timed, never played
        guard let p = try? AVAudioPlayer(data: data) else { return }
        let done = PlayerDone { [weak self] in self?.playerFinished() }
        p.delegate = done
        p.volume = muted ? 0 : 1
        playerDelegate = done
        player = p
        guard p.play() else { player = nil; return }
        await withCheckedContinuation { c in playerDone = c }
    }

    private func playerFinished() {
        player = nil; playerDelegate = nil
        playerDone?.resume(); playerDone = nil
    }

    private func stopReading() {
        toRead = []
        readingTask?.cancel(); readingTask = nil
        player?.stop()
        playerFinished()
        reading = false
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
        lastActive = Date() // back to hands-free: quiet from now, not from before
        if phase == .standby, !on { resume(); return } // hold to talk never stands by: a session for the presses
        guard phase == .ready, !session.isEmpty else { return }
        audio.stopCapture()
        link?.send(["type": "input_audio_buffer.clear"])
        var s = session
        s["turn_detection"] = on && turns == .quick ? ["type": "server_vad"] : NSNull()
        session = s
        tracker.reset(); turnHeard = false; pauseProgress = nil; bufferSince = Date()
        link?.send(["type": "session.update", "session": s])
        if on { listen() }
        Haptics.play(.touch)
    }

    /// Mic off: nothing more goes to Atteo (it can still finish talking); on again: it listens.
    func toggleMic() {
        micMuted.toggle()
        lastActive = Date() // a touch: the quiet clock starts over
        Haptics.play(.touch)
        if micMuted {
            level = 0
            hearing = false
            tracker.reset(); turnHeard = false; pauseProgress = nil
            if phase == .ready { link?.send(["type": "input_audio_buffer.clear"]) } // no half-heard turn left behind
        }
    }

    /// The orb, hands-free: while Atteo talks, a tap stops it. (DEBUG's fake: a tap is the person saying the next line.)
    func orbTapped() {
        guard phase == .ready else { return }
        #if DEBUG
        if let fake = link as? FakeGrokLink {
            guard !micMuted else { return }
            if clientTurns { fakeSpoke() } else { fake.personSpeaks() }
            return
        }
        #endif
        if speaking || activeResponse != nil { interrupt() }
    }

    // MARK: When Atteo answers (pause, tap)

    /// Hands-free with the turns ours (pause, tap): the session has no server VAD.
    var clientTurns: Bool { handsFree && turns != .quick && phase == .ready }

    /// A mic level, in pause or tap: you started (barge in if Atteo is talking, as the server's VAD does), went quiet,
    /// or talk again. Until you say something the buffer is cleared every few seconds, so a turn doesn't carry silence.
    private func heard(level l: Float) {
        let now = Date()
        switch tracker.feed(l, atteoTalking: speaking || activeResponse != nil, now: now) {
        case .started:
            youStarted()
            hearing = true
            stoppedAt = nil
            lastActive = now
            if speaking || activeResponse != nil { interrupt() }
            if youCaption == nil { let id = "you-\(UUID().uuidString)"; youCaption = id; captions.append(Caption(id: id, who: .you, text: "…")) }
        case .again: hearing = true; lastActive = now
        case .quiet: hearing = false
        case .none: break
        }
        if turnHeard != tracker.heard { turnHeard = tracker.heard }
        if !tracker.heard, now.timeIntervalSince(bufferSince) > 5 {
            bufferSince = now
            link?.send(["type": "input_audio_buffer.clear"])
        }
    }

    /// The end of your turn in pause or tap (the pause ran out, Done, or AirPods): what you said goes, Atteo answers.
    func endTurn() {
        guard clientTurns, tracker.heard else { return }
        tracker.reset(); turnHeard = false; pauseProgress = nil; hearing = false
        bufferSince = Date()
        lastActive = Date()
        link?.send(["type": "input_audio_buffer.commit"])
        if youCaption == nil { let id = "you-\(UUID().uuidString)"; youCaption = id; captions.append(Caption(id: id, who: .you, text: "…")) }
        thinking = true
        stoppedAt = Date()
        Haptics.play(.touch)
        requestResponse()
    }

    /// When Atteo answers, switched during the call (the chip): saved as the person's choice, and the live session
    /// changes at once (session.update with the matching turn detection).
    func setTurns(_ t: VoiceTurns) {
        guard t != turns else { return }
        requestedTurns = t
        var d = AppState.shared.display
        d.voiceTurns = t.rawValue
        AppState.shared.setDisplay(d)
        turns = t
        tracker.reset(); turnHeard = false; pauseProgress = nil; hearing = false
        bufferSince = Date()
        lastActive = Date()
        Haptics.play(.touch)
        guard phase == .ready, handsFree, !session.isEmpty else { return }
        link?.send(["type": "input_audio_buffer.clear"])
        var s = session
        s["turn_detection"] = t == .quick ? ["type": "server_vad"] : NSNull()
        session = s
        link?.send(["type": "session.update", "session": s])
    }

    #if DEBUG
    /// The fake voice has no microphone: a tap on the orb is the person saying a line and stopping (a breath of
    /// silence in the buffer, so the commit has something). pause then waits its pause; tap waits for Done.
    private func fakeSpoke() {
        youStarted()
        if speaking || activeResponse != nil { interrupt() }
        link?.send(["type": "input_audio_buffer.append", "audio": Data(count: 4800).base64EncodedString()])
        tracker.spoke()
        turnHeard = true
        lastActive = Date()
        if youCaption == nil { let id = "you-\(UUID().uuidString)"; youCaption = id; captions.append(Caption(id: id, who: .you, text: "…")) }
    }
    #endif

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
        if let r = activeResponse { flushGrok("grok-\(r)") } // what was already said, up to where it stopped
        let wasSpeaking = speaking || activeResponse.map { r in captions.last?.id == "grok-\(r)" } == true
        let left = max(0, audioUntil.timeIntervalSinceNow)
        audio.stopPlayback()
        audioUntil = .distantPast
        if let e = atteoEnd, e > Date() { atteoEnd = Date() } // its voice stops now
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
        toolsRunning += 1 // until Atteo has heard what happened: no standing by in between
        let gen = generation
        Task {
            let said: String
            switch c.kind {
            case .approval(let id, let decision):
                if yes {
                    let out = await runRoute("answer_approval", ["approval_id": id, "decision": decision])
                    said = "I tapped Yes on the screen, so the app did it: \(decision) \(id). Result: \(out)"
                } else {
                    said = "I tapped No on the screen: don't \(decision) it."
                }
            case .post(let text, let board):
                if yes {
                    let out = await runRoute("post_to_my_agent", Self.postArgs(text, board))
                    said = "I tapped Yes on the screen, so the app sent it to my agent, word for word: \"\(text)\". Result: \(out)"
                } else {
                    said = "I tapped No on the screen: don't send that to my agent."
                }
            }
            guard gen == generation else { return }
            toolsRunning -= 1
            guard !ended else { return }
            link?.send(["type": "conversation.item.create", "item": ["type": "message", "role": "user", "content": [["type": "input_text", "text": said]]]])
            requestResponse()
        }
    }

    /// A clear yes to this decision: short and unqualified (TalkYes). "approve it" counts only for an approve, "deny it"
    /// only for a deny; "yes, but first…", "wait", a question, or anything long is not a yes.
    static func saysYes(_ s: String, to decision: String) -> Bool { TalkYes.saysYes(s, to: decision) }

    /// A no, or the opposite decision ("deny it" while an approve waits).
    static func saysNo(_ s: String, to decision: String) -> Bool { TalkYes.saysNo(s, to: decision) }

    /// post_to_my_agent's arguments for exactly this text and board.
    static func postArgs(_ text: String, _ board: String?) -> [String: Any] {
        var a: [String: Any] = ["text": text]
        if let board { a["board"] = board }
        return a
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
            if lastYou != nil, lastYou?.response == nil { lastYou?.response = activeResponse } // Atteo's answer to it
        case "response.output_audio.delta", "response.audio.delta":
            guard let b64 = e["delta"] as? String, let pcm = Data(base64Encoded: b64) else { return }
            let d = audio.play(pcm)
            audioUntil = max(audioUntil, Date()) + d
            atteoEnd = audioUntil
            if !speaking { speaking = true }
            if let item = e["item_id"] as? String {
                if item != audioItem { audioItem = item; itemAudio = 0 }
                itemAudio += d
            }
        case "input_audio_buffer.speech_started":
            youStarted()
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
            if youCaption == nil { youSaid() } // a place for the final words, in order; the words themselves wait
        case "conversation.item.input_audio_transcription.completed":
            youSaid(final: e["transcript"] as? String ?? "")
        case "response.function_call_arguments.done":
            call(name: e["name"] as? String, id: e["call_id"] as? String, arguments: e["arguments"])
        case "response.output_item.done":
            if let item = e["item"] as? [String: Any], item["type"] as? String == "function_call" {
                call(name: item["name"] as? String, id: item["call_id"] as? String, arguments: item["arguments"])
            }
        case "response.done":
            if let mine = lastYou?.response, mine == (rid ?? activeResponse) { lastYou = nil } // that answer is over: stale now
            if let r = rid ?? activeResponse {
                flushGrok("grok-\(r)")
                if let i = captions.lastIndex(where: { $0.id == "grok-\(r)" }) { captions[i].done = true }
            }
            if let rid { cancelled.remove(rid) }
            activeResponse = nil
            thinking = toolsRunning > 0
            if let y = youCaption, let i = captions.firstIndex(where: { $0.id == y }), captions[i].text == "…" { captions[i].text = String(localized: "(spoke)", bundle: .l10n); youCaption = nil }
            if wantResponse { wantResponse = false; link?.send(["type": "response.create"]) }
        case "error":
            let m = (e["error"] as? [String: Any])?["message"] as? String ?? String(localized: "Grok had a problem.", bundle: .l10n)
            // Cancelling with nothing to cancel is harmless; anything else is worth a line.
            if !m.lowercased().contains("cancel"), !m.lowercased().contains("truncat") { captions.append(Caption(id: "err-\(UUID().uuidString)", who: .note, text: m, done: true)) }
        default: break
        }
    }

    /// Atteo's caption grows a finished sentence at a time (#1796), not a word at a time: the rest waits in grokPending
    /// until its sentence ends, the reply ends, or it's interrupted. The final transcript replaces it all.
    private func grokSays(_ rid: String?, append: String? = nil, replace: String? = nil) {
        let id = "grok-\(rid ?? activeResponse ?? "x")"
        if let replace {
            grokPending[id] = nil
            setGrok(id, replace, append: false)
        } else if let append {
            let (done, rest) = Self.sentences((grokPending[id] ?? "") + append)
            grokPending[id] = rest
            if !done.isEmpty { setGrok(id, done, append: true) }
        }
    }

    private func flushGrok(_ id: String) {
        guard let rest = grokPending.removeValue(forKey: id), !rest.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        setGrok(id, rest, append: true)
    }

    private func setGrok(_ id: String, _ text: String, append: Bool) {
        if let i = captions.lastIndex(where: { $0.id == id }) {
            captions[i].text = append ? captions[i].text + text : text
        } else {
            captions.append(Caption(id: id, who: .grok, text: append ? text.trimmingCharacters(in: .whitespaces) : text))
        }
    }

    /// Splits after the last finished sentence: ".", "!", "?" or "…" then a space, or a CJK full stop anywhere.
    static func sentences(_ s: String) -> (done: String, rest: String) {
        var cut: String.Index?
        var i = s.startIndex
        while i < s.endIndex {
            let c = s[i], next = s.index(after: i)
            if "。！？".contains(c) || c == "\n" || (".!?…".contains(c) && next < s.endIndex && s[next].isWhitespace) { cut = next }
            i = next
        }
        guard let cut else { return ("", s) }
        return (String(s[..<cut]), String(s[cut...]))
    }

    /// Your words aren't shown as they're heard (#1796): the sheet says "Listening…" with your level, and the caption
    /// gets the final transcript once.
    private func youSaid(final: String? = nil) {
        if youCaption == nil { let id = "you-\(UUID().uuidString)"; youCaption = id; captions.append(Caption(id: id, who: .you, text: "…")) }
        guard let y = youCaption, let i = captions.firstIndex(where: { $0.id == y }) else { return }
        if let final {
            if !final.isEmpty { captions[i].text = final }
            captions[i].done = true
            youCaption = nil
            heard(final)
            // The yes (or no) an approval or a post is waiting on. Neither (a hedge, a question): it keeps waiting.
            if let c = confirm {
                switch TalkYes.verdict(final, to: c.decision) {
                case .yes: confirm?.confirmed = true
                case .no: confirm = nil
                case .unclear: break
                }
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
        let note = Caption(id: "tool-\(id)", who: .note, text: Self.doing(name, args, confirmed: confirm?.confirmed == true))
        captions.append(note)
        let gen = generation
        let you = lastYou // as it is now: its response may finish (and drop it) before the task runs
        Task {
            let output = await runTool(name, args, you: you)
            if let i = captions.firstIndex(where: { $0.id == note.id }) { captions[i].done = true }
            guard gen == generation else { return } // its session stood by or ended meanwhile
            toolsRunning -= 1
            guard !ended else { return }
            link?.send(["type": "conversation.item.create", "item": ["type": "function_call_output", "call_id": id, "output": output]])
            requestResponse()
        }
    }

    static func doing(_ name: String, _ a: [String: Any], confirmed: Bool = false) -> String {
        switch name {
        case "post_to_my_agent":
            return confirmed ? String(localized: "Telling your agent", bundle: .l10n) : String(localized: "Post to your agent — waiting for your yes", bundle: .l10n)
        case "read_board": return String(localized: "Reading the board", bundle: .l10n)
        case "mailbox_summary": return String(localized: "Checking what's waiting for you", bundle: .l10n)
        case "recap": return String(localized: "Catching up on the board", bundle: .l10n)
        case "answer_approval":
            return a["decision"] as? String == "deny" ? String(localized: "Deny — waiting for your yes", bundle: .l10n) : String(localized: "Approve — waiting for your yes", bundle: .l10n)
        case "list_boards": return String(localized: "Looking at your boards", bundle: .l10n)
        default: return name
        }
    }

    /// answer_approval and post_to_my_agent ask first: a second call after a yes for exactly the same thing runs it;
    /// anything else (a first call, other words, another board) asks again. Text on a board can't post by itself (#1761).
    private func runTool(_ name: String, _ a: [String: Any], you: LastYou? = nil) async -> String {
        switch name {
        case "answer_approval":
            let id = a["approval_id"] as? String ?? "", decision = a["decision"] as? String ?? ""
            guard id.hasPrefix("ap_"), decision == "approve" || decision == "deny" else { return Self.json(["error": "Send approval_id (ap_…) and decision (approve or deny)."]) }
            let kind = Confirm.Kind.approval(id: id, decision: decision)
            if let c = confirm, c.kind == kind, c.confirmed {
                confirm = nil
                return await runRoute(name, ["approval_id": id, "decision": decision])
            }
            confirm = Confirm(kind: kind)
            Haptics.play(.warning)
            return Self.json(["done": false, "needs_confirmation": true,
                              "message": "Nothing was done yet. Say exactly what \(decision == "deny" ? "denying" : "approving") \(id) will do and ask for a clear yes. The app runs it only after the person says yes (or taps Yes); after a spoken yes, call answer_approval again."])
        case "post_to_my_agent":
            let text = (a["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return Self.json(["error": "Nothing to send."]) }
            let target = (a["board"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            if let t = target, AppState.shared.boards.first(where: { $0.id == t })?.encrypted == true {
                return Self.json(["error": "That board is end-to-end encrypted: voice can't read or post there. Open it in the app."])
            }
            let kind = Confirm.Kind.post(text: text, board: target)
            if let c = confirm, c.kind == kind, c.confirmed {
                confirm = nil
                return await runRoute(name, Self.postArgs(text, target)) // exactly what was read back and confirmed
            }
            // Your own dictated words (display.voice_autosend): held 5 s with Undo, then sent; anything else asks below.
            if autosend, confirm == nil, pendingSend == nil, let you, let words = await autosendWords(text, board: target, you: you) {
                return hold(words, board: target)
            }
            confirm = Confirm(kind: kind)
            Haptics.play(.warning)
            return Self.json(["done": false, "needs_confirmation": true,
                              "message": "Nothing was sent yet. Read the message back word for word (\"Post to your agent: '…'?\") and ask for a clear yes. The app sends it only after the person says yes or taps Yes; after a spoken yes, call post_to_my_agent again with the same text."])
        default:
            return await runRoute(name, a)
        }
    }

    // MARK: Auto-send (vedu #2638, jxn's agent #2644)
    //
    // With display.voice_autosend on, a post_to_my_agent that is your own last transcript (the mic's words, never Atteo's
    // rewording) goes without a yes: held 5 s with Undo, then sent, word for word from the transcript. The server decides
    // (POST /api/app/voice/autosend, voiceAutosend.ts); the app adds when your speech began relative to Atteo's voice,
    // since on the loudspeaker a hostile message read aloud can come back as "you". Anything it refuses asks as before.

    /// This turn's speech began now: how long after Atteo's voice stopped (negative while it's still playing).
    private func youStarted() {
        youStartedSeen = true
        youStartedAfter = atteoEnd.map { Date().timeIntervalSince($0) * 1000 }
    }

    /// A final transcript: remembered once, with its start; one that had no speech start of its own counts as heard
    /// over Atteo (it asks).
    private func heard(_ transcript: String) {
        let t = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        lastYou = t.isEmpty ? nil : LastYou(text: t, afterMs: youStartedSeen ? youStartedAfter : -1)
        youStartedSeen = false
    }

    /// The exact words to send, when the server says this post is your own (else nil: ask).
    private func autosendWords(_ text: String, board target: String?, you: LastYou) async -> String? {
        let body: [String: Any] = [
            "transcript": you.text, "text": text,
            "board": target ?? NSNull(), "call_board": board?.id ?? NSNull(),
            "spoke_after_ms": you.afterMs ?? NSNull(),
        ]
        guard let (code, j) = try? await TalkAPI.call("POST", "/api/app/voice/autosend", body: body), code == 200,
              j["auto"] as? Bool == true, let words = j["text"] as? String, !words.isEmpty else { return nil }
        return words
    }

    /// Holds your words for 5 s on the sheet (Undo), then sends them. Grok hears it's scheduled, not to ask.
    private func hold(_ words: String, board target: String?) -> String {
        lastYou = nil // one transcript sends once
        let p = PendingSend(id: UUID(), text: words, secondsLeft: 5)
        pendingSend = p
        Haptics.play(.touch)
        let gen = generation
        pendingTask = Task { [weak self] in
            for left in stride(from: 4, through: 0, by: -1) {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self, !Task.isCancelled, self.pendingSend?.id == p.id else { return }
                if left > 0 { self.pendingSend?.secondsLeft = left }
            }
            guard let self, !Task.isCancelled, !self.ended, self.pendingSend?.id == p.id else { return }
            self.pendingSend?.sending = true
            let out = await self.runRoute("post_to_my_agent", Self.postArgs(words, target))
            guard self.pendingSend?.id == p.id else { return }
            self.pendingSend = nil
            Haptics.play(.approved)
            guard gen == self.generation, !self.ended else { return }
            self.link?.send(["type": "conversation.item.create", "item": ["type": "message", "role": "user", "content": [["type": "input_text", "text": "The app sent my words to my agent, word for word: \"\(words)\". Result: \(out)"]]]])
        }
        return Self.json(["done": false, "scheduled": true, "undo_ms": 5000, "text": words,
                          "message": "Not sent yet: the app sends these exact words in 5 seconds unless the person taps Undo. Say in a few words that it's on its way. Don't ask for a yes, and don't call post_to_my_agent again for it."])
    }

    /// Undo on the sheet: nothing is sent, and Atteo hears so.
    func undoPending() {
        guard let p = pendingSend, !p.sending else { return }
        pendingTask?.cancel(); pendingTask = nil
        pendingSend = nil
        Haptics.play(.denied)
        guard !ended else { return }
        link?.send(["type": "conversation.item.create", "item": ["type": "message", "role": "user", "content": [["type": "input_text", "text": "I tapped Undo: don't send it to my agent."]]]])
        requestResponse()
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
                return Self.trim(Self.mailForModel(try await getRaw("/api/mailbox?peek=1")))
            case "read_board":
                guard let b = boardArg() else { return Self.json(["error": "Which board? Call list_boards."]) }
                if encrypted(b) { return locked }
                var since = (a["since"] as? NSNumber)?.intValue
                if since == nil {
                    let count = (try await getJSON("/api/me/boards")["boards"] as? [[String: Any]] ?? []).first { $0["id"] as? String == b }?["entry_count"] as? Int ?? 0
                    since = max(0, count - 30)
                }
                let j = try await getJSON("/api/boards/\(b)/entries?after=\(since ?? 0)&limit=30")
                return Self.json(["board": b, "entries": Self.entriesForModel(j["entries"] as? [[String: Any]] ?? [])])
            case "recap":
                // Everyone's messages only already: the server's recap is built from the board's summary (which never
                // holds a people-only or Just mine message) and filters decisions and files to audience IS NULL.
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

    // MARK: Private messages never reach the voice model (#2094/#2095)

    /// read_board's entries for the model. The voice model is an agent (xAI's), so "People only" and "Just mine"
    /// messages (any entry with an `audience`), which the person's own token can read, are left out without a word.
    static func entriesForModel(_ entries: [[String: Any]]) -> [[String: Any]] {
        entries.filter { Self.isEveryones($0) }.map { e in
            ["seq": e["seq"] ?? 0, "author": e["author"] ?? "", "via": e["via"] ?? "", "type": e["type"] ?? "", "text": String((e["text"] as? String ?? "").prefix(500))] as [String: Any]
        }
    }

    /// GET /api/mailbox for the model: the same JSON without any private item (Just mine mail carries audience "own").
    /// Anything that isn't the expected shape goes as nothing rather than as it came.
    static func mailForModel(_ d: Data) -> Data {
        guard var j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return Data("{}".utf8) }
        if let mail = j["mail"] as? [[String: Any]] { j["mail"] = mail.filter { Self.isEveryones($0) } }
        return (try? JSONSerialization.data(withJSONObject: j)) ?? Data("{}".utf8)
    }

    /// No audience (or a null one): a message everyone on the board can see.
    private static func isEveryones(_ o: [String: Any]) -> Bool { o["audience"] == nil || o["audience"] is NSNull }

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

    private static var pausedNote: String { String(localized: "Paused: another app or a call took the audio. Voice chat picks up when it's done.", bundle: .l10n) }

    private func audioEvent(_ e: TalkAudio.Event) {
        switch e {
        case .interrupted:
            holdEnded()
            audioUntil = .distantPast
            speaking = false
            hearing = false; level = 0
            problem = Self.pausedNote
        case .resumed:
            if problem == Self.pausedNote { problem = nil }
        case .failed(let m):
            problem = String(localized: "Audio isn't working (\(m)); captions still show.", bundle: .l10n)
        }
    }
}

/// AVAudioPlayer's "finished", as a closure (a message read aloud while standing by).
private final class PlayerDone: NSObject, AVAudioPlayerDelegate {
    let done: @MainActor () -> Void
    init(_ done: @escaping @MainActor () -> Void) { self.done = done }
    func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully: Bool) { Task { @MainActor in self.done() } }
    func audioPlayerDecodeErrorDidOccur(_ p: AVAudioPlayer, error: Error?) { Task { @MainActor in self.done() } }
}
