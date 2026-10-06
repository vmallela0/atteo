// Voice chat's audio (Talk.swift): one AVAudioEngine for both ways. The mic, all the time (hands-free) or while the
// button is held, as 24 kHz mono PCM16 (what voice.ts asks for), with the phone's echo cancelling (.voiceChat) so the
// open mic doesn't hear Atteo's own voice; the 24 kHz PCM16 deltas into a player node. Out of the loudspeaker, not the
// earpiece (vedu #1598): voice processing likes to move the route to the receiver, so whenever the route's output is
// the built-in receiver it's overridden to the speaker; AirPods, Bluetooth and wired headsets are left alone. The person
// can pick the earpiece instead (AudioRoute.swift, vedu #2384), and on the loudspeaker it runs in .videoChat with a
// little gain and a limiter, since .voiceChat plays at the quieter phone-call level. A call or
// Siri pauses it, and a route change (headphones in or out) rebuilds the engine for the new hardware. Standing by
// (TalkStandby.swift) there's no engine and no mic, but the audio stays the app's (playback, not let go), so AirPods'
// play comes here and not to whatever was playing before; a soft falling chime says it stopped listening, a rising one
// that it listens again.
// Starting can fail on a real phone (vedu #5249: avfaudio error 2003329396, 'what'), most often while the route is
// still settling (a call or another app just let go, AirPods connecting, the speaker override's own change) or because
// voice processing won't start on that route. So it's tried three times (TalkAudioStart, the pure part, tested): a fresh
// session after 0.3 s, then without echo cancelling after 0.8 s; with no usable mic it still plays Atteo's voice. Only
// then does it say why, in words, and a later route change or the end of an interruption tries again.

import AVFoundation

@MainActor
final class TalkAudio {
    /// failed: why, as a sentence for the person (TalkAudioStart.reason); recovered: working again after that.
    enum Event { case interrupted, resumed, failed(String), recovered }

