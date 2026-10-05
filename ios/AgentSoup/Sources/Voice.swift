// Voice v0 (ios/qa/design/voice/RESEARCH.md, jxn #1069; like the web's prototype in src/html.ts voiceJs): hold the
// mic in the message box and talk; what you say goes into the box, transcribed on this phone only (nothing is sent
// anywhere to transcribe it). Let go and send it, or end with "send it" to send it right away. And "Read replies
// aloud" (Settings): when a message for you lands in the chat you have open, a short blip and a bar; tap the bar to
// hear it, in the server's voice when it has one (POST /api/app/tts), else the phone's.

import AVFoundation
import Speech
import SwiftUI

// MARK: - Talking into the message box

@MainActor
final class VoiceInput: ObservableObject {
    static let shared = VoiceInput()
    @Published private(set) var listening = false
    @Published var problem: String?

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var heard = "" // the latest transcript of this hold
    private var onText: ((String, Bool) -> Void)?
    private var hints: [String] = [] // words to listen for: this board's @groups, members and agents (jxn #1731)
    private var wanted = false // still held (permission prompts take a moment)
    private var session = 0 // this listen's number: a late result or timer from an earlier one doesn't touch it

    /// "…send it" at the end: the words before it, or nil.
    static func sendIt(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let r = t.range(of: #"(^|[\s,.])send it[.!]?$"#, options: [.regularExpression, .caseInsensitive]) else { return nil }
        return String(t[..<r.lowerBound]).trimmingCharacters(in: CharacterSet(charactersIn: " ,."))
    }

    /// Starts listening (asks for the microphone and speech recognition the first time). `onText` hears the transcript
    /// so far, and `true` once it's final. `hints`: names it should expect (the board's members and their agents).
    func start(hints: [String] = [], onText: @escaping (String, Bool) -> Void) {
        guard !listening else { return }
        settle()
        wanted = true
        self.onText = onText
        self.hints = hints
        Task {
            guard await Self.allowed() else {
                problem = String(localized: "Allow the microphone and speech recognition for Atteo in Settings to talk.", bundle: .l10n)
                wanted = false
                return
            }
            guard wanted else { return }
            begin()
        }
    }

    /// Stops listening; the last words come through as final.
    func stop() {
        wanted = false
        guard listening else { return }
        request?.endAudio()
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        listening = false
        // The recognizer finishes the last words a moment later (its final result); don't wait forever.
        let mine = session
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            if let self, self.session == mine { self.finish() }
        }
    }

    /// An earlier listen still finishing (stopped, its last words not in yet): its words go in now, as they are, so
    /// talking again right away starts clean instead of the old one's final landing on (or ending) the new one.
    func settle() {
        if !listening, task != nil { finish() }
    }

    private func finish() {
        guard task != nil else { return }
        task?.cancel(); task = nil; request = nil
        onText?(heard, true)
        onText = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private static func allowed() async -> Bool {
        let speech: Bool = await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) }
        }
        guard speech else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }

    private func begin() {
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")), recognizer.isAvailable else {
            problem = String(localized: "Speech recognition isn't available right now.", bundle: .l10n)
            return
        }
        // On this phone only: nothing you say leaves it to be transcribed.
        guard recognizer.supportsOnDeviceRecognition else {
            problem = String(localized: "On-device speech recognition isn't available for your language on this iPhone.", bundle: .l10n)
            return
        }
        ReadAloud.shared.hush()
        do {
            let s = AVAudioSession.sharedInstance()
            try s.setCategory(.playAndRecord, mode: .measurement, options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP])
            try s.setActive(true, options: .notifyOthersOnDeactivation)
            let req = SFSpeechAudioBufferRecognitionRequest()
            req.requiresOnDeviceRecognition = true
            req.shouldReportPartialResults = true
            req.addsPunctuation = true
            req.contextualStrings = hints
            request = req
            heard = ""
            session += 1
            let mine = session
            let input = engine.inputNode
            let f = input.outputFormat(forBus: 0)
            guard f.sampleRate > 0, f.channelCount > 0 else {
                problem = String(localized: "The microphone isn't available right now (\(Int(f.sampleRate)) Hz × \(f.channelCount)). Try again, or check Settings → Privacy → Microphone.", bundle: .l10n)
                request = nil
                return
            }
            input.installTap(onBus: 0, bufferSize: 1024, format: f) { buf, _ in req.append(buf) }
            engine.prepare()
            try engine.start()
            listening = true
            Haptics.play(.touch)
            task = recognizer.recognitionTask(with: req) { [weak self] result, error in
                Task { @MainActor in
                    guard let self, self.session == mine else { return } // an earlier listen's late words
                    if let result {
                        self.heard = result.bestTranscription.formattedString
                        if result.isFinal { self.finish() } else { self.onText?(self.heard, false) }
                    } else if error != nil { self.finish() }
                }
            }
        } catch {
            problem = String(localized: "Couldn't start the microphone: \(error.localizedDescription)", bundle: .l10n)
            engine.inputNode.removeTap(onBus: 0)
            listening = false
        }
    }
}

