// Settings as a side drawer (vedu #2488): on the first screen (Chats, or Everyday's For you), pull from the left edge
// and Settings slides in with your finger, the screen moving over with it (like Discord or Telegram's side menu).
// Past half way (or a flick) it opens, short of it it springs back. The screen keeps a strip showing at the side:
// tap it or swipe it back to close (Settings' own sideways controls, its segmented pickers, keep their drags). The
// picture button top left still opens Settings as before. Only on the first screen: inside a chat the edge swipe is
// the system's Back. VoiceOver: "Open Settings" is an action on the screen, so the gesture is never the only way.

import SwiftUI

/// Closes Settings when it's in the drawer, where dismiss() has nothing to dismiss (Settings' Done uses it).
private struct CloseSettingsKey: EnvironmentKey { static let defaultValue: (() -> Void)? = nil }
extension EnvironmentValues {
    var closeSettings: (() -> Void)? {
        get { self[CloseSettingsKey.self] }
        set { self[CloseSettingsKey.self] = newValue }
    }
}

/// The drawer's motion, apart from the view so it can be tested.
enum DrawerMotion {
    /// How far in from the edge a pull may start (inside the rows' 16 pt inset, so no row loses a tap to it).
    static let edge: CGFloat = 16
    /// How much of the screen stays showing beside the open drawer (what you tap or swipe to close it).
    static let peek: CGFloat = 64
    /// The drawer's width on a screen this wide.
    static func width(for screen: CGFloat) -> CGFloat { max(240, min(screen - peek, 420)) }
    /// How open it is (0 closed, 1 open) after a drag of `dx` toward opening that started at `start`.
    static func progress(start: CGFloat, dx: CGFloat, width: CGFloat) -> CGFloat { min(1, max(0, start + dx / max(width, 1))) }
    /// Where a release settles: open if the drag (with its flick) would end past half way.
    static func settlesOpen(predicted: CGFloat) -> Bool { predicted > 0.5 }
    /// A drag counts as sideways (not a scroll) when it moves at least twice as far across as down.
    static func isSideways(_ t: CGSize) -> Bool { abs(t.width) > 2 * abs(t.height) }
}

struct SettingsDrawer: ViewModifier {
    /// Only on the first screen (nothing pushed): inside a chat the edge belongs to Back.
    let enabled: Bool
    @Environment(\.layoutDirection) private var direction
    @Environment(\.chatDensity) private var density
    @State private var progress: CGFloat = 0
    @State private var start: CGFloat?
    @State private var armed = false
    @State private var mounted = false // Settings is only built once you start to open it
    /// True while a finger is on a drag; if the system cancels the drag (onEnded never comes), this resets and the
    /// drawer settles where it is instead of staying half open.
    @GestureState private var dragging = false

    private var sign: CGFloat { direction == .rightToLeft ? -1 : 1 }

    /// The screen's width (for the drawer's), read without wrapping the screen in anything.
    @State private var screen: CGFloat = 390

    func body(content: Content) -> some View {
        let w = DrawerMotion.width(for: screen)
        // The screen itself is left as it is (no container around it, nothing over it while the drawer is shut), so
        // with a chat open the drawer changes nothing there: not its layout, hit-testing or accessibility.
        content
            .offset(x: progress * w * sign)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { screen = $0 }
            .overlay {
                // The screen beside the open drawer: dimmed; tap or swipe it to close. Only while it's out.
                if progress > 0 || mounted {
                    Color.black.opacity(0.28 * progress)
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture { settle(open: false) }
                        .gesture(drag(width: w))
                        .allowsHitTesting(progress > 0)
                        .accessibilityHidden(true)
                }
            }
            .overlay(alignment: .leading) {
                // The edge you pull from: on the first screen only. It stays while a pull is under way (taking it
                // away mid-drag would cancel the drag); it only takes new touches while the drawer is closed.
                if enabled {
                    Color.clear
                        .frame(width: DrawerMotion.edge)
                        .contentShape(Rectangle())
                        .gesture(drag(width: w))
                        .allowsHitTesting(progress == 0 || start != nil)
                        .accessibilityHidden(true)
                }
            }
            .overlay(alignment: .leading) {
                if mounted {
                    SettingsView()
                        .environment(\.closeSettings) { settle(open: false) }
                        .environment(\.chatDensity, density)
                        .background(Theme.bg)
                        .frame(width: w)
                        .frame(maxHeight: .infinity)
                        .offset(x: (progress - 1) * w * sign)
                        .shadow(color: .black.opacity(0.18 * progress), radius: 12)
                        .accessibilityIdentifier("settings-drawer")
                        .accessibilityHidden(progress == 0)
                        .transition(.identity)
                }
            }
            .accessibilityActions {
                // VoiceOver: the gesture is never the only way (first screen only).
                if enabled { Button("Open Settings") { mounted = true; settle(open: true) } }
            }
            .onChange(of: enabled) { _, on in if !on && progress > 0 { settle(open: false) } }
            .onChange(of: dragging) { _, on in
                // A drag that ended without onEnded (cancelled): settle by where it is.
                if !on, start != nil { start = nil; settle(open: progress > 0.5) }
            }
    }

    private func drag(width w: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .global)
            .updating($dragging) { _, state, _ in state = true }
            .onChanged { v in
                if start == nil {
                    // A mostly-vertical drag is a scroll, not the drawer.
                    guard DrawerMotion.isSideways(v.translation) else { return }
                    start = progress
                    mounted = true
                }
                guard let s = start else { return }
                let p = DrawerMotion.progress(start: s, dx: v.translation.width * sign, width: w)
                progress = p
                let past = p > 0.5
                if past != armed { armed = past; if past { Haptics.play(.armed) } }
            }
            .onEnded { v in
                guard let s = start else { return }
                start = nil
                let predicted = DrawerMotion.progress(start: s, dx: v.predictedEndTranslation.width * sign, width: w)
                settle(open: DrawerMotion.settlesOpen(predicted: predicted))
            }
    }

    private func settle(open: Bool) {
        armed = false
        withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) { progress = open ? 1 : 0 }
        if !open {
            // Let it slide away before Settings is taken down (it saves edits when it goes).
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(380))
                if progress == 0 { mounted = false }
            }
        }
    }
}

extension View {
    /// Settings as a drawer you pull in from the edge (only while `enabled`: the first screen, nothing pushed).
    func settingsDrawer(enabled: Bool) -> some View { modifier(SettingsDrawer(enabled: enabled)) }
}