    static let rate: Double = 24_000
    var useMic = true
    /// The person allowed the microphone: without it there's no tap, only Atteo's voice (and no "no microphone" error).
    var micAllowed = true
    var muted = false { didSet { player?.volume = muted ? 0 : 1 } }
    var events: ((Event) -> Void)?
    /// The mic's loudness, 0…1, about ten times a second while capturing.
    var onLevel: ((Float) -> Void)?
    /// Whether the phone's echo cancelling is on: without it an open mic hears Atteo through the speaker.
    private(set) var echoCancelling = false

    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var boost: AVAudioUnitEQ? // the plan's gain (louder on the loudspeaker), then a limiter so it never clips
    private let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
    private let micFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true)!
    private var onChunk: ((String) -> Void)?
    private let tapState = TapState()
    private var observers: [NSObjectProtocol] = []
    private var started = false
    private var configObserver: NSObjectProtocol?
    private var bringing: Task<Void, Never>?
    /// How it last started, for the call's diagnostics: the try, or the error's domain and code; the route's ports.
    private var startStatus = ""
    /// That, how often the engine restarted after a configuration change or was rebuilt, and whether it runs now.
    var status: String {
        guard !startStatus.isEmpty else { return "" }
        return "\(startStatus) · restarts \(restarts), rebuilds \(rebuilds) · \(engine?.isRunning == true ? "running" : "stopped")"
    }
    private var failing = false
    private var tapped = false

    /// The audio session and the engine, retried (TalkAudioStart); if it never starts, `events` gets .failed with why
    /// (captions still work) and a route change or an interruption's end tries again.
    func start() async {
        guard !started else { return }
        started = true
        standingBy = false
        restarts = 0; rebuilds = 0
        chimePlayer?.stop(); chimePlayer = nil
        let s = AVAudioSession.sharedInstance()
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: s, queue: .main) { [weak self] n in
            let type = (n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            MainActor.assumeIsolated { self?.interruption(type) }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: s, queue: .main) { [weak self] n in
            let reason = (n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            MainActor.assumeIsolated {
                if reason == .newDeviceAvailable || reason == .oldDeviceUnavailable { self?.rebuild() } else { self?.preferSpeaker() }
            }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: s, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.rebuild() }
        })
        await bringUp().value
    }

    func stop() {
        guard started else { return }
        halt()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Standing by: the engine and the mic stop (no recording indicator), the audio session stays this app's as
    /// playback (AirPods are headphones again and their play comes here), and a falling chime says it.
    func standBy() {
        halt()
        standingBy = true
        AudioRoutePlan.plan(.readAloud, loudspeaker: AudioOut.shared.loudspeaker).apply()
        chime(up: false)
    }

    /// Lets the audio go entirely (the call ended while standing by).
    func release() {
        guard standingBy else { return }
        standingBy = false
        chimePlayer?.stop(); chimePlayer = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func halt() {
        guard started else { return }
        started = false
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        bringing?.cancel(); bringing = nil // `failing` stays: a resume that starts says .recovered
        teardown()
    }

    /// Listening again: a short rising chime through the call's own player.
    func resumed() { play(Self.chimePCM(up: true)) }

    private var chimePlayer: AVAudioPlayer?
    private var standingBy = false

    private func chime(up: Bool) {
        chimePlayer = try? AVAudioPlayer(data: Self.wav(Self.chimePCM(up: up)))
        chimePlayer?.volume = muted ? 0 : 1
        chimePlayer?.play()
    }

    /// Two soft notes, 24 kHz mono PCM16: 660 → 880 Hz up (listening), 880 → 587 Hz down (standing by).
    static func chimePCM(up: Bool) -> Data {
        let notes: [Double] = up ? [660, 880] : [880, 587]
        let n = Int(0.14 * rate)
        var d = Data(capacity: notes.count * n * 2)
        for f in notes {
            for i in 0..<n {
                let t = Double(i) / rate
                let env = t < 0.01 ? t / 0.01 : exp(-(t - 0.01) * 22)
                let v = Int16(sin(2 * .pi * f * t) * env * 0.18 * 32767)
                withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) }
            }
        }
        return d
    }

    /// 24 kHz mono PCM16 as a WAV file (for AVAudioPlayer).
    static func wav(_ pcm: Data) -> Data {
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + UInt32(pcm.count)); d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate) * 2); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(UInt32(pcm.count))
        d.append(pcm)
        return d
    }

    /// From now until stopCapture(), each ~100 ms of the mic comes to `chunk` as base64 PCM16 (and its level to onLevel).
    func capture(_ chunk: @escaping (String) -> Void) {
        onChunk = chunk
        tapState.set(true)
    }

    func stopCapture() {
        tapState.set(false)
        onChunk = nil
    }

    /// The loudspeaker instead of the earpiece, unless the person picked the earpiece. Only when the output is the
    /// built-in receiver, so AirPods, Bluetooth and headphones keep the sound (and the override's own route change doesn't loop).
    private func preferSpeaker() {
        let s = AVAudioSession.sharedInstance()
        guard started, AudioRoutePlan.shouldOverride(loudspeaker: AudioOut.shared.loudspeaker, outputs: s.currentRoute.outputs.map(\.portType)) else { return }
        try? s.overrideOutputAudioPort(.speaker)
    }

    /// The speaker button: moves the sound now, whether talking or standing by.
    func setLoudspeaker(_ on: Bool) {
        if started {
            let plan = AudioRoutePlan.plan(.talk, loudspeaker: on)
            plan.apply()
            boost?.globalGain = plan.gainDB
        } else if standingBy {
            AudioRoutePlan.plan(.readAloud, loudspeaker: on).apply()
        }
    }

    /// Queues Grok's PCM16 (24 kHz mono); answers how long it lasts.
    @discardableResult
    func play(_ pcm: Data) -> TimeInterval {
        let n = pcm.count / 2
        guard n > 0 else { return 0 }
        let seconds = Double(n) / Self.rate
        guard let player, let engine, engine.isRunning, let buf = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: AVAudioFrameCount(n)) else { return seconds }
        buf.frameLength = AVAudioFrameCount(n)
        let out = buf.floatChannelData![0]
        pcm.withUnsafeBytes { raw in
            let src = raw.bindMemory(to: Int16.self)
            for i in 0..<n { out[i] = Float(Int16(littleEndian: src[i])) / 32768 }
        }
        player.scheduleBuffer(buf)
        if !player.isPlaying { player.play() }
        return seconds
    }

    /// Drops whatever Grok was still going to say.
    func stopPlayback() {
        player?.stop()
        if engine?.isRunning == true { player?.play() }
    }

    // MARK: - The engine

    /// Tries until it works (TalkAudioStart.run). A newer bring-up (another route change) replaces one still trying.
    @discardableResult
    private func bringUp(settle: TimeInterval = 0) -> Task<Void, Never> {
        bringing?.cancel()
        let t = Task { [weak self] in
            if settle > 0 { try? await Task.sleep(nanoseconds: UInt64(settle * 1e9)) }
            guard let self, !Task.isCancelled, self.started else { return }
            var tries = 0
            let error = await TalkAudioStart.run(attempt: { [weak self] n in
                tries = n + 1
                try self?.attempt(n, mic: TalkAudioStart.mic(attempt: n))
            }, sleep: { [weak self] d in
                try? await Task.sleep(nanoseconds: UInt64(d * 1e9))
                return !Task.isCancelled && self?.started == true
            })
            guard !Task.isCancelled, self.started else { return }
            let why = error.map(TalkAudioStart.reason)
            if let e = error, case TalkAudioStart.Failure.noMic = e {
                try? self.attempt(0, mic: .none) // no usable mic on any try: Atteo's voice still plays, and it says why
            }
            let route = AVAudioSession.sharedInstance().currentRoute
            let ports = (route.inputs + route.outputs).map(\.portType.rawValue).joined(separator: ",")
            if let e = error as NSError? {
                self.startStatus = "failed after \(tries) tries: \(e.domain) \(e.code) · \(ports)"
            } else {
                self.startStatus = "started on try \(tries)\(self.micAllowed ? "" : ", no mic permission") · \(ports)"
            }
            if let why {
                self.failing = true
                self.events?(.failed(why))
            } else if self.failing {
                self.failing = false
                self.events?(.recovered)
            }
        }
        bringing = t
        return t
    }

    /// One try: a fresh engine on an active session (deactivated first on a retry: stale route state is what 'what'
    /// usually means), the mic as `mic` says (none when the person didn't allow it).
    private func attempt(_ n: Int, mic: TalkAudioStart.Mic) throws {
        guard started else { return }
        teardown()
        let s = AVAudioSession.sharedInstance()
        if n > 0 { try? s.setActive(false) }
        let plan = AudioRoutePlan.plan(.talk, loudspeaker: AudioOut.shared.loudspeaker)
        // Only when it differs: setting it again can drop the loudspeaker override, and the override's own route change
        // would rebuild again, for ever.
        if s.category != plan.category || s.mode != plan.mode || s.categoryOptions != plan.options {
            try s.setCategory(plan.category, mode: plan.mode, options: plan.options)
        }
        try s.setActive(true, options: .notifyOthersOnDeactivation)
        do { try build(mic: micAllowed ? mic : .none) } catch { teardown(); throw error }
    }

    private func build(mic: TalkAudioStart.Mic) throws {
        let e = AVAudioEngine()
        let p = AVAudioPlayerNode()
        e.attach(p)
        echoCancelling = false
        if mic != .none {
            // Echo cancelling: Grok's voice out of the speaker isn't sent back as yours. Some iPhones hand back an unusable
            // or multichannel format with it on, so: tap in whatever the node gives (format nil), take channel 0, resample
            // that mono stream to 24 kHz. Nothing usable throws noMic (with what the mic reported), to try again.
            let input = e.inputNode
            if mic == .echoCancelled { try? input.setVoiceProcessingEnabled(true) }
            var f = input.outputFormat(forBus: 0)
            if !TalkAudioStart.usable(sampleRate: f.sampleRate, channels: f.channelCount), input.isVoiceProcessingEnabled {
                try? input.setVoiceProcessingEnabled(false)
                f = input.outputFormat(forBus: 0)
            }
            guard TalkAudioStart.usable(sampleRate: f.sampleRate, channels: f.channelCount) else {
                let i = input.inputFormat(forBus: 0)
                throw TalkAudioStart.Failure.noMic("out \(Int(f.sampleRate)) Hz × \(f.channelCount), in \(Int(i.sampleRate)) Hz × \(i.channelCount), route \(AVAudioSession.sharedInstance().currentRoute.inputs.map(\.portType.rawValue).joined(separator: ","))")
            }
            echoCancelling = input.isVoiceProcessingEnabled
            if echoCancelling {
                // Only ever duck other apps' audio a little; Atteo's own voice isn't "other audio".
                input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
            }
            let state = tapState, stream = MicStream(target: micFormat)
            input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(f.sampleRate / 10), format: nil) { [weak self] buf, _ in
                guard state.on, let (b64, level) = stream.base64(buf) else { return }
                Task { @MainActor in self?.onChunk?(b64); self?.onLevel?(level) }
            }
            tapped = true
        }
        // player → gain → limiter → mixer: louder on the loudspeaker without clipping.
        let eq = AVAudioUnitEQ(numberOfBands: 0)
        eq.globalGain = AudioRoutePlan.plan(.talk, loudspeaker: AudioOut.shared.loudspeaker).gainDB
        let limiter = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
            componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_PeakLimiter,
            componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0))
        e.attach(eq); e.attach(limiter)
        e.connect(p, to: eq, format: playFormat)
        e.connect(eq, to: limiter, format: playFormat)
        e.connect(limiter, to: e.mainMixerNode, format: playFormat)
        boost = eq
        p.volume = muted ? 0 : 1
        e.mainMixerNode.outputVolume = 1
        e.prepare()
        engine = e; player = p
        try e.start()
        p.play()
        preferSpeaker() // after voice processing and the engine start, which can move the route to the earpiece
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: e, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.configChanged() }
        }
    }

    private var restarting: Task<Void, Never>?
    private var restarts = 0, rebuilds = 0

    /// The engine's own configuration changed (vedu #5338): the speaker override, or voice processing moving the
    /// route, which every new engine does. It used to rebuild here, and the new engine's voice processing moved the
    /// route again, so the call's audio was torn down over and over: nothing played, the mic barely counted, and the
    /// quiet timer stood the call by (or a rebuild threw 'what', #5249). Now the same engine (nodes, tap, player)
    /// starts again; only if that fails is it built afresh.
    private func configChanged() {
        guard started else { return }
        restarting?.cancel()
        restarting = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 100_000_000) // a burst of changes restarts it once
            guard let self, !Task.isCancelled, self.started, let e = self.engine else { return }
            guard TalkAudioStart.onConfigChange(running: e.isRunning) == .restart else { return }
            self.restarts += 1
            do {
                e.prepare()
                try e.start()
                self.player?.play()
                self.preferSpeaker()
            } catch {
                self.rebuild()
            }
        }
    }

    private func teardown() {
        restarting?.cancel(); restarting = nil
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        if let engine {
            if tapped { engine.inputNode.removeTap(onBus: 0) }
            engine.stop()
        }
        player = nil; engine = nil; boost = nil; tapped = false
    }

    /// New hardware (AirPods in, headphones out, the media server reset, an interruption's end, an engine that won't
    /// restart): a fresh engine in the new formats, once the route has settled a moment (a burst brings it up once).
    private func rebuild() {
        guard started else { return }
        rebuilds += 1
        teardown()
        bringUp(settle: 0.15)
    }

    private func interruption(_ type: AVAudioSession.InterruptionType?) {
        switch type {
        case .began:
            events?(.interrupted)
            bringing?.cancel(); bringing = nil
            engine?.pause()
        case .ended:
            rebuild()
            events?(.resumed)
        default: break
        }
    }

}