/// The message box's mic: hold to talk (VoiceOver: activate to start, again to stop).
struct MicButton: View {
    @ObservedObject private var voice = VoiceInput.shared
    @Binding var draft: String
    let send: () -> Void
    var identifier = "mic"
    /// This board's members, so "at vedu" goes in as "@vedu" (SpokenMentions.swift).
    var spoken: SpokenMentions? = nil
    @State private var holding = false
    @State private var pressedAt = Date.distantPast
    @State private var tapMode = false
    @State private var stoppedOnPress = false // a quick tap keeps listening until the next tap (vedu #1605: the hold wasn't landing)

    var body: some View {
        Image(systemName: voice.listening ? "waveform" : "mic.fill")
            .font(.system(size: 14, weight: .bold))
            .symbolEffect(.variableColor.iterative, isActive: voice.listening && Effects.enabled)
            .composerCircle(fill: voice.listening ? Theme.cherry : Theme.raised)
            .foregroundStyle(voice.listening ? Theme.onAccent : Theme.muted)
            .scaleEffect(holding ? 1.12 : 1)
            .animation(.spring(duration: 0.25, bounce: 0.3), value: holding)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !holding else { return }
                        holding = true
                        pressedAt = Date()
                        if tapMode { tapMode = false; stoppedOnPress = true; voice.stop() } else { stoppedOnPress = false; start() }
                    }
                    .onEnded { _ in
                        holding = false
                        if stoppedOnPress { return } // that tap ended a tap-to-talk
                        if Date().timeIntervalSince(pressedAt) < 0.35 { tapMode = true } // a tap: keep listening until the next tap
                        else { voice.stop() } // a hold: let go to stop
                    }
            )
            .onChange(of: voice.listening) { _, now in if !now && !holding { tapMode = false } } // it finished on its own
            .accessibilityElement()
            .accessibilityLabel(voice.listening ? "Stop talking" : "Talk")
            .accessibilityHint("Hold and talk; what you say goes in the message box. End with “send it” to send it.")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { if voice.listening { voice.stop() } else { start() } }
            .accessibilityIdentifier(identifier)
            .alert("Talk", isPresented: Binding(get: { voice.problem != nil }, set: { if !$0 { voice.problem = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(voice.problem ?? "") }
    }

    /// Each listen starts from what's in the box now (an earlier one's last words in first), and what you change by
    /// hand while it listens stays: what you say next goes after it (DictationMerge). The merge lives in the closure,
    /// not the view: the mic gives way to send once there's text, before the last words are in.
    private func start() {
        voice.settle()
        let merge = DictationMerge.Box(DictationMerge(draft))
        let spoken = spoken
        let draft = $draft
        voice.start(hints: spoken?.hints ?? []) { text, final in
            let say: (String) -> String = { spoken?.apply($0) ?? $0 }
            if final, let words = VoiceInput.sendIt(text) {
                draft.wrappedValue = merge.value.merge(words, into: draft.wrappedValue, say)
                if !draft.wrappedValue.trimmingCharacters(in: .whitespaces).isEmpty { send() }
            } else {
                draft.wrappedValue = merge.value.merge(text, into: draft.wrappedValue, say)
            }
        }
    }
}

/// Dictation into a box you can type in too. What's heard goes after what the box held when listening started; if
/// the box is changed by hand while it listens, that change stays and only the words heard after it are added, at
/// the end (the recognizer rewrites its whole transcript as it goes, so it can't simply be put back each time).
struct DictationMerge {
    private(set) var base: String // the box's text the transcript goes after ("…words " or "")
    private var consumed = "" // the transcript already in `base` (heard before a hand edit)
    private var heardLast = "" // the transcript at the last write
    private var written: String // the box as dictation last left it (at the start: as it was)

    init(_ draft: String) { base = Self.joined(draft); written = draft }

    /// Reference storage for a listen's closure.
    final class Box { var value: DictationMerge; init(_ v: DictationMerge) { value = v } }

    /// The box with what's heard so far (`heard`: the recognizer's whole transcript of this listen; `say`: dictation's
    /// mentions, "at vedu" → "@vedu").
    mutating func merge(_ heard: String, into draft: String, _ say: (String) -> String = { $0 }) -> String {
        if draft != written { base = Self.joined(draft); consumed = heardLast } // changed by hand: keep it
        heardLast = heard
        let fresh = Self.after(consumed, in: heard)
        let out = fresh.isEmpty ? draft : base + say(fresh)
        written = out
        return out
    }

    /// Text with one space after it to go on from ("" when empty).
    static func joined(_ s: String) -> String {
        let d = s.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression)
        return d.isEmpty ? "" : d + " "
    }

    /// The words of `heard` after `consumed`: what follows it when `heard` still starts with it (at a word's end),
    /// else after as many words (the recognizer changed one of them: the hand edit wins).
    static func after(_ consumed: String, in heard: String) -> String {
        let h = heard.trimmingCharacters(in: .whitespaces), c = consumed.trimmingCharacters(in: .whitespaces)
        if c.isEmpty { return h }
        if h.hasPrefix(c) {
            let rest = h.dropFirst(c.count)
            if rest.isEmpty || rest.first!.isWhitespace { return rest.trimmingCharacters(in: .whitespaces) }
        }
        let n = c.split(whereSeparator: \.isWhitespace).count
        return h.split(whereSeparator: \.isWhitespace).dropFirst(n).joined(separator: " ")
    }
}

