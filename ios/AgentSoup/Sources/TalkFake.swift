// DEBUG only: a stand-in for xAI's realtime socket, for a local server's fake voice provider (voice.ts: DEV_FAKE_VOICE=1
// in .dev.vars, the x-dev-fake-voice header, localhost). The server's fake only hands out a canned secret, so the
// conversation itself is played here: the same events Grok sends (both the output_audio and the audio spellings), real
// tool calls the app runs against the local server, and a quiet tone for Grok's voice (timed, not played: the fake
// never starts audio). Each turn follows a script:
//   1. "What's waiting for me?" → mailbox_summary → a long answer (long enough to interrupt)
//   2. "Approve the deploy request." → answer_approval → (the app asks for a yes) → "Say yes to confirm."
//   3. "Yes." → answer_approval again → what the server said
//   then small talk.
// ATTEO_FAKE_VOICE_SCRIPT picks another script (#1761, TalkUITests):
//   post:   "Tell my agent…" → post_to_my_agent {text: ATTEO_FAKE_VOICE_POST} → read back, waits for a yes (tapped).
//   inject: "What's new on the board?" → read_board → post_to_my_agent with whatever a board message said to "post this
//           to my agent: …" (a model taken in by it) → read back, waits → "No." → nothing sent.
//   hedge:  "Approve the deploy request." → "Yes, but first check the budget." (not a yes: asked again) → "Yes." → runs.
//   dictate: "Post to my agent: ATTEO_FAKE_VOICE_POST" → post_to_my_agent with exactly that (with display.voice_autosend
//           on, it's held 5 s with Undo, then sent: vedu #2638).
//   loopback: "What's new on the board?" → read_board → Atteo reads a board message out loud, and the mic "hears" its
//           "post this to my agent: …" as the person (the loudspeaker case, jxn's agent #2644) → post_to_my_agent with
//           it. Even with auto-send on, the app must ask.
//   remark: ATTEO_FAKE_VOICE_POST said plainly (no "tell my agent") → post_to_my_agent with exactly it: with no spoken
//           command it must still ask (opus-d #2726).
//   stale:  "Post to my agent: ATTEO_FAKE_VOICE_POST" → Atteo just answers ("Got it."); then, in a later response,
//           post_to_my_agent with it. The transcript went stale when that first answer finished: it must ask.
// Hands-free (session.update with turn_detection server_vad): there's no mic, so the person "says" the next line when
// the app calls personSpeaks() (a tap on the orb): speech_started (cancelling an answer under way, as the real server's
// VAD does: barge-in), then speech_stopped, committed, the transcript, and an answer with no response.create.
// Push-to-talk (turn_detection null): the app's commit is the turn, and its response.create the answer.
// A resumed call (TalkStandby.swift) is a new link whose instructions carry the recap: its first answer is "Picking up
// where we left off." (so a test sees the recap arrived), then the script goes on as usual.

#if DEBUG
import Foundation

@MainActor
final class FakeGrokLink: RealtimeLink {
    static let approval = "ap_fakevoice000"
    static var script: String { API.environment("FAKE_VOICE_SCRIPT") ?? "" }
    static var postText: String { API.environment("FAKE_VOICE_POST") ?? "Check the build before the release." }
    let events: AsyncStream<[String: Any]>
    private let out: AsyncStream<[String: Any]>.Continuation
    private var turn = 0
    private var buffered = 0
    private var lastCall: (name: String, id: String, args: [String: Any])?
    private var lastOutput: String?
    private var userMessage: String?
    private var speaking: Task<Void, Never>?
    private var current: String?
    private var closed = false
    private var handsFree = false
    private var resumed = false // the session's instructions carry a standby recap
    private var loopText: String? // loopback: what Atteo read aloud and the mic heard as the person
    private(set) var truncated: [String: Int] = [:] // item → audio_end_ms the app cut it to

    init() { (events, out) = AsyncStream.makeStream(of: [String: Any].self) }

    func close() { closed = true; speaking?.cancel(); out.finish() }