/// How the call's audio is started (pure, tested): the tries, how long between them, the mic each uses, and what to
/// tell the person if none works.
enum TalkAudioStart {
    enum Mic: Equatable { case echoCancelled, plain, none }
    enum Failure: Error { case noMic(String) }

    /// Seconds to wait before try `n` (0-based; the first is now), nil once there are no more.
    static func delay(beforeAttempt n: Int) -> TimeInterval? {
        switch n {
        case 0: 0
        case 1: 0.3
        case 2: 0.8
        default: nil
        }
    }

    enum ConfigAction: Equatable { case restart, nothing }

    /// The engine's configuration changed: start the same engine again if it stopped (never build a new one, whose
    /// voice processing would move the route and change the configuration again, for ever: vedu #5338).
    static func onConfigChange(running: Bool) -> ConfigAction { running ? .nothing : .restart }

    /// The last try goes without echo cancelling: voice processing is what most often won't start on a route.
    static func mic(attempt n: Int) -> Mic { n >= 2 ? .plain : .echoCancelled }

    /// A mic format the tap can use: some rate, some channel (0 Hz × 0 is what a phone with no mic route reports).
    static func usable(sampleRate: Double, channels: AVAudioChannelCount) -> Bool { sampleRate > 0 && channels > 0 }

    /// Runs `attempt(n)` until it doesn't throw, waiting with `sleep` between tries (which answers false to stop:
    /// the call ended). Answers the last error, or nil when it started (or was stopped).
    @MainActor static func run(attempt: (Int) throws -> Void, sleep: (TimeInterval) async -> Bool) async -> Error? {
        var n = 0
        while true {
            do { try attempt(n); return nil } catch {
                n += 1
                guard let wait = delay(beforeAttempt: n) else { return error }
                guard await sleep(wait) else { return nil }
            }
        }
    }