// MARK: - Read replies aloud

@MainActor
final class ReadAloud: NSObject, ObservableObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    static let shared = ReadAloud()
    static let key = "read-aloud"
    /// Per device, off until you turn it on.
    static var enabled: Bool { UserDefaults.standard.bool(forKey: key) }

    struct Item: Equatable { let board: Board; let entry: Entry; let from: String }
    @Published private(set) var queue: [Item] = []
    @Published private(set) var speaking = false
    private var serverVoice: Bool? // GET /api/app/tts/status, once a launch
    private let synth = AVSpeechSynthesizer()
    private var player: AVAudioPlayer?
    private var blipPlayer: AVAudioPlayer?

    override init() {
        super.init()
        synth.delegate = self
        AudioOut.shared.onChange { [weak self] on in
            if self?.speaking == true { AudioRoutePlan.plan(.readAloud, loudspeaker: on).apply() } // moves what's being read
        }
    }

    /// A message for you landed in the chat you have open: a blip, and it waits in the bar.
    func heard(_ e: Entry, from: String, in board: Board) {
        guard Self.enabled, !queue.contains(where: { $0.entry.seq == e.seq && $0.board.id == board.id }) else { return }
        withAnimation(.snappy) { queue.append(Item(board: board, entry: e, from: from)) }
        blip()
    }

    /// Plays what's waiting, in order (or stops, if it's reading).
    func tap() { if speaking { hush() } else { next() } }

    /// Stops reading and forgets what was waiting.
    func hush() {
        synth.stopSpeaking(at: .immediate)
        player?.stop(); player = nil
        withAnimation(.snappy) { queue = []; speaking = false }
    }

    /// Leaving a chat: what was waiting there goes.
    func leave(_ board: String) {
        guard queue.contains(where: { $0.board.id == board }) else { return }
        hush()
    }

    private func next() {
        guard !queue.isEmpty else { withAnimation(.snappy) { speaking = false }; return }
        let it = queue.removeFirst()
        withAnimation(.snappy) { speaking = true }
        Task { await speak(it) }
    }

    private func speak(_ it: Item) async {
        AudioRoutePlan.plan(.readAloud, loudspeaker: AudioOut.shared.loudspeaker).apply() // the speaker button (#2384)
        if it.board.encrypted != true, await serverHasVoice() {
            do {
                let data = try await API.shared.send("/api/app/tts", body: ["board": it.board.id, "seq": it.entry.seq], retries: false)
                let p = try AVAudioPlayer(data: data)
                p.delegate = self
                p.volume = 1
                player = p
                if p.play() { return }
            } catch {} // over the allowance, the service down, an encrypted board: the phone's voice instead
        }
        let u = AVSpeechUtterance(string: Self.spoken(it))
        u.voice = Self.bestVoice()
        u.volume = 1
        synth.usesApplicationAudioSession = true // our session (the speaker choice), not the system's
        synth.speak(u)
    }

    private func serverHasVoice() async -> Bool {
        if let v = serverVoice { return v }
        struct S: Decodable { let enabled: Bool }
        let v = (try? await API.shared.get("/api/app/tts/status", as: S.self))?.enabled ?? false
        serverVoice = v
        return v
    }

    /// "theo's agent. The deploy is green…": who, then what (links as "a link", at most about 700 characters).
    static func spoken(_ it: Item) -> String {
        let body = it.entry.text
            .replacingOccurrences(of: #"https?://\S+"#, with: String(localized: "a link", bundle: .l10n), options: .regularExpression)
            .replacingOccurrences(of: #"```[\s\S]*?```"#, with: String(localized: "(code omitted)", bundle: .l10n), options: .regularExpression)
            .replacingOccurrences(of: #"[*_`#>]"#, with: "", options: .regularExpression)
        return it.from + ". " + String(body.prefix(700))
    }

    /// The best voice this phone has for its language: premium, then enhanced, then any.
    private static func bestVoice() -> AVSpeechSynthesisVoice? {
        let lang = AVSpeechSynthesisVoice.currentLanguageCode()
        let all = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == lang }
        return all.first { $0.quality == .premium } ?? all.first { $0.quality == .enhanced } ?? AVSpeechSynthesisVoice(language: lang)
    }

    /// A soft two-note blip (660 Hz, then 880 Hz), like the web's.
    private func blip() {
        Haptics.play(.touch)
        if blipPlayer == nil { blipPlayer = try? AVAudioPlayer(data: Self.blipWAV) }
        try? AVAudioSession.sharedInstance().setCategory(.ambient, options: [.mixWithOthers])
        blipPlayer?.currentTime = 0
        blipPlayer?.play()
    }

    private static let blipWAV: Data = {
        let rate = 22_050
        var samples: [Int16] = []
        for (f, start) in [(660.0, 0.0), (880.0, 0.09)] {
            let first = Int(start * Double(rate)), n = Int(0.17 * Double(rate))
            if samples.count < first + n { samples += Array(repeating: 0, count: first + n - samples.count) }
            for i in 0..<n {
                let t = Double(i) / Double(rate)
                let env = t < 0.015 ? t / 0.015 : exp(-(t - 0.015) * 28)
                let v = sin(2 * .pi * f * t) * env * 0.25
                samples[first + i] = Int16(clamping: Int(samples[first + i]) + Int(v * 32767))
            }
        }
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 2)
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + bytes); d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(bytes)
        for s in samples { u16(UInt16(bitPattern: s)) }
        return d
    }()

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { Task { @MainActor in self.next() } }
    nonisolated func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully: Bool) { Task { @MainActor in if p !== self.blipPlayer { self.next() } } }
}