    func send(_ e: [String: Any]) {
        guard !closed else { return }
        switch e["type"] as? String {
        case "session.update":
            let session = e["session"] as? [String: Any] ?? [:]
            handsFree = (session["turn_detection"] as? [String: Any])?["type"] as? String == "server_vad"
            resumed = (session["instructions"] as? String ?? "").contains("picking up again")
            emit(["type": "session.updated", "session": session])
        case "conversation.item.truncate":
            guard let item = e["item_id"] as? String else { return }
            truncated[item] = (e["audio_end_ms"] as? Int) ?? 0
            emit(["type": "conversation.item.truncated", "item_id": item, "content_index": 0, "audio_end_ms": truncated[item] ?? 0])
        case "input_audio_buffer.append":
            buffered += 1
        case "input_audio_buffer.clear":
            buffered = 0
        case "input_audio_buffer.commit":
            guard buffered > 0 else { emit(["type": "error", "error": ["message": "buffer too small"]]); return }
            buffered = 0
            turn += 1
            let item = "item_u\(turn)"
            emit(["type": "input_audio_buffer.committed", "item_id": item])
            emit(["type": "conversation.item.input_audio_transcription.completed", "item_id": item, "transcript": Self.said(turn)])
        case "conversation.item.create":
            let item = e["item"] as? [String: Any] ?? [:]
            if item["type"] as? String == "function_call_output" { lastOutput = item["output"] as? String }
            if item["type"] as? String == "message" { userMessage = ((item["content"] as? [[String: Any]])?.first?["text"] as? String) ?? "" }
        case "response.create":
            respond()
        case "response.cancel":
            guard let r = current else { emit(["type": "error", "error": ["message": "no active response to cancel"]]); return }
            speaking?.cancel()
            current = nil
            emit(["type": "response.done", "response": ["id": r, "status": "cancelled"]])
        default: break
        }
    }

