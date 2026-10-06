// The new frame around a board (#4860, "tabs carry state"; mocks in #4863). The thread itself doesn't change.
// - BoardStateTabs: every board and DM as a tab under the header, the open one first, each with its picture, name and
//   count and a 3pt underline in its state: amber while an approval waits (its count in amber), green while agents
//   work, grey when quiet (MenuBoardStatus, shared with the Menu sheet). Tapping one opens it.
// - BoardRailSheet: the board's details as a bottom sheet from the header's rail button, Agents first, then Open
//   tasks, Decisions, Soul and Memory, Members and Notifications; its ⋯ holds what the top bar's ⋯ used to.
// The state is what the app already knows (who's live on the boards it has open, the board list's live count, pending
// approvals); the board-state API swaps in at MenuBoardStatus when it lands.

import SwiftUI

struct BoardStateTabs: View {
    @EnvironmentObject private var state: AppState
    let current: Board

    private var boards: [Board] {
        // Most recently active first, the open board included (vedu #5043), so the strip doesn't reshuffle as you switch;
        // or, with Display → Tab order "Last opened" (vedu #5192), the board you opened last first: this one.
        // The open board's live copy from the list, not the one it was opened with: its last activity moves too (#5194).
        // Each board once: a repeated id makes ForEach draw nothing it can rely on.
        var seen: Set<String> = [current.id]
        let here = state.boards.first { $0.id == current.id } ?? current
        let all = [here] + state.boards.filter { $0.archived != true && seen.insert($0.id).inserted }
        guard state.display.tabsByOpened else { return all.sorted { $0.lastActivity > $1.lastActivity } }
        let opened = { (b: Board) in b.id == current.id ? Double.infinity : b.openedAt ?? 0 }
        return all.sorted { (opened($0), $0.lastActivity) > (opened($1), $1.lastActivity) }
    }

    /// The tabs' height: fixed at a text size (taller with larger text), like the Chat · Tasks · Files row, and never
    /// derived from the scroll view's own sizing. vedu saw the strip go blank (#5046) and then vanish (#5106) on his phone
    /// while it never failed in the simulator, so nothing here depends on how a horizontal scroll view sizes or offsets its
    /// content: an explicit height on the row and on the scroll view, no vertical safe area or margins inside it (the
    /// keyboard's and the bar's insets can push its content out of view), no vertical bounce, no animation from the
    /// board list's refreshes (they reorder the tabs with withAnimation on every feed line), and each board once with a
    /// stable id. It also stays out of the navigation bar's scroll-edge blur (iOS 26+).
    @ScaledMetric(relativeTo: .subheadline) private var rowHeight: CGFloat = 34

    var body: some View {
        let tabs = boards
        let row = ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.l) {
                ForEach(tabs, id: \.id) { b in tab(b).frame(height: rowHeight) }
            }
            .frame(height: rowHeight)
            .padding(.horizontal, Space.l)
            .background(VerticalLock())
        }
        .contentMargins(.vertical, 0, for: .scrollContent)
        .scrollBounceBehavior(.basedOnSize, axes: .vertical)
        .ignoresSafeArea(.all, edges: .vertical)
        #if DEBUG
        .onScrollGeometryChange(for: [CGFloat].self) { g in [g.contentOffset.y + g.contentInsets.top, g.contentSize.height - g.containerSize.height, g.contentInsets.top + g.contentInsets.bottom] } action: { _, v in
            drift = [max(drift[0], abs(v[0])), max(drift[1], v[1]), max(drift[2], v[2])]
        }
        #endif
        .frame(height: rowHeight)
        .padding(.top, Space.xs)
        .padding(.bottom, 2) // a hair between the tabs' underlines and the Chat / Tasks / Files row (vedu #5088)
        .frame(maxWidth: .infinity)
        .background(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 0.5) }
        .background(Theme.bg)
        .transaction { $0.animation = nil }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("board-state-tabs")
        #if DEBUG
        .overlay(alignment: .topLeading) {
            Color.clear.frame(width: 1, height: 1).accessibilityElement()
                .accessibilityIdentifier("board-state-tabs-drift")
                .accessibilityValue(Text(verbatim: drift.map { String(format: "%.2f", $0) }.joined(separator: " ")))
        }
        #endif
        if #available(iOS 26.0, *) { row.scrollEdgeEffectHidden(true, for: .all) } else { row }
    }
    #if DEBUG
    /// For the UI tests (StripStaysUITests): the most the tabs ever moved up or down, how much taller than the strip
    /// their content ever was, and the vertical insets it ever had. All three stay 0.
    @State private var drift: [CGFloat] = [0, 0, 0]
    #endif

    private func tab(_ b: Board) -> some View {
        let s = MenuBoardStatus(board: b, agents: state.boardAgents[b.id], approvals: state.approvals)
        let on = b.id == current.id
        let name = state.displayName(for: b)
        return Button {
            guard !on else { return }
            Haptics.play(.touch)
            state.openRequest = b
        } label: {
            VStack(spacing: 6) {
                Spacer(minLength: 0)
                HStack(spacing: 6) {
                    BoardPicture(board: b, size: 18).accessibilityHidden(true)
                    Text(verbatim: name)
                        .font(on ? Typo.secondary.weight(.semibold) : Typo.secondary)
                        .foregroundStyle(on ? Theme.text : Theme.muted)
                        .lineLimit(1)
                    if s.approvals > 0 {
                        Text("\(s.approvals)").font(Typo.micro).monospacedDigit()
                            .foregroundStyle(Theme.warn)
                            .padding(.horizontal, 5)
                            .background(Capsule().fill(Theme.warn.opacity(0.15)))
                    } else if s.working > 0 {
                        Text("\(s.working)").font(Typo.micro).monospacedDigit().foregroundStyle(Theme.faint)
                    }
                }
                Capsule().fill(s.color).frame(height: 3)
            }
            .fixedSize(horizontal: true, vertical: false)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: name))
        .accessibilityValue(Text(verbatim: s.label))
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("state-tab-\(b.id)")
    }
}