    /// The codes that mean someone else has the audio: a phone or FaceTime call, Siri, or an app that won't share the mic.
    static let busyCodes: Set<Int> = [
        AVAudioSession.ErrorCode.insufficientPriority.rawValue, AVAudioSession.ErrorCode.cannotInterruptOthers.rawValue,
        AVAudioSession.ErrorCode.isBusy.rawValue, AVAudioSession.ErrorCode.cannotStartRecording.rawValue,
        AVAudioSession.ErrorCode.siriIsRecording.rawValue,
    ]

    /// What the sheet says when it never started, in words (never CoreAudio's numbers).
    static func reason(_ error: Error) -> String {
        if case Failure.noMic = error {
            return String(localized: "No microphone is available right now, so Atteo can't hear you. Captions still show.", bundle: .l10n)
        }
        if busyCodes.contains((error as NSError).code) {
            return String(localized: "Another app or a call is using the microphone. Captions still show; end and start again once it's free.", bundle: .l10n)
        }
        return String(localized: "The microphone and speaker didn't start. Captions still show; end and start again to retry.", bundle: .l10n)
    }
}

/// The mic's buffers (any rate, any channel count, float or int) → base64 PCM16 mono at the target rate. Used only on the
/// audio thread that delivers the tap, one buffer at a time.
private final class MicStream: @unchecked Sendable {
    private let target: AVAudioFormat // PCM16 mono 24 kHz
    private var conv: AVAudioConverter?
    private var monoFormat: AVAudioFormat?
    init(target: AVAudioFormat) { self.target = target }