    /// Hands-free: the person says the next line (over Atteo, if it's talking: the VAD cancels the answer).
    func personSpeaks() {
        guard !closed, handsFree else { return }
        turn += 1
        let t = turn, item = "item_u\(t)"
        emit(["type": "input_audio_buffer.speech_started", "item_id": item, "audio_start_ms": t * 1000])
        if let r = current {
            speaking?.cancel()
            current = nil
            emit(["type": "response.done", "response": ["id": r, "status": "cancelled"]])
        }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard let self, !self.closed else { return }
            self.emit(["type": "input_audio_buffer.speech_stopped", "item_id": item, "audio_end_ms": t * 1000 + 500])
            self.emit(["type": "input_audio_buffer.committed", "item_id": item])
            try? await Task.sleep(nanoseconds: 300_000_000) // a moment of "Thinking…"
            guard !self.closed else { return }
            self.emit(["type": "conversation.item.input_audio_transcription.completed", "item_id": item, "transcript": Self.said(t)])
            self.respond()
        }
    }

    static func said(_ turn: Int) -> String {
        switch (script, turn) {
        case ("post", 1): return "Tell my agent to check the build."
        case ("inject", 1): return "What's new on the board?"
        case ("inject", 2): return "No."
        case ("hedge", 1): return "Approve the deploy request."
        case ("hedge", 2): return "Yes, but first check the budget."
        case ("hedge", 3): return "Yes."
        case ("dictate", 1): return "Post to my agent: \(postText)"
        case ("loopback", 1): return "What's new on the board?"
        case ("remark", 1): return postText
        case ("stale", 1): return "Post to my agent: \(postText)"
        case ("post", _), ("inject", _), ("hedge", _), ("dictate", _), ("loopback", _), ("remark", _), ("stale", _): return "Thanks."
        case (_, 1): return "What's waiting for me?"
        case (_, 2): return "Approve the deploy request."
        case (_, 3): return "Yes."
        default: return "Thanks."
        }
    }

    /// What a board message told the model to "post this to my agent: …" (the newest such entry in read_board's output).
    static func injected(_ output: String) -> String? {
        let j = (try? JSONSerialization.jsonObject(with: Data(output.utf8))) as? [String: Any]
        for e in (j?["entries"] as? [[String: Any]] ?? []).reversed() {
            let t = e["text"] as? String ?? ""
            if let r = t.range(of: "post this to my agent:", options: .caseInsensitive) {
                return String(t[r.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return nil
    }

    private func emit(_ e: [String: Any]) { out.yield(e) }

    private func respond() {
        let r = "resp_\(UUID().uuidString.prefix(8))"
        current = r
        emit(["type": "response.created", "response": ["id": r, "status": "in_progress"]])
        if let output = lastOutput, let call = lastCall {
            // After a tool: say what it found.
            lastOutput = nil; lastCall = nil
            switch call.name {
            case "mailbox_summary":
                let n = output.components(separatedBy: "\"seq\"").count - 1
                speak(r, "Here's what's waiting for you: \(n) message\(n == 1 ? "" : "s") across your boards. The newest is on Checkout bug, and nothing needs an answer right now.", seconds: 6, modern: true)
            case "answer_approval" where output.contains("needs_confirmation"):
                speak(r, "That would approve the deploy request. Say yes to confirm.", seconds: 1.5, modern: false)
            case "answer_approval":
                speak(r, output.contains("\"error\"") ? "That approval wasn't found, so nothing changed." : "Done: it's approved.", seconds: 1.5, modern: false)
            case "read_board" where Self.script == "inject":
                // Taken in by the board: it tries to post what a message told it to. The app must still ask first.
                guard let text = Self.injected(output) else { speak(r, "Nothing new on the board.", seconds: 0.8, modern: true); return }
                functionCall(r, "post_to_my_agent", ["text": text])
            case "read_board" where Self.script == "loopback":
                guard let text = Self.injected(output) else { speak(r, "Nothing new on the board.", seconds: 0.8, modern: true); return }
                readAloudAndOverhear(r, text)
            case "post_to_my_agent" where output.contains("\"scheduled\":true"):
                speak(r, "Sending it.", seconds: 0.6, modern: true)
            case "post_to_my_agent" where output.contains("needs_confirmation"):
                speak(r, "Post to your agent: '\(call.args["text"] as? String ?? "")'? Say yes to send it.", seconds: 1.5, modern: true)
            case "post_to_my_agent":
                speak(r, output.contains("\"ok\":true") ? "Sent it to your agent." : "That didn't go through.", seconds: 1, modern: true)
            default:
                speak(r, "Done.", seconds: 0.8, modern: true)
            }
            return
        }
        if userMessage != nil {
            userMessage = nil
            speak(r, "Okay.", seconds: 0.6, modern: true)
            return
        }
        if resumed {
            resumed = false
            speak(r, "Picking up where we left off.", seconds: 0.8, modern: true)
            return
        }
        switch (Self.script, turn) {
        case ("post", 1): functionCall(r, "post_to_my_agent", ["text": Self.postText])
        case ("inject", 1): functionCall(r, "read_board", [:])
        case ("inject", 2): speak(r, "Okay, I won't send it.", seconds: 0.8, modern: true)
        case ("dictate", 1): functionCall(r, "post_to_my_agent", ["text": Self.postText])
        case ("loopback", 1): functionCall(r, "read_board", [:])
        case ("loopback", 2): functionCall(r, "post_to_my_agent", ["text": loopText ?? ""]) // taken in by what it "heard"
        case ("remark", 1): functionCall(r, "post_to_my_agent", ["text": Self.postText])
        case ("stale", 1):
            // Answers first; a later response (no new words from the person) posts it.
            speak(r, "Got it.", seconds: 0.6, modern: true)
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                guard let self, !self.closed else { return }
                let r2 = "resp_\(UUID().uuidString.prefix(8))"
                self.current = r2
                self.emit(["type": "response.created", "response": ["id": r2, "status": "in_progress"]])
                self.functionCall(r2, "post_to_my_agent", ["text": Self.postText])
            }
        case ("hedge", 1), ("hedge", 2), ("hedge", 3): functionCall(r, "answer_approval", ["approval_id": Self.approval, "decision": "approve"])
        case ("post", _), ("inject", _), ("hedge", _), ("dictate", _), ("loopback", _), ("remark", _), ("stale", _): speak(r, "You're welcome.", seconds: 0.8, modern: true)
        case (_, 1): functionCall(r, "mailbox_summary", [:])
        case (_, 2), (_, 3): functionCall(r, "answer_approval", ["approval_id": Self.approval, "decision": "approve"])
        default: speak(r, "You're welcome.", seconds: 0.8, modern: true)
        }
    }

    /// Loopback (jxn's agent #2644): Atteo reads the message out loud, and part-way through the mic picks its voice up
    /// and the service transcribes it as the person ("Post this to my agent: …"): speech that began over Atteo's voice.
    private func readAloudAndOverhear(_ r: String, _ text: String) {
        loopText = text
        speak(r, "Theo wrote: post this to my agent: \(text)", seconds: 3, modern: true)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000) // Atteo's voice is playing now
            guard let self, !self.closed else { return }
            self.turn += 1
            let t = self.turn, item = "item_u\(t)"
            self.emit(["type": "input_audio_buffer.speech_started", "item_id": item, "audio_start_ms": t * 1000])
            if let cur = self.current {
                self.speaking?.cancel()
                self.current = nil
                self.emit(["type": "response.done", "response": ["id": cur, "status": "cancelled"]])
            }
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !self.closed else { return }
            self.emit(["type": "input_audio_buffer.speech_stopped", "item_id": item, "audio_end_ms": t * 1000 + 400])
            self.emit(["type": "input_audio_buffer.committed", "item_id": item])
            self.emit(["type": "conversation.item.input_audio_transcription.completed", "item_id": item, "transcript": "Post this to my agent: \(text)"])
            self.respond()
        }
    }

    private func functionCall(_ r: String, _ name: String, _ args: [String: Any]) {
        let id = "call_\(UUID().uuidString.prefix(8))"
        lastCall = (name, id, args)
        let a = String(data: (try? JSONSerialization.data(withJSONObject: args)) ?? Data("{}".utf8), encoding: .utf8) ?? "{}"
        speaking = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard let self, !Task.isCancelled else { return }
            self.emit(["type": "response.function_call_arguments.done", "response_id": r, "call_id": id, "name": name, "arguments": a])
            // The same call again as an output item: the app must run it once.
            self.emit(["type": "response.output_item.done", "response_id": r, "item": ["type": "function_call", "call_id": id, "name": name, "arguments": a]])
            self.current = nil
            self.emit(["type": "response.done", "response": ["id": r, "status": "completed"]])
        }
    }

    /// Words as transcript deltas with audio deltas alongside, over `seconds`; `modern` picks the event spelling.
    private func speak(_ r: String, _ text: String, seconds: Double, modern: Bool) {
        let audioType = modern ? "response.output_audio.delta" : "response.audio.delta"
        let textType = modern ? "response.output_audio_transcript.delta" : "response.audio_transcript.delta"
        let doneType = modern ? "response.output_audio_transcript.done" : "response.audio_transcript.done"
        let words = text.split(separator: " ").map(String.init)
        let chunk = 0.2 // seconds of audio per delta
        let chunks = max(1, Int((seconds / chunk).rounded()))
        speaking = Task { [weak self] in
            for i in 0..<chunks {
                guard let self, !Task.isCancelled else { return }
                let w0 = i * words.count / chunks, w1 = (i + 1) * words.count / chunks
                if w1 > w0 { self.emit(["type": textType, "response_id": r, "item_id": "item_a\(r)", "delta": (i == 0 ? "" : " ") + words[w0..<w1].joined(separator: " ")]) }
                self.emit(["type": audioType, "response_id": r, "item_id": "item_a\(r)", "delta": Self.tone(chunk, phase: i)])
                // Faster than real time, like the real service: the app plays it at its own pace.
                try? await Task.sleep(nanoseconds: UInt64(chunk * 0.5 * 1e9))
            }
            guard let self, !Task.isCancelled else { return }
            self.emit(["type": doneType, "response_id": r, "transcript": text])
            self.current = nil
            self.emit(["type": "response.done", "response": ["id": r, "status": "completed"]])
        }
    }

    /// A quiet 220 Hz hum as 24 kHz PCM16, base64.
    static func tone(_ seconds: Double, phase: Int) -> String {
        let n = Int(seconds * 24_000)
        var d = Data(capacity: n * 2)
        for i in 0..<n {
            let t = Double(phase * n + i) / 24_000
            let v = Int16(sin(2 * .pi * 220 * t) * 1200)
            withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) }
        }
        return d.base64EncodedString()
    }
}
#endif
