// DEBUG only: a stand-in for xAI's realtime socket, for a local server's fake voice provider (voice.ts: DEV_FAKE_VOICE=1
// in .dev.vars, the x-dev-fake-voice header, localhost). The server's fake only hands out a canned secret, so the
// conversation itself is played here: the same events Grok sends (both the output_audio and the audio spellings), real
// tool calls the app runs against the local server, and a quiet tone for Grok's voice (timed, not played: the fake
// never starts audio). Each turn follows a script:
//   1. "What's waiting for me?" → mailbox_summary → a long answer (long enough to interrupt)
//   2. "Approve the deploy request." → answer_approval → (the app asks for a yes) → "Say yes to confirm."
//   3. "Yes." → answer_approval again → what the server said
//   then small talk.

#if DEBUG
import Foundation

@MainActor
final class FakeGrokLink: RealtimeLink {
    static let approval = "ap_fakevoice000"
    let events: AsyncStream<[String: Any]>
    private let out: AsyncStream<[String: Any]>.Continuation
    private var turn = 0
    private var buffered = 0
    private var lastCall: (name: String, id: String)?
    private var lastOutput: String?
    private var userMessage: String?
    private var speaking: Task<Void, Never>?
    private var current: String?
    private var closed = false

    init() { (events, out) = AsyncStream.makeStream(of: [String: Any].self) }

    func close() { closed = true; speaking?.cancel(); out.finish() }

    func send(_ e: [String: Any]) {
        guard !closed else { return }
        switch e["type"] as? String {
        case "session.update":
            emit(["type": "session.updated", "session": e["session"] ?? [:]])
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

    static func said(_ turn: Int) -> String {
        switch turn {
        case 1: return "What's waiting for me?"
        case 2: return "Approve the deploy request."
        case 3: return "Yes."
        default: return "Thanks."
        }
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
        switch turn {
        case 1: functionCall(r, "mailbox_summary", [:])
        case 2, 3: functionCall(r, "answer_approval", ["approval_id": Self.approval, "decision": "approve"])
        default: speak(r, "You're welcome.", seconds: 0.8, modern: true)
        }
    }

    private func functionCall(_ r: String, _ name: String, _ args: [String: Any]) {
        let id = "call_\(UUID().uuidString.prefix(8))"
        lastCall = (name, id)
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
                if w1 > w0 { self.emit(["type": textType, "response_id": r, "delta": (i == 0 ? "" : " ") + words[w0..<w1].joined(separator: " ")]) }
                self.emit(["type": audioType, "response_id": r, "delta": Self.tone(chunk, phase: i)])
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