/// Holds the tabs' scroll view still vertically (vedu #5194, #5228: the strip still moved up and down on his phone): no
/// insets from the safe area or the keyboard, no vertical bounce, and any vertical offset put straight back. SwiftUI's
/// modifiers ask for the same, but a horizontal scroll view can still take a vertical inset or offset from its
/// surroundings, so this pins the UIScrollView itself. Sideways scrolling is untouched.
private struct VerticalLock: UIViewRepresentable {
    func makeUIView(context: Context) -> Pin { Pin() }
    func updateUIView(_ v: Pin, context: Context) { v.attach() }

    final class Pin: UIView {
        private weak var scroll: UIScrollView?
        private var watch: [NSKeyValueObservation] = []

        override init(frame: CGRect) { super.init(frame: frame); isUserInteractionEnabled = false; isAccessibilityElement = false }
        required init?(coder: NSCoder) { fatalError() }
        override func didMoveToWindow() { super.didMoveToWindow(); attach() }

        func attach() {
            var v = superview
            while let s = v, !(s is UIScrollView) { v = s.superview }
            guard let s = v as? UIScrollView, s !== scroll else { return }
            scroll = s
            s.contentInsetAdjustmentBehavior = .never
            s.alwaysBounceVertical = false
            s.isDirectionalLockEnabled = true
            pin(s)
            watch = [
                s.observe(\.contentOffset) { [weak self] s, _ in MainActor.assumeIsolated { self?.pin(s) } },
                s.observe(\.contentInset) { [weak self] s, _ in MainActor.assumeIsolated { self?.pin(s) } },
            ]
        }

        private func pin(_ s: UIScrollView) {
            if s.contentInset.top != 0 || s.contentInset.bottom != 0 { s.contentInset.top = 0; s.contentInset.bottom = 0 }
            if s.contentOffset.y != 0 { s.contentOffset.y = 0 }
        }
    }
}

struct BoardRailSheet<Actions: View>: View {
    @EnvironmentObject private var state: AppState
    let board: Board
    let openTasks: Int
    /// Open tasks: to the board's Tasks tab.
    let showTasks: () -> Void
    /// Everything else in full (decisions, soul, memory, members, every agent): the board's Info.
    let showInfo: () -> Void
    /// The ⋯ menu's items (threads, Hide agents, Open all / Fold all, Talk to Atteo).
    let actions: Actions

    init(board: Board, openTasks: Int, showTasks: @escaping () -> Void, showInfo: @escaping () -> Void, @ViewBuilder actions: () -> Actions) {
        self.board = board
        self.openTasks = openTasks
        self.showTasks = showTasks
        self.showInfo = showInfo
        self.actions = actions()
    }

