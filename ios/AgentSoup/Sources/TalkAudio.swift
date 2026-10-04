// Talk to Grok's audio (Talk.swift): one AVAudioEngine for both ways. The mic, while the button is held, as 24 kHz mono
// PCM16 (what voice.ts asks for), with the phone's echo cancelling (.voiceChat) so Grok doesn't hear itself; Grok's
// 24 kHz PCM16 deltas into a player node. AirPods and other Bluetooth headsets work; a call or Siri pauses it, and a
// route change (headphones in or out) rebuilds the engine for the new hardware.

import AVFoundation

@MainActor
final class TalkAudio {
    enum Event { case interrupted, resumed, failed(String) }

    static let rate: Double = 24_000
    var useMic = true
    var muted = false { didSet { player?.volume = muted ? 0 : 1 } }
    var events: ((Event) -> Void)?

    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)!
    private let micFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true)!
    private var onChunk: ((String) -> Void)?
    private let tapState = TapState()
    private var observers: [NSObjectProtocol] = []
    private var started = false
    private var configObserver: NSObjectProtocol?

    /// The audio session and the engine. Throws when the engine can't start (captions still work).
    func start() throws {
        guard !started else { return }
        started = true
        let s = AVAudioSession.sharedInstance()
        try s.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker])
        try s.setActive(true, options: .notifyOthersOnDeactivation)
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: s, queue: .main) { [weak self] n in
            let type = (n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:))
            MainActor.assumeIsolated { self?.interruption(type) }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: s, queue: .main) { [weak self] n in
            let reason = (n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt).flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            guard reason == .newDeviceAvailable || reason == .oldDeviceUnavailable else { return }
            MainActor.assumeIsolated { self?.rebuild() }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: s, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.rebuild() }
        })
        try build()
    }

    func stop() {
        guard started else { return }
        started = false
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        teardown()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// From now until stopCapture(), each ~100 ms of the mic comes to `chunk` as base64 PCM16.
    func capture(_ chunk: @escaping (String) -> Void) {
        onChunk = chunk
        tapState.set(true)
    }

    func stopCapture() {
        tapState.set(false)
        onChunk = nil
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

    private func build() throws {
        let e = AVAudioEngine()
        let p = AVAudioPlayerNode()
        e.attach(p)
        if useMic {
            // Echo cancelling: Grok's voice out of the speaker isn't sent back as yours.
            try? e.inputNode.setVoiceProcessingEnabled(true)
            let input = e.inputNode
            let inFormat = input.outputFormat(forBus: 0)
            if inFormat.sampleRate > 0, inFormat.channelCount > 0, let conv = AVAudioConverter(from: inFormat, to: micFormat) {
                conv.downmix = true
                let state = tapState, target = micFormat
                input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(inFormat.sampleRate / 10), format: inFormat) { [weak self] buf, _ in
                    guard state.on, let b64 = Self.convert(buf, conv, target) else { return }
                    Task { @MainActor in self?.onChunk?(b64) }
                }
            } else {
                events?(.failed("no microphone"))
            }
        }
        e.connect(p, to: e.mainMixerNode, format: playFormat)
        p.volume = muted ? 0 : 1
        e.prepare()
        engine = e; player = p
        try e.start()
        p.play()
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: e, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.rebuild() }
        }
    }

    private func teardown() {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        if let engine {
            if useMic { engine.inputNode.removeTap(onBus: 0) }
            engine.stop()
        }
        player = nil; engine = nil
    }

    /// New hardware (AirPods in, headphones out, the media server reset): a fresh engine in the new formats.
    private func rebuild() {
        guard started else { return }
        teardown()
        do {
            try AVAudioSession.sharedInstance().setActive(true, options: .notifyOthersOnDeactivation)
            try build()
        } catch { events?(.failed(error.localizedDescription)) }
    }

    private func interruption(_ type: AVAudioSession.InterruptionType?) {
        switch type {
        case .began:
            events?(.interrupted)
            engine?.pause()
        case .ended:
            rebuild()
            events?(.resumed)
        default: break
        }
    }

    nonisolated private static func convert(_ buf: AVAudioPCMBuffer, _ conv: AVAudioConverter, _ target: AVAudioFormat) -> String? {
        let cap = AVAudioFrameCount(Double(buf.frameLength) * target.sampleRate / buf.format.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: cap) else { return nil }
        var fed = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return buf
        }
        guard err == nil, out.frameLength > 0, let ch = out.int16ChannelData else { return nil }
        return Data(bytes: ch[0], count: Int(out.frameLength) * 2).base64EncodedString()
    }
}

/// Whether the mic tap forwards (read on the audio thread).
private final class TapState: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var on: Bool { lock.lock(); defer { lock.unlock() }; return value }
    func set(_ v: Bool) { lock.lock(); value = v; lock.unlock() }
}
