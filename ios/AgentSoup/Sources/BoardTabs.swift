// A board's three tabs, Chat · Tasks · Files, under its title (vedu #2549): always on screen, so the work is easy to
// find, and a swipe pages between them (right to left goes Chat → Tasks → Files; mirrored right to left). Developer and
// Everyday share it (Everyday says To-dos). The strip is always the same height: chrome above the chat that changes
// size while the chat scrolls near its end is what froze it (vedu #2449), so nothing here can.

import SwiftUI
import UIKit

enum BoardTab: Int, CaseIterable, Identifiable {
    case chat, tasks, files
    var id: Int { rawValue }

    var label: String {
        switch self {
        case .chat: return String(localized: "Chat", bundle: .l10n)
        case .tasks: return Vocab.tasks
        case .files: return String(localized: "Files", bundle: .l10n)
        }
    }

    /// The tab a step away (nil past either end).
    func step(_ by: Int) -> BoardTab? { BoardTab(rawValue: rawValue + by) }

    /// Which tab each board was on, for as long as the app runs (opening the board again comes back to it).
    @MainActor static var remembered: [String: BoardTab] = [:]
}

/// The strip itself: a tab per part, the selected one underlined, counts where there's something to count.
struct BoardTabStrip: View {
    @Binding var tab: BoardTab
    let board: String
    let openTasks: Int
    let pick: (BoardTab) -> Void
    var newTask: (() -> Void)? = nil // on Tasks: a + at the strip's end (not in the top bar, where the title needs the room)
    /// The board's latest file or unsend: when it changes, the Files count is fetched again, whichever tab is open.
    var filesChanged: Int? = nil
    @ObservedObject private var files = FileIndex.shared

    /// 40pt at the default text size, taller with larger text: still fixed while the chat scrolls (only a text size
    /// change moves it), so it can't bring the freeze back.
    @ScaledMetric(relativeTo: .subheadline) private var height: CGFloat = 40

    var body: some View {
        HStack(spacing: 0) {
            // At the largest text sizes the three don't fit: then they scroll sideways instead of running off the edge.
            ViewThatFits(in: .horizontal) {
                tabs
                ScrollView(.horizontal, showsIndicators: false) { tabs }
            }
            Spacer(minLength: 0)
            if tab == .tasks, let newTask {
                Button(action: newTask) {
                    Image(systemName: "plus").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                        .frame(width: 36, height: 36).contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .accessibilityIdentifier("new-task")
                .accessibilityLabel(Vocab.pick(String(localized: "New task", bundle: .l10n), String(localized: "New to-do", bundle: .l10n)))
            }
        }
        .padding(.horizontal, Space.l)
        .frame(height: height, alignment: .center)
        .frame(maxWidth: .infinity)
        .background(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 0.5) }
        .background(Theme.bg)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isTabBar)
        .accessibilityIdentifier("board-tabs")
        // Knowing how many files there are before you open Files: the cached count at once, then fresh, and again
        // whenever a file is shared or unsent.
        .task(id: board) { await files.load(board) }
        .onChange(of: filesChanged) { _, _ in Task { await files.load(board) } }
    }

    private var tabs: some View {
        HStack(spacing: Space.xs) { ForEach(BoardTab.allCases) { t in item(t) } }
    }

    private func count(_ t: BoardTab) -> Int? {
        switch t {
        case .chat: return nil
        case .tasks: return openTasks
        case .files: return files.docs[board]?.count
        }
    }

    private func item(_ t: BoardTab) -> some View {
        let on = tab == t
        let n = count(t) ?? 0
        return Button { pick(t) } label: {
            // Pills (#4860): the open one filled in ink, the rest plain; the board's state is on the tabs above.
            HStack(spacing: 6) {
                Text(verbatim: t.label).font(on ? Typo.secondary.weight(.semibold) : Typo.secondary)
                    .foregroundStyle(on ? Theme.bg : Theme.muted)
                if n > 0 { Text("\(n)").font(Typo.meta).foregroundStyle(on ? Theme.bg.opacity(0.75) : Theme.faint).monospacedDigit() }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Capsule().fill(on ? Theme.text : .clear))
            .fixedSize()
            .frame(minHeight: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: t.label))
        .accessibilityValue(value(t, n))
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier(Self.identifier(t))
    }

    private func value(_ t: BoardTab, _ n: Int) -> Text {
        switch t {
        case .chat: return Text(verbatim: "")
        case .tasks: return Text("\(n) open", bundle: .l10n)
        case .files: return n > 0 ? Text("\(n) files", bundle: .l10n) : Text(verbatim: "")
        }
    }

    static func identifier(_ t: BoardTab) -> String {
        switch t {
        case .chat: return "tab-chat"
        case .tasks: return "tab-tasks"
        case .files: return "tab-files"
        }
    }
}

/// A sideways swipe that pages between the tabs. A horizontal pan only, so scrolling is untouched; never from the
/// leading edge (that's Back); in the chat only toward Tasks (a swipe the other way on a message is Reply); and in
/// Tasks and Files never on a row, whose own swipes (Done, Remove) come first.
struct TabSwipe: UIGestureRecognizerRepresentable {
    var forward: Bool // may page to the next tab
    var back: Bool // may page to the previous one
    var rtl = false
    var skipRows = false
    var page: (Int) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let g = UIPanGestureRecognizer()
        g.delegate = context.coordinator
        g.cancelsTouchesInView = true
        return g
    }

    func updateUIGestureRecognizer(_ g: UIPanGestureRecognizer, context: Context) {
        let c = context.coordinator
        c.forward = forward; c.back = back; c.rtl = rtl; c.skipRows = skipRows
    }

    func handleUIGestureRecognizerAction(_ g: UIPanGestureRecognizer, context: Context) {
        guard g.state == .ended else { return }
        let dx = g.translation(in: g.view).x, vx = g.velocity(in: g.view).x
        guard abs(dx) > 60 || (abs(dx) > 24 && abs(vx) > 500) else { return }
        // Right to left (finger moving left) is "next" in a left-to-right language.
        let next = rtl ? dx > 0 : dx < 0
        if next, forward { page(1) } else if !next, back { page(-1) }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var forward = true, back = true, rtl = false, skipRows = false

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard let p = g as? UIPanGestureRecognizer, let view = p.view else { return false }
            let v = p.velocity(in: view)
            guard abs(v.x) > abs(v.y) * 1.6 else { return false }
            let next = rtl ? v.x > 0 : v.x < 0
            guard next ? forward : back else { return false }
            // The leading edge belongs to Back.
            let x = p.location(in: nil).x, width = view.window?.bounds.width ?? UIScreen.main.bounds.width
            if rtl ? x > width - 28 : x < 28 { return false }
            if skipRows, Self.onRow(p, in: view) { return false }
            return true
        }

        /// Whether the touch is on a list row (a task or a file), or on a row's open swipe actions: they have swipes of
        /// their own. (Hit-tested from the window: the gesture's own view is SwiftUI's, not the list's ancestor.)
        static func onRow(_ p: UIPanGestureRecognizer, in view: UIView) -> Bool {
            guard let window = view.window, let hit = window.hitTest(p.location(in: window), with: nil) else { return false }
            return sequence(first: hit, next: { $0.superview }).contains { v in
                if v is UICollectionViewCell || v is UITableViewCell { return true }
                let name = String(describing: type(of: v))
                return name.contains("Swipe") || name.contains("ContextualAction")
            }
        }
    }
}