    private func rank(_ s: String) -> Int { s == "live" ? 0 : s == "idle" ? 1 : 2 }
    private var agents: [BoardAgent] { (state.boardAgents[board.id] ?? []).sorted { rank($0.state) < rank($1.state) } }
    private func word(_ s: String) -> String {
        switch s {
        case "live": return String(localized: "working", bundle: .l10n)
        case "idle": return String(localized: "idle", bundle: .l10n)
        default: return String(localized: "away", bundle: .l10n)
        }
    }
    private var firstOpenTask: String? {
        (state.tasks[board.id] ?? []).first { $0.status != "done" && $0.status != "stopped" && $0.status != "frozen" && $0.parent == nil }?.title
    }
    private var decisions: Int { state.decisions[board.id]?.count ?? 0 }
    private var members: [String] { state.members[board.id] ?? [] }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: Space.s) {
                    Text(verbatim: state.displayName(for: board))
                        .font(Typo.headline(20)).foregroundStyle(Theme.text).lineLimit(1)
                    Spacer(minLength: Space.s)
                    Menu { actions } label: {
                        ToolbarIcon("ellipsis").frame(width: 36, height: 36).contentShape(Rectangle())
                    }
                    .accessibilityIdentifier("rail-menu")
                    .accessibilityLabel("More")
                }
                .padding(.bottom, Space.s)
                agentsSection
                Divider().overlay(Theme.line)
                row(Vocab.pick(String(localized: "Open tasks", bundle: .l10n), String(localized: "Open to-dos", bundle: .l10n)), firstOpenTask, count: openTasks, id: "rail-tasks", action: showTasks)
                Divider().overlay(Theme.line)
                row(String(localized: "Decisions", bundle: .l10n), nil, count: decisions, id: "rail-decisions", action: showInfo)
                Divider().overlay(Theme.line)
                row(String(localized: "Soul and memory", bundle: .l10n), String(localized: "How agents work together here", bundle: .l10n), id: "rail-soul", action: showInfo)
                if board.kind != "direct" && !board.isAgentChat {
                    Divider().overlay(Theme.line)
                    row(String(localized: "Members", bundle: .l10n), members.map { state.displayName(for: $0) }.joined(separator: ", "), count: members.count, trailing: String(localized: "Manage", bundle: .l10n), id: "rail-members", action: showInfo)
                }
                Divider().overlay(Theme.line)
                VStack(alignment: .leading, spacing: Space.s) {
                    Text(String(localized: "Notifications", bundle: .l10n)).font(Typo.rowTitle).foregroundStyle(Theme.text)
                    NotifyLevelSegments(boardId: board.id)
                }
                .padding(.vertical, Space.m)
            }
            .padding(.horizontal, Space.l)
            .padding(.top, Space.l)
            .padding(.bottom, Space.xl)
        }
        .background(Theme.bg)
        .accessibilityIdentifier("board-rail-sheet")
    }

    private var agentsSection: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack {
                Text(Vocab.pick(String(localized: "Agents", bundle: .l10n), String(localized: "Assistants", bundle: .l10n)))
                    .font(Typo.rowTitle).foregroundStyle(Theme.text)
                Spacer()
                Text("\(agents.count)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
            }
            if agents.isEmpty {
                Text(Vocab.pick(String(localized: "No agents working now", bundle: .l10n), String(localized: "No assistants working now", bundle: .l10n)))
                    .font(Typo.meta).foregroundStyle(Theme.muted)
            }
            ForEach(agents.prefix(3)) { a in
                HStack(spacing: Space.s) {
                    Circle().fill(a.state == "live" ? Theme.ok : Theme.lineStrong).frame(width: 7, height: 7).accessibilityHidden(true)
                    Text(verbatim: a.name.map { "\(a.user)/\($0)" } ?? a.label)
                        .font(Typo.mono(size: 14)).foregroundStyle(Theme.text).lineLimit(1)
                    Spacer(minLength: Space.s)
                    Text(verbatim: word(a.state)).font(Typo.meta).foregroundStyle(Theme.muted)
                }
                .accessibilityElement(children: .combine)
            }
            if agents.count > 3 {
                Button(action: showInfo) {
                    Text("+\(agents.count - 3) more", bundle: .l10n).font(Typo.meta).foregroundStyle(Theme.muted)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("rail-agents-more")
            }
        }
        .padding(.vertical, Space.m)
        .accessibilityIdentifier("rail-agents")
    }

    private func row(_ title: String, _ detail: String?, count: Int? = nil, trailing: String? = nil, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Space.s) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: title).font(Typo.rowTitle).foregroundStyle(Theme.text)
                    if let detail, !detail.isEmpty {
                        Text(verbatim: detail).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                }
                Spacer(minLength: Space.s)
                if let count, count > 0 { Text("\(count)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted) }
                if let trailing { Text(verbatim: trailing).font(Typo.meta).underline().foregroundStyle(Theme.text) }
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.faint)
            }
            .padding(.vertical, Space.m)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(id)
    }
}