    /// The chunk as base64, and its loudness 0…1 (RMS, -50…-10 dBFS).
    func base64(_ buf: AVAudioPCMBuffer) -> (String, Float)? {
        let n = Int(buf.frameLength), sr = buf.format.sampleRate
        guard n > 0, sr > 0 else { return nil }
        // Channel 0 as Float32 mono at the mic's own rate.
        if monoFormat?.sampleRate != sr {
            monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sr, channels: 1, interleaved: false)
            conv = monoFormat.flatMap { AVAudioConverter(from: $0, to: target) }
        }
        guard let monoFormat, let conv, let mono = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: AVAudioFrameCount(n)) else { return nil }
        mono.frameLength = AVAudioFrameCount(n)
        let dst = mono.floatChannelData![0]
        if let f = buf.floatChannelData {
            if buf.format.isInterleaved { let stride = Int(buf.format.channelCount); for k in 0..<n { dst[k] = f[0][k * stride] } }
            else { dst.update(from: f[0], count: n) }
        } else if let i = buf.int16ChannelData {
            let stride = buf.format.isInterleaved ? Int(buf.format.channelCount) : 1
            for k in 0..<n { dst[k] = Float(i[0][k * stride]) / 32768 }
        } else { return nil }
        var sum: Float = 0
        for k in 0..<n { sum += dst[k] * dst[k] }
        let db = 20 * log10(max(sqrt(sum / Float(n)), 1e-6))
        let level = min(1, max(0, (db + 50) / 40))
        // Resample + to PCM16.
        let cap = AVAudioFrameCount(Double(n) * target.sampleRate / sr) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: cap) else { return nil }
        var fed = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return mono
        }
        guard err == nil, out.frameLength > 0, let ch = out.int16ChannelData else { return nil }
        return (Data(bytes: ch[0], count: Int(out.frameLength) * 2).base64EncodedString(), level)
    }
}

/// Whether the mic tap forwards (read on the audio thread).
private final class TapState: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var on: Bool { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ v: Bool) { lock.lock(); value = v; lock.unlock() }
}
