// Where Atteo's voice comes out, and how loud (vedu #2384: "speaker functionality … make it louder; there's a mute but
// no speaker option"). One choice per person on this phone, the loudspeaker unless you pick the earpiece (UserDefaults
// "audio-loudspeaker"), used by voice chat (TalkAudio) and by read aloud (ReadAloud, and Talk's standby reading). With
// headphones, AirPods, a car or AirPlay the sound goes there and the speaker/earpiece choice waits for the phone again.
// Picking a device, Spotify-style (vedu #2464): one output button names where the sound is now (Phone speaker, Phone
// earpiece, AirPods, a car…) and opens a menu: the phone's speaker or earpiece, or "Bluetooth and AirPlay…", which
// opens the system's device picker. AudioOutput.describe is the pure part of that (tested).
// Louder: voice chat's .voiceChat mode plays at the quieter phone-call level, so on the loudspeaker it runs in
// .videoChat (still echo cancelled: that's the mic node's voice processing) with a little gain and a limiter after it;
// read aloud plays as media (.playback, .spokenAudio) at full volume. AudioRoutePlan is the pure part (tested).

import AVFoundation
import AVKit
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
            refreshRoute()
        }
    }
    /// Whether the phone's own speakers are the route (no headphones, AirPods, car or AirPlay): only then is there a choice.
    @Published private(set) var builtIn = true
    /// What the sound plays through now, for the output button.
    @Published private(set) var output = AudioOutput(kind: .speaker, name: AudioOutput.speakerName)
    private var changed: [(Bool) -> Void] = []
    /// Opens the system's device picker (AirPods, Bluetooth, AirPlay): set by the hidden picker the button carries.
    var openSystemPicker: (() -> Void)?
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

    /// The menu's "Phone speaker" / "Phone earpiece": the choice, and the sound comes back to the phone if it was on
    /// AirPods or a car. In a call that's an override; read aloud plays as media, which only the system picker moves.
    func pick(loudspeaker on: Bool) {
        loudspeaker = on
        guard !builtIn else { return }
        let s = AVAudioSession.sharedInstance()
        guard s.category == .playAndRecord else { openSystemPicker?(); return }
        if on {
            try? s.overrideOutputAudioPort(.speaker)
        } else {
            try? s.overrideOutputAudioPort(.none)
            if let mic = s.availableInputs?.first(where: { $0.portType == .builtInMic }) { try? s.setPreferredInput(mic) }
        }
        refreshRoute()
    }

    func refreshRoute() {
        #if targetEnvironment(simulator)
        let outputs: [(AVAudioSession.Port, String)] = [] // the simulator plays through the Mac: treat it as the phone's own
        #else
        let s = AVAudioSession.sharedInstance()
        let outputs = s.currentRoute.outputs.map { ($0.portType, $0.portName) }
        // AirPods or a car picked in the system picker after the earpiece: let their mic be used again.
        if !outputs.isEmpty, !AudioRoutePlan.builtIn(outputs.map(\.0)), s.preferredInput?.portType == .builtInMic { try? s.setPreferredInput(nil) }
        #endif
        builtIn = outputs.isEmpty || AudioRoutePlan.builtIn(outputs.map(\.0))
        output = AudioOutput.describe(outputs, loudspeaker: loudspeaker)
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

/// Where the sound is playing now, as the output button names it. Pure: `describe` is unit tested.
struct AudioOutput: Equatable {
    enum Kind: Equatable { case speaker, earpiece, headphones, airpods, bluetooth, car, airplay, other }
    let kind: Kind
    let name: String

    static var speakerName: String { String(localized: "Phone speaker") }
    static var earpieceName: String { String(localized: "Phone earpiece") }

    var symbol: String {
        switch kind {
        case .speaker: "speaker.wave.2.fill"
        case .earpiece: "ear"
        case .headphones: "headphones"
        case .airpods: "airpods"
        case .bluetooth: "hifispeaker.fill"
        case .car: "car.fill"
        case .airplay: "airplayaudio"
        case .other: "speaker.wave.2"
        }
    }

    /// The phone's own speakers show the person's choice (the route can lag behind it, or be the default before a
    /// session starts); anything else is named as iOS names it ("AirPods Pro", the car's name…).
    static func describe(_ outputs: [(AVAudioSession.Port, String)], loudspeaker: Bool) -> AudioOutput {
        let phone = AudioOutput(kind: loudspeaker ? .speaker : .earpiece, name: loudspeaker ? speakerName : earpieceName)
        guard let (port, raw) = outputs.first(where: { $0.0 != .builtInSpeaker && $0.0 != .builtInReceiver }) else { return phone }
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        switch port {
        case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE:
            return AudioOutput(kind: name.localizedCaseInsensitiveContains("AirPods") ? .airpods : .bluetooth, name: name.isEmpty ? "Bluetooth" : name)
        case .headphones, .usbAudio, .lineOut:
            return AudioOutput(kind: .headphones, name: name.isEmpty ? String(localized: "Headphones") : name)
        case .carAudio: return AudioOutput(kind: .car, name: name.isEmpty ? "CarPlay" : name)
        case .airPlay: return AudioOutput(kind: .airplay, name: name.isEmpty ? "AirPlay" : name)
        default: return AudioOutput(kind: .other, name: name.isEmpty ? String(localized: "Other device") : name)
        }
    }
}

/// The output button, Spotify-style (vedu #2464): names where Atteo plays and opens a menu: the phone's speaker (the
/// default) or earpiece, or "Bluetooth and AirPlay…" for the system's device picker. An icon in the read-aloud bar, a
/// labelled chip under the call's buttons.
struct AudioOutputButton: View {
    enum Style { case icon, chip }
    var style: Style = .icon
    @ObservedObject private var out = AudioOut.shared

    var body: some View {
        Menu {
            Section("Where Atteo plays") {
                if !out.builtIn {
                    Label(out.output.name, systemImage: "checkmark")
                }
                Button { out.pick(loudspeaker: true); Haptics.play(.touch) } label: {
                    Label(AudioOutput.speakerName, systemImage: out.builtIn && out.loudspeaker ? "checkmark" : "speaker.wave.2.fill")
                }
                .accessibilityIdentifier("audio-output-speaker")
                Button { out.pick(loudspeaker: false); Haptics.play(.touch) } label: {
                    Label(AudioOutput.earpieceName, systemImage: out.builtIn && !out.loudspeaker ? "checkmark" : "ear")
                }
                .accessibilityIdentifier("audio-output-earpiece")
                Button { out.openSystemPicker?() } label: {
                    Label("Bluetooth and AirPlay…", systemImage: "airplayaudio")
                }
                .accessibilityIdentifier("audio-output-devices")
            }
        } label: {
            switch style {
            case .icon:
                Image(systemName: out.output.symbol)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(out.output.kind == .earpiece ? Theme.muted : Theme.accent)
                    .frame(width: 28, height: 28).contentShape(Rectangle())
            case .chip:
                HStack(spacing: Space.xs) {
                    Image(systemName: out.output.symbol)
                    Text(out.output.name).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.muted)
                }
                .font(Typo.meta.weight(.medium))
                .foregroundStyle(out.output.kind == .earpiece ? Theme.text : Theme.accent)
                .padding(.horizontal, Space.m).frame(height: 36).frame(maxWidth: 240)
                .background(Theme.raised, in: Capsule())
            }
        }
        .buttonStyle(.plain)
        .background(SystemRoutePicker().frame(width: 1, height: 1).allowsHitTesting(false).accessibilityHidden(true))
        .accessibilityIdentifier("audio-output")
        .accessibilityLabel(Text("Audio output: \(out.output.name)"))
        .accessibilityValue(out.output.name)
        .accessibilityHint(Text("Double-tap to choose where Atteo plays"))
        .onAppear { out.refreshRoute() }
    }
}

/// The system's device picker (AirPods, Bluetooth, AirPlay), kept invisible: "Bluetooth and AirPlay…" opens it.
private struct SystemRoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let v = AVRoutePickerView()
        v.prioritizesVideoDevices = false
        v.tintColor = .clear
        v.activeTintColor = .clear
        v.alpha = 0.02
        AudioOut.shared.openSystemPicker = { [weak v] in
            guard let v else { return }
            func button(in view: UIView) -> UIButton? {
                if let b = view as? UIButton { return b }
                for sub in view.subviews { if let b = button(in: sub) { return b } }
                return nil
            }
            button(in: v)?.sendActions(for: .touchUpInside)
        }
        return v
    }

    func updateUIView(_ v: AVRoutePickerView, context: Context) {}
}
