// Where Atteo's voice comes out, and how loud (vedu #2384: "speaker functionality … make it louder; there's a mute but
// no speaker option"). One choice per person on this phone, the loudspeaker unless you pick the earpiece (UserDefaults
// "audio-loudspeaker"), used by voice chat (TalkAudio) and by read aloud (ReadAloud, and Talk's standby reading). With
// headphones, AirPods, a car or AirPlay the sound goes there and the choice doesn't apply, so the button hides.
// Louder: voice chat's .voiceChat mode plays at the quieter phone-call level, so on the loudspeaker it runs in
// .videoChat (still echo cancelled: that's the mic node's voice processing) with a little gain and a limiter after it;
// read aloud plays as media (.playback, .spokenAudio) at full volume. AudioRoutePlan is the pure part (tested).

import AVFoundation
import SwiftUI

/// The person's choice: loudspeaker (default) or earpiece. Observed by the buttons; read by the audio code.
@MainActor
final class AudioOut: ObservableObject {
    static let shared = AudioOut()
    static let key = "audio-loudspeaker"

    @Published var loudspeaker: Bool {
        didSet {
            guard loudspeaker != oldValue else { return }
            UserDefaults.standard.set(loudspeaker, forKey: Self.key)
            changed.forEach { $0(loudspeaker) }
        }
    }
    /// Whether the phone's own speakers are the route (no headphones, AirPods, car or AirPlay): only then is there a choice.
    @Published private(set) var builtIn = true
    private var changed: [(Bool) -> Void] = []
    private var observer: NSObjectProtocol?

    init() {
        loudspeaker = UserDefaults.standard.object(forKey: Self.key) as? Bool ?? true
        refreshRoute()
        observer = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshRoute() }
        }
    }

    /// Called whenever the choice flips (the audio that's playing moves at once).
    func onChange(_ f: @escaping (Bool) -> Void) { changed.append(f) }

    func toggle() { loudspeaker.toggle() }

    func refreshRoute() {
        #if targetEnvironment(simulator)
        builtIn = true // the simulator's route is the Mac's output, which isn't a phone speaker
        #else
        builtIn = AudioRoutePlan.builtIn(AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portType))
        #endif
    }
}

/// What to ask AVAudioSession for: pure, so it's unit tested.
struct AudioRoutePlan: Equatable {
    enum Purpose { case talk, readAloud }

    let category: AVAudioSession.Category
    let mode: AVAudioSession.Mode
    let options: AVAudioSession.CategoryOptions
    /// Force the loudspeaker (.speaker) or leave it to the category (.none).
    let override: AVAudioSession.PortOverride
    /// Extra gain on voice chat's player (dB), with a limiter after it so it never clips.
    let gainDB: Float

    static func plan(_ purpose: Purpose, loudspeaker: Bool) -> AudioRoutePlan {
        switch purpose {
        case .talk:
            var o: AVAudioSession.CategoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP]
            if loudspeaker { o.insert(.defaultToSpeaker) }
            return AudioRoutePlan(category: .playAndRecord, mode: loudspeaker ? .videoChat : .voiceChat, options: o,
                                  override: loudspeaker ? .speaker : .none, gainDB: loudspeaker ? 6 : 0)
        case .readAloud:
            // Media plays on the loudspeaker at full volume; the earpiece needs playAndRecord (nothing is recorded).
            return loudspeaker
                ? AudioRoutePlan(category: .playback, mode: .spokenAudio, options: [.duckOthers], override: .none, gainDB: 0)
                : AudioRoutePlan(category: .playAndRecord, mode: .default, options: [.duckOthers, .allowBluetoothA2DP], override: .none, gainDB: 0)
        }
    }

    /// Only the phone's own speaker or earpiece: anything else (headphones, AirPods, car, AirPlay) keeps the sound.
    static func builtIn(_ outputs: [AVAudioSession.Port]) -> Bool {
        !outputs.isEmpty && outputs.allSatisfy { $0 == .builtInSpeaker || $0 == .builtInReceiver }
    }

    /// Whether to override to the loudspeaker now: wanted, and the sound is on the earpiece (never over AirPods & co).
    static func shouldOverride(loudspeaker: Bool, outputs: [AVAudioSession.Port]) -> Bool {
        loudspeaker && outputs.contains(.builtInReceiver)
    }

    /// Applies it to the shared session (and moves the sound at once when the phone's own speakers are the route).
    func apply(active: Bool = true) {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(category, mode: mode, options: options)
        if active { try? s.setActive(true) }
        if category == .playAndRecord, AudioRoutePlan.builtIn(s.currentRoute.outputs.map(\.portType)) {
            try? s.overrideOutputAudioPort(override)
        }
    }
}

/// The loudspeaker / earpiece switch, as a small icon (the read-aloud bar) or a labelled chip ("Speaker" / "Earpiece", voice chat).
struct SpeakerToggle: View {
    enum Style { case icon, chip }
    var style: Style = .icon
    @ObservedObject private var out = AudioOut.shared

    var body: some View {
        if out.builtIn {
            Button { out.toggle(); Haptics.play(.touch) } label: {
                switch style {
                case .icon:
                    Image(systemName: out.loudspeaker ? "speaker.wave.3.fill" : "ear")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(out.loudspeaker ? Theme.accent : Theme.muted)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                case .chip:
                    Label(out.loudspeaker ? "Speaker" : "Earpiece", systemImage: out.loudspeaker ? "speaker.wave.3.fill" : "ear")
                        .font(Typo.meta.weight(.medium))
                        .foregroundStyle(out.loudspeaker ? Theme.accent : Theme.text)
                        .padding(.horizontal, Space.m).frame(height: 36)
                        .background(Theme.raised, in: Rectangle())
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("speaker-toggle")
            .accessibilityLabel(out.loudspeaker ? "Speaker on" : "Speaker off")
            .accessibilityValue(out.loudspeaker ? "Loudspeaker" : "Earpiece")
            .accessibilityHint(out.loudspeaker ? "Double-tap to hear Atteo through the earpiece instead" : "Double-tap to hear Atteo through the loudspeaker")
        }
    }
}