/// Over the message box while something for you is waiting (or being read): tap to hear it, tap again to stop.
struct ReadAloudBar: View {
    @ObservedObject private var aloud = ReadAloud.shared
    let board: String

    var body: some View {
        let waiting = aloud.queue.filter { $0.board.id == board }
        if aloud.speaking || !waiting.isEmpty {
            HStack(spacing: Space.s) {
                Button { aloud.tap() } label: {
                    HStack(spacing: Space.s) {
                        Image(systemName: aloud.speaking ? "speaker.wave.2.fill" : "speaker.wave.1.fill").foregroundStyle(Theme.accent)
                        (aloud.speaking
                             ? (waiting.isEmpty ? Text("Reading · tap to stop") : Text("Reading · \(waiting.count) more · tap to stop"))
                             : (waiting.count > 1 ? Text("\(waiting.count) for you, first from \(waiting[0].from) · tap to hear") : Text("For you from \(waiting[0].from) · tap to hear")))
                            .font(Typo.meta.weight(.medium)).foregroundStyle(Theme.text).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("read-aloud-bar")
                SpeakerToggle(style: .icon)
                Button { aloud.hush() } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.muted).frame(width: 28, height: 28) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss")
            }
            .padding(.horizontal, Space.m).padding(.vertical, Space.xs)
            .background(Theme.card, in: Rectangle())
            .padding(.horizontal, Space.m).padding(.top, Space.s)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

/// Settings → Voice: read replies aloud (per device).
struct VoiceSection: View {
    @AppStorage(ReadAloud.key) private var aloud = false
    var body: some View {
        Section {
            Toggle("Read replies aloud", isOn: $aloud).tint(Theme.accent)
                .onChange(of: aloud) { _, on in if !on { ReadAloud.shared.hush() } }
                .accessibilityIdentifier("read-aloud-toggle")
        } header: { SectionHeader("Voice") } footer: {
            Text("When a message for you lands in the chat you have open, a short blip; tap the bar to hear it. Hold the mic in the message box to talk; end with “send it” to send. Speech is turned into text on this phone.")
        }
        .listRowBackground(Theme.card)
    }
}
