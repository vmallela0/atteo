// How the app feels (ios/qa/design/haptics/RESEARCH.md, #1053): one Haptics service, named by what happened (sent,
// reacted, approved, denied, ticked, completed, failed, shipped…), with an off switch per device (Settings → Haptics
// & effects). Nothing buzzes for plain navigation, scrolling or other people's messages. Effects (confetti on a ship,
// a ring that pops when a task completes, a check that bounces) follow their own switch and Reduce Motion.

import SwiftUI
import UIKit

enum Haptics {
    /// What happened: one feeling per meaning, so it's learned.
    enum Kind {
        case sent // you sent something (on tap, not when the server answers)
        case reacted // your reaction went on
        case approved, denied // an approval, a vote: yes / no
        case ticked // a checklist line ticked or unticked
        case completed // a task done, something made or saved
        case copied // copied to the clipboard
        case failed // it didn't work
        case warning // asks for attention (a destructive choice, a block)
        case armed // a swipe crossed its threshold (it will do something on release)
        case shipped // a shipped change card arrived
        case touch // a physical control: a toggle, a picker
    }

    static let key = "haptics"
    /// Per device (UserDefaults, not synced): on unless switched off in Settings.
    static var enabled: Bool { UserDefaults.standard.object(forKey: key) as? Bool ?? true }

    private static var last: (kind: Kind, at: Date)?

    /// Plays it (nothing when Haptics is off). Two within about 100 ms collapse into the first.
    @MainActor static func play(_ k: Kind) {
        guard enabled else { return }
        let now = Date()
        if let l = last, now.timeIntervalSince(l.at) < 0.1 { return }
        last = (k, now)
        switch k {
        case .sent: UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        case .reacted: UIImpactFeedbackGenerator(style: .rigid).impactOccurred(intensity: 0.6)
        case .approved, .completed, .copied: UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .denied, .warning: UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case .failed: UINotificationFeedbackGenerator().notificationOccurred(.error)
        case .ticked: UISelectionFeedbackGenerator().selectionChanged()
        case .armed, .touch: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .shipped: shipped()
        }
    }

    /// The shipped celebration: three soft taps ramping up, then a success (about the length of the confetti).
    @MainActor private static func shipped() {
        let soft = UIImpactFeedbackGenerator(style: .soft)
        soft.prepare()
        for (i, v) in [0.4, 0.65, 0.9].enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.12) { soft.impactOccurred(intensity: v) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    }
}

/// Celebrations and extra animation: on unless switched off, and never with Reduce Motion.
enum Effects {
    static let key = "effects"
    static var preference: Bool { UserDefaults.standard.object(forKey: key) as? Bool ?? true }
    static var enabled: Bool {
        #if DEBUG
        if API.environment("STILL") != nil { return false } // UI tests: nothing that keeps the app from going idle
        #endif
        return preference && !UIAccessibility.isReduceMotionEnabled
    }
    /// An animation for an effect, or nil (no animation) when effects are off.
    static func animation(_ a: Animation) -> Animation? { enabled ? a : nil }
}

/// About a second of confetti over whatever it's on (only when effects are on). Draws itself, then goes.
struct Confetti: View {
    let trigger: Int // bump it to fire
    @State private var start: Date?
    private static let colors: [Color] = [Theme.accent, Theme.ok, Theme.warn, Color(red: 0.35, green: 0.55, blue: 0.95), Color(red: 0.85, green: 0.4, blue: 0.75)]
    private static let pieces: [(x: Double, vx: Double, vy: Double, spin: Double, c: Int)] = (0..<36).map { i in
        let r = { (n: Int) in Double((i * 7919 + n * 104_729) % 1000) / 1000 }
        return (r(1), (r(2) - 0.5) * 220, -260 - r(3) * 260, (r(4) - 0.5) * 12, i % 5)
    }

    var body: some View {
        TimelineView(.animation(paused: start == nil)) { tl in
            Canvas { ctx, size in
                guard let start else { return }
                let t = tl.date.timeIntervalSince(start)
                guard t < 1.3 else { return }
                for p in Self.pieces {
                    let x = p.x * size.width + p.vx * t
                    let y = size.height * 0.55 + p.vy * t + 0.5 * 900 * t * t
                    var c = ctx
                    c.opacity = max(0, 1 - t / 1.3)
                    c.translateBy(x: x, y: y)
                    c.rotate(by: .radians(p.spin * t))
                    c.fill(Path(CGRect(x: -3, y: -5, width: 6, height: 10)), with: .color(Self.colors[p.c]))
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onChange(of: trigger) { _, _ in
            guard Effects.enabled else { return }
            start = Date()
            Task { try? await Task.sleep(nanoseconds: 1_400_000_000); start = nil }
        }
    }
}

/// Settings → Haptics & effects: both per device (this phone's feel, not your account's).
struct FeelSection: View {
    @AppStorage(Haptics.key) private var haptics = true
    @AppStorage(Effects.key) private var effects = true
    @State private var reduceMotion = UIAccessibility.isReduceMotionEnabled

    var body: some View {
        Section {
            Toggle("Haptics", isOn: $haptics).tint(Theme.accent)
                .onChange(of: haptics) { _, on in if on { Haptics.play(.touch) } }
                .accessibilityIdentifier("haptics-toggle")
            Toggle("Effects", isOn: Binding(get: { effects && !reduceMotion }, set: { effects = $0 })).tint(Theme.accent)
                .disabled(reduceMotion)
                .accessibilityIdentifier("effects-toggle")
        } header: { SectionHeader("Haptics & effects") } footer: {
            Text(reduceMotion
                 ? "Taps and buzzes for sends, approvals and finished work. Effects are off because Reduce Motion is on."
                 : "Taps and buzzes for sends, approvals and finished work (your iPhone's System Haptics setting still applies). Effects: celebrations and extra animation. Both are for this phone only.")
        }
        .listRowBackground(Theme.card)
        .onReceive(NotificationCenter.default.publisher(for: UIAccessibility.reduceMotionStatusDidChangeNotification)) { _ in
            reduceMotion = UIAccessibility.isReduceMotionEnabled
        }
    }
}
