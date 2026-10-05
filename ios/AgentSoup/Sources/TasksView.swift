// Who's doing what, at a glance: a strip pinned at the top of a chat (what's in progress and by whom, what's next),
// and behind it the board's Work: its tasks (grouped by where they stand, filtered by whose they are, sub-tasks
// under their parent) and its files (WorkFiles.swift / DocsView.swift), one segmented control apart.

import SwiftUI

extension WorkTask {
    var statusLabel: String { Self.statusName(status) }
    /// A status in words ("doing" → "In progress"); an unknown one as the server wrote it.
    static func statusName(_ status: String) -> String {
        switch status {
        case "todo": return String(localized: "To do", bundle: .l10n)
        case "doing": return String(localized: "In progress", bundle: .l10n)
        case "blocked": return String(localized: "task-status.blocked", defaultValue: "Blocked", bundle: .l10n, comment: "A task status: it cannot move on")
        case "done": return String(localized: "Done", bundle: .l10n)
        case "stopped": return String(localized: "Stopped", bundle: .l10n)
        default: return status
        }
    }
    /// How far along its checklist is, in words: "2 of 4".
    var progress: String? { checklist.map { String(localized: "\($0.done) of \($0.total)", bundle: .l10n) } }
    /// One line under a task's title: where it stands (always first), who's on it, how far along.
    var caption: String {
        [statusLabel, who, progress].compactMap { $0 }.joined(separator: " · ")
    }
    /// Whether a checklist line is about this task ("#12 …" or its title).
    func covers(_ line: String) -> Bool {
        let norm = { (x: String) in x.lowercased().split { !$0.isLetter && !$0.isNumber }.joined(separator: " ") }
        if line.range(of: "#\(seq)(?!\\d)", options: .regularExpression) != nil { return true }
        let t = norm(title)
        return t.count > 2 && norm(line).contains(t)
    }

    var isDone: Bool { status == "done" }
    var isBlocked: Bool { status == "blocked" || status == "stopped" }
    /// Who's working on it right now (a live claim, made by an agent through its tools).
    var holder: (name: String, agent: Bool)? {
        guard let h = leaseHolder, (leaseUntil ?? 0) > Date().timeIntervalSince1970 * 1000 else { return nil }
        return (h, leaseAgent == true)
    }
    /// Whose it is right now: the holder of a live claim, else the assignee. `agent`: their agent, not them.
    var owner: (name: String, agent: Bool)? {
        if let h = leaseHolder, (leaseUntil ?? 0) > Date().timeIntervalSince1970 * 1000 { return (h, leaseAgent == true) }
        if let a = assignee { return (a, assigneeAgent == true) }
        return nil
    }
    /// The task's description: its body without the checklist lines.
    var notes: String {
        body.split(separator: "\n", omittingEmptySubsequences: false).filter { raw in
            let l = raw.trimmingCharacters(in: .whitespaces)
            return !(l.hasPrefix("- [ ]") || l.hasPrefix("- [x]") || l.hasPrefix("- [X]"))
        }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// A checklist line: ticks with a little spring when it gets done.
struct CheckLine: View {
    let text: String
    let done: Bool
    var compact = false
    @Environment(\.refTitle) private var refTitle
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .font(.system(size: compact ? 12 : 13)).foregroundStyle(done ? Theme.ok : Theme.faint)
                .contentTransition(.symbolEffect(.replace))
                .symbolEffect(.bounce, value: Effects.enabled && done) // a tick that pops (Effects)
            Text(text.mdLinked(refTitle.callAsFunction)).font(compact ? Typo.meta : Typo.secondary).foregroundStyle(done ? Theme.faint : Theme.text).strikethrough(done, color: Theme.faint).lineLimit(2)
        }
        .animation(.spring(duration: 0.35, bounce: 0.4), value: done)
    }
}

/// A sub-task under its parent: its own ring, title and who's on it.
struct SubTaskLine: View {
    let task: WorkTask
    var body: some View {
        HStack(spacing: Space.s) {
            ProgressRing(task: task).frame(width: 12, height: 12)
            Text(task.title).font(Typo.meta).foregroundStyle(task.status == "done" ? Theme.faint : Theme.text).strikethrough(task.status == "done", color: Theme.faint).lineLimit(1)
            Spacer(minLength: 6)
            if task.status != "done", let w = task.who { Text(w).font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1) }
        }
    }
}

extension Array where Element == WorkTask {
    var inProgress: [WorkTask] { filter { $0.status == "doing" }.sorted { $0.updatedAt > $1.updatedAt } }
    var next: [WorkTask] { filter { $0.status == "todo" }.sorted { ($0.priorityRank, $0.seq) < ($1.priorityRank, $1.seq) } }
    var blocked: [WorkTask] { filter { $0.status == "blocked" } }
    var done: [WorkTask] { filter { $0.status == "done" }.sorted { $0.updatedAt > $1.updatedAt } }
}

/// A small ring that fills as a task's checklist gets ticked (a spinner-ish dot when there's no checklist).
struct ProgressRing: View {
    let task: WorkTask
    @State private var pop = false // the ring completing: a small pop (Effects)
    var body: some View {
        // Done: a check. In progress: fills with the checklist (a quarter if it has none). Not started: empty.
        let p = task.status == "done" ? 1 : task.checklist.map { Double($0.done) / Double(max(1, $0.total)) } ?? (task.status == "doing" ? 0.25 : 0)
        ZStack {
            Circle().stroke(Theme.raised, lineWidth: 2)
            Circle().trim(from: 0, to: p).stroke(task.status == "done" ? Theme.ok : Theme.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(-90))
            if task.status == "done" { Image(systemName: "checkmark").font(.system(size: 7, weight: .black)).foregroundStyle(Theme.ok) }
        }
        .scaleEffect(pop ? 1.35 : 1)
        .animation(.smooth, value: p)
        .onChange(of: task.status) { old, new in
            guard new == "done", old != "done", let a = Effects.animation(.spring(duration: 0.22, bounce: 0.5)) else { return }
            withAnimation(a) { pop = true }
            Task { try? await Task.sleep(nanoseconds: 220_000_000); withAnimation(.spring(duration: 0.3)) { pop = false } }
        }
    }
}

// MARK: - Work: Tasks · Files

// (Tasks and Files are the board's tabs now, BoardTabs.swift: TasksPane and FilesPane, no sheet of their own.)

/// Whose tasks the list shows.
enum TaskFilter: String, CaseIterable, Identifiable {
    case all = "All", mine = "Mine", agent = "My agent's", unassigned = "Unassigned"
    var id: String { rawValue }
    /// What the chip says (the raw value names its accessibility identifier).
    var label: LocalizedStringKey {
        switch self {
        case .all: return "All"
        case .mine: return "Mine"
        case .agent: return "My agent's"
        case .unassigned: return "Unassigned"
        }
    }

    func matches(_ t: WorkTask, me: String?) -> Bool {
        switch self {
        case .all: return true
        case .unassigned: return t.owner == nil
        case .mine, .agent:
            guard let me else { return false }
            let agent = self == .agent
            let live = (t.leaseUntil ?? 0) > Date().timeIntervalSince1970 * 1000
            return (t.assignee == me && (t.assigneeAgent == true) == agent) || (live && t.leaseHolder == me && (t.leaseAgent == true) == agent)
        }
    }
}

/// Where a task stands, as the list groups it: In progress, Open (to do, and blocked), Done.
enum TaskGroup: String, CaseIterable, Identifiable {
    case doing, open, done
    var id: String { rawValue }
    var title: String {
        switch self {
        case .doing: return String(localized: "In progress", bundle: .l10n)
        // Its own key: "Open" is the verb (Ouvrir, खोलें, 打开…), this is the state.
        case .open: return String(localized: "task-group.open", defaultValue: "Open", bundle: .l10n,
                                  comment: "A group in the task list: not started yet (to do, and blocked); not the verb")
        case .done: return String(localized: "Done", bundle: .l10n)
        }
    }
    func holds(_ t: WorkTask) -> Bool { self == .doing ? t.status == "doing" : self == .done ? t.isDone : !(t.status == "doing" || t.isDone) }
    /// In progress: latest first. Open: blocked first, then by priority, oldest first. Done: latest first.
    func sort(_ a: WorkTask, _ b: WorkTask) -> Bool {
        switch self {
        case .open: return (a.isBlocked ? 0 : 1, a.priorityRank, a.seq) < (b.isBlocked ? 0 : 1, b.priorityRank, b.seq)
        default: return a.updatedAt > b.updatedAt
        }
    }
}

/// A board's tasks: filter chips, then In progress / Open / Done (each collapsible, with a count), sub-tasks indented
/// under their parent. Tap a row for its detail; swipe or long-press it to act on it. Embeddable anywhere: `open`
/// shows a task's detail, `add` starts a new one.
struct TasksPane: View {
    @EnvironmentObject var state: AppState
    let board: String
    let open: (Int) -> Void
    let add: () -> Void
    @State private var filter: TaskFilter = .all
    @State private var collapsed: Set<TaskGroup> = [.done]

    private var all: [WorkTask] { state.tasks[board] ?? [] }

    var body: some View {
        let me = state.me?.owner
        let shown = all.filter { filter.matches($0, me: me) }
        let ids = Set(shown.map(\.seq))
        VStack(spacing: 0) {
        chips(me: me)
        List {
            ForEach(TaskGroup.allCases) { g in
                // A task is a top-level row in its own group unless its parent is showing (then it sits under it).
                let top = shown.filter { g.holds($0) && ($0.parent.map { !ids.contains($0) } ?? true) }.sorted(by: g.sort)
                if !top.isEmpty {
                    let count = top.reduce(0) { n, t in n + 1 + shown.filter { $0.parent == t.seq }.count }
                    // Headers are rows, not section headers: plain-list section headers bring their own (large) spacing.
                    header(g, count: count, first: g == TaskGroup.allCases.first { gg in shown.contains { gg.holds($0) } })
                    if !collapsed.contains(g) {
                        ForEach(top) { t in
                            let kids = shown.filter { $0.parent == t.seq }.sorted { $0.seq < $1.seq }
                            row(t, depth: 0, kidsShown: !kids.isEmpty)
                            ForEach(kids) { s in row(s, depth: 1) }
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .environment(\.defaultMinListRowHeight, 0)
        .contentMargins(.top, 0, for: .scrollContent)
        .contentMargins(.bottom, Space.xl, for: .scrollContent)
        .overlay {
            if all.isEmpty && state.tasks[board] != nil {
                EmptyNote(icon: "checklist", title: "No tasks yet", line: "Add one, or ask an agent to.", action: ("New task", add))
            } else if shown.isEmpty && !all.isEmpty {
                EmptyNote(icon: "line.3.horizontal.decrease", title: "Nothing here", line: emptyLine, action: ("Show all", { withAnimation(.snappy) { filter = .all } }))
            } else if state.tasks[board] == nil {
                ProgressView()
            }
        }
        .refreshable { await state.loadTasks(id: board) }
        }
        .background(Theme.bg)
        .animation(.smooth(duration: 0.25), value: filter)
        .animation(.smooth(duration: 0.25), value: collapsed)
    }

    private var emptyLine: LocalizedStringKey {
        switch filter {
        case .mine: return "No tasks are yours right now."
        case .agent: return "Your agent isn't on any tasks here."
        case .unassigned: return "Every task has someone on it."
        case .all: return ""
        }
    }

    private func row(_ t: WorkTask, depth: Int, kidsShown: Bool = false) -> some View {
        Button { open(t.seq) } label: {
            TaskListRow(task: t, depth: depth, needsApproval: state.needsApproval(t, board: board), kidsShown: kidsShown)
        }
        .buttonStyle(RowPressStyle())
        .listRowInsets(EdgeInsets(top: 0, leading: Space.l, bottom: 0, trailing: Space.l))
        .listRowBackground(Theme.bg)
        .listRowSeparatorTint(Theme.line)
        .alignmentGuide(.listRowSeparatorLeading) { _ in depth == 0 ? 28 : 54 }
        .accessibilityIdentifier("task-row-\(t.title)")
        .accessibilityValue(t.caption)
        .modifier(TaskSwipes(task: t, board: board))
        .contextMenu { TaskMenu(task: t, board: board, open: { open(t.seq) }) }
    }

    private func header(_ g: TaskGroup, count: Int, first: Bool) -> some View {
        let shut = collapsed.contains(g)
        return Button {
            if shut { collapsed.remove(g) } else { collapsed.insert(g) }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.faint)
                    .rotationEffect(.degrees(shut ? 0 : 90))
                GroupGlyph(group: g).frame(width: 12, height: 12)
                Text(g.title).font(Typo.section).foregroundStyle(Theme.text)
                Text(verbatim: "\(count)").font(Typo.section).foregroundStyle(Theme.faint).monospacedDigit()
                Spacer()
            }
            .padding(.horizontal, Space.l).padding(.top, first ? 6 : 22).padding(.bottom, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets())
        .listRowBackground(Theme.bg)
        .listRowSeparator(.hidden)
        .accessibilityIdentifier("group-\(g.rawValue)")
        .accessibilityLabel(String(localized: "\(g.title), \(count) tasks", bundle: .l10n))
        .accessibilityValue(shut ? Text("collapsed") : Text("expanded"))
    }

    /// The filters, in one row. (Not a horizontal ScrollView: right under the navigation bar, iOS 26's scroll-edge
    /// effect claims it and draws it invisible. Four short chips fit a 375-pt phone.)
    private func chips(me: String?) -> some View {
            HStack(spacing: 6) {
                ForEach(TaskFilter.allCases) { f in
                    let n = all.filter { f.matches($0, me: me) && !$0.isDone }.count
                    Button { withAnimation(.snappy) { filter = f } } label: {
                        HStack(spacing: 5) {
                            Text(f.label)
                            if f != .all && n > 0 { Text(verbatim: "\(n)").monospacedDigit().foregroundStyle(filter == f ? Theme.bg.opacity(0.6) : Theme.faint) }
                        }
                        .font(Typo.meta.weight(.medium))
                        .foregroundStyle(filter == f ? Theme.bg : Theme.muted)
                        .padding(.horizontal, 11).frame(height: 28)
                        .background(filter == f ? Theme.text : Theme.card, in: Capsule())
                        .contentShape(Capsule())
                    }
                    .buttonStyle(PressStyle())
                    .accessibilityIdentifier("filter-\(f.rawValue)")
                    .accessibilityAddTraits(filter == f ? .isSelected : [])
                }
                Spacer(minLength: 0)
            }
            .lineLimit(1)
            .padding(.horizontal, Space.l).padding(.vertical, Space.s)
            .background(Theme.bg)
    }
}

/// One row in the task list: status, title, a quiet second line (blocked / needs approval, priority, when), then
/// checklist progress and whose it is. Sub-tasks sit indented under a thin guide.
struct TaskListRow: View {
    let task: WorkTask
    var depth = 0
    var needsApproval = false
    var kidsShown = false // its sub-tasks are listed right under it (so no "0/2" here)
    @Environment(\.chatDensity) private var density

    var body: some View {
        HStack(spacing: 10) {
            if depth > 0 {
                Rectangle().fill(Theme.line).frame(width: 1).padding(.leading, 7).padding(.trailing, 8)
            }
            HStack(alignment: .firstTextBaseline, spacing: 10) {
            StatusGlyph(task: task).frame(width: Metrics.glyph, height: Metrics.glyph).onFirstLine()
            VStack(alignment: .leading, spacing: 2) {
                Text(task.title)
                    .font(Typo.secondary.weight(.medium))
                    .foregroundStyle(task.isDone ? Theme.faint : Theme.text)
                    .strikethrough(task.isDone, color: Theme.faint)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    if task.isBlocked { Tag(text: task.status == "stopped" ? "Stopped" : "task-status.blocked", icon: "exclamationmark.octagon.fill", color: Theme.warn) }
                    if needsApproval { Tag(text: "Needs approval", icon: "hand.raised.fill", color: Theme.accent) }
                    if task.priority == "high" && !task.isDone { Image(systemName: "flag.fill").font(.system(size: 9)).foregroundStyle(Theme.accent).accessibilityLabel("High priority") }
                    Text(task.updatedAt.ago).foregroundStyle(Theme.faint)
                }
                .font(Typo.micro).lineLimit(1)
            }
            }
            .layoutPriority(1)
            Spacer(minLength: Space.s)
            if let c = task.checklist { ChecklistMeter(done: c.done, total: c.total) }
            if let k = task.children, k.total > 0, depth == 0, !kidsShown {
                HStack(spacing: 2) {
                    Image(systemName: "arrow.turn.down.right").font(.system(size: 9, weight: .semibold))
                    Text(verbatim: "\(k.done)/\(k.total)").monospacedDigit()
                }
                .font(Typo.micro).foregroundStyle(Theme.faint)
                .fixedSize()
                .accessibilityLabel("\(k.done) of \(k.total) sub-tasks done")
            }
            OwnerAvatar(task: task, size: 20)
        }
        .frame(minHeight: density == .compact ? (depth > 0 ? 36 : 40) : (depth > 0 ? 44 : 50))
        .contentShape(Rectangle())
    }
}

/// A tiny flag in a row's second line: "Blocked", "Needs approval".
struct Tag: View {
    let text: LocalizedStringKey
    let icon: String
    let color: Color
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: icon).font(.system(size: 8, weight: .bold))
            Text(text).fontWeight(.medium)
        }
        .foregroundStyle(color)
    }
}

/// Where a task stands, Linear-style: an empty ring (to do), a half-filled one (in progress), a stop (blocked),
/// a filled check (done).
struct StatusGlyph: View {
    let task: WorkTask
    var body: some View {
        GeometryReader { g in
            let s = g.size.width
            ZStack {
                switch task.status {
                case "done":
                    Circle().fill(Theme.ok)
                    Image(systemName: "checkmark").font(.system(size: s * 0.5, weight: .heavy)).foregroundStyle(Theme.bg)
                case "doing":
                    Circle().stroke(Theme.accent, lineWidth: 1.5)
                    HalfDisc().fill(Theme.accent).padding(s * 0.22)
                case "blocked", "stopped":
                    Circle().fill(Theme.warn.opacity(0.18))
                    Circle().stroke(Theme.warn, lineWidth: 1.5)
                    Image(systemName: "minus").font(.system(size: s * 0.5, weight: .heavy)).foregroundStyle(Theme.warn)
                default:
                    Circle().stroke(Theme.faint, style: StrokeStyle(lineWidth: 1.5, dash: [2.2, 1.6]))
                }
            }
        }
        .animation(.smooth, value: task.status)
        .accessibilityLabel(task.statusLabel)
    }
}

/// A group's glyph in its header (the same marks, without a task).
private struct GroupGlyph: View {
    let group: TaskGroup
    var body: some View {
        StatusGlyph(task: WorkTask(seq: 0, status: group == .doing ? "doing" : group == .done ? "done" : "todo", assignee: nil, assigneeAgent: nil, priority: nil, title: "", body: "", updatedAt: 0))
    }
}

/// The right half of a disc (in progress).
private struct HalfDisc: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        p.addArc(center: CGPoint(x: r.midX, y: r.midY), radius: min(r.width, r.height) / 2, startAngle: .degrees(-90), endAngle: .degrees(90), clockwise: false)
        p.closeSubpath()
        return p
    }
}

/// A checklist's progress: a small ring and "3/5" (green once it's all ticked).
struct ChecklistMeter: View {
    let done: Int
    let total: Int
    var body: some View {
        let p = Double(done) / Double(max(1, total))
        let full = done >= total
        HStack(spacing: 4) {
            ZStack {
                Circle().stroke(Theme.raised, lineWidth: 2)
                Circle().trim(from: 0, to: p).stroke(full ? Theme.ok : Theme.muted, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(-90))
            }
            .frame(width: 11, height: 11)
            Text(verbatim: "\(done)/\(total)").font(Typo.micro.weight(.medium)).monospacedDigit().foregroundStyle(full ? Theme.ok : Theme.muted)
        }
        .fixedSize()
        .animation(.smooth, value: done)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(done) of \(total) checked")
    }
}

/// Whose a task is: their avatar (an agent's is a rounded square), or a dashed ring when it's nobody's.
struct OwnerAvatar: View {
    let task: WorkTask
    var size: CGFloat = 20
    /// "theo's agent is on it", "theo", …
    private func ownerLabel(_ o: (name: String, agent: Bool)) -> String {
        let live = task.holder != nil && !task.isDone
        switch (o.agent, live) {
        case (true, true): return String(localized: "\(o.name)'s agent is on it", bundle: .l10n)
        case (true, false): return String(localized: "\(o.name)'s agent", bundle: .l10n)
        case (false, true): return String(localized: "\(o.name) is on it", bundle: .l10n)
        case (false, false): return o.name
        }
    }
    var body: some View {
        if let o = task.owner {
            Avatar(name: o.name, agent: o.agent, size: size)
                // On it right now (a live claim): a small green dot, like presence.
                .overlay(alignment: .bottomTrailing) {
                    if task.holder != nil && !task.isDone {
                        Circle().fill(Theme.ok).frame(width: size * 0.32, height: size * 0.32)
                            .overlay(Circle().stroke(Theme.bg, lineWidth: 1.5))
                            .offset(x: 2, y: 2)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(ownerLabel(o))
        } else {
            Circle().stroke(Theme.faint.opacity(0.7), style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
                .frame(width: size - 2, height: size - 2).frame(width: size, height: size)
                .accessibilityLabel("Unassigned")
        }
    }
}

/// A list row that dims a touch under your finger (the row is the target, like Mail).
struct RowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.55 : 1)
    }
}

/// A short, friendly empty state: a glyph, a line or two, one button.
struct EmptyNote: View {
    let icon: String
    let title: Text
    let line: Text?
    var action: (Text, () -> Void)? = nil
    init(icon: String, title: LocalizedStringKey, line: LocalizedStringKey, action: (LocalizedStringKey, () -> Void)? = nil) {
        self.icon = icon
        self.title = Text(title)
        self.line = Text(line)
        self.action = action.map { (Text($0.0), $0.1) }
    }
    var body: some View {
        VStack(spacing: Space.s) {
            Image(systemName: icon).font(.system(size: 22, weight: .medium)).foregroundStyle(Theme.faint)
                .frame(width: 48, height: 48).background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(.bottom, Space.xs)
            title.font(Typo.rowTitle).foregroundStyle(Theme.text)
            if let line { line.font(Typo.meta).foregroundStyle(Theme.muted).multilineTextAlignment(.center) }
            if let action {
                Button { action.1() } label: {
                    action.0.font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.text)
                        .padding(.horizontal, 14).frame(height: 30).background(Theme.raised, in: Capsule())
                }
                .buttonStyle(PressStyle())
                .padding(.top, Space.xs)
                .accessibilityIdentifier("empty-action")
            }
        }
        .padding(.horizontal, Space.xl)
        .frame(maxWidth: .infinity)
        .padding(.bottom, 40)
    }
}

// MARK: - Acting on a task from the list

/// Swipe a task in the list: right to mark it done (or reopen it), left to remove it (if it's yours to remove).
/// (No claiming from the phone: agents claim work through their tools; the list just shows who's on it.)
struct TaskSwipes: ViewModifier {
    @EnvironmentObject var state: AppState
    let task: WorkTask
    let board: String
    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .leading) {
                Button { Task { await state.setStatus(board, task, task.isDone ? "todo" : "done") } } label: {
                    Label(task.isDone ? "Reopen" as LocalizedStringKey : "Done", systemImage: task.isDone ? "arrow.uturn.backward" : "checkmark")
                }.tint(task.isDone ? Theme.faint : Theme.ok)
            }
            .swipeActions(edge: .trailing) {
                if state.canRemove(task, board: board) {
                    Button(role: .destructive) { Task { _ = await state.removeTask(board, task) } } label: { Label("Remove", systemImage: "trash") }
                        .tint(Theme.danger)
                }
            }
    }
}

/// Long-press a task: everything you can do to it.
struct TaskMenu: View {
    @EnvironmentObject var state: AppState
    let task: WorkTask
    let board: String
    let open: () -> Void
    var body: some View {
        let mine = state.holding(task)
        Button("Open", systemImage: "arrow.up.right") { open() }
        if !task.isDone && (mine || task.holder == nil) {
            Button(mine ? "Release" as LocalizedStringKey : "Claim", systemImage: mine ? "person.crop.circle.badge.minus" : "person.crop.circle.badge.plus") {
                Task { if mine { await state.release(board, task) } else { await state.claim(board, task) } }
            }
        }
        Button(task.isDone ? "Reopen" as LocalizedStringKey : "Mark done", systemImage: task.isDone ? "arrow.uturn.backward" : "checkmark.circle") {
            Task { await state.setStatus(board, task, task.isDone ? "todo" : "done") }
        }
        Menu {
            ForEach(TaskActionBar.statuses, id: \.key) { s in
                Button(s.label, systemImage: (task.status == "stopped" ? "blocked" : task.status) == s.key ? "checkmark" : s.icon) {
                    Task { await state.setStatus(board, task, s.key) }
                }
            }
        } label: { Label("Status", systemImage: "circle.lefthalf.filled") }
        Button("Copy title", systemImage: "doc.on.doc") { UIPasteboard.general.string = task.title }
        if state.canRemove(task, board: board) {
            Divider()
            Button("Remove", systemImage: "trash", role: .destructive) { Task { _ = await state.removeTask(board, task) } }
        }
    }
}

extension AppState {
    /// Whether your agent is waiting on your OK about this task (an approval it asked for, pointing at the task).
    func needsApproval(_ t: WorkTask, board: String) -> Bool { approvals.contains { $0.boardId == board && $0.seq == t.seq } }
}

// MARK: - One task

/// One task, live: where it stands and whose it is, what it's about, its checklist (tap a line to tick it), its
/// sub-tasks and what it's part of. You act on it here: claim or release it, change where it stands,
/// tick its checklist, or remove it (if you posted it or made the board). Every change shows at once and rolls back
/// if refused.
struct TaskDetail: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    let seq: Int
    let board: String
    @State private var confirmRemove = false
    @State private var approval: Approval?
    private var tasks: [WorkTask] { state.tasks[board] ?? [] }

    var body: some View {
        ScrollView {
            if let task = tasks.first(where: { $0.seq == seq }) {
                let subs = tasks.filter { $0.parent == seq }.sorted { $0.seq < $1.seq }
                VStack(alignment: .leading, spacing: 0) {
                    if let p = task.parent, let parent = tasks.first(where: { $0.seq == p }) {
                        // A destination link, not a value: the board sits in a stack whose path holds boards.
                        NavigationLink { TaskDetail(seq: p, board: board) } label: {
                            HStack(spacing: 5) {
                                Image(systemName: "arrow.turn.left.up").font(.system(size: 10, weight: .semibold))
                                Text(parent.title).lineLimit(1)
                            }
                            .font(Typo.micro.weight(.medium)).foregroundStyle(Theme.muted)
                        }
                        .buttonStyle(.plain)
                        .padding(.bottom, Space.s)
                        .accessibilityIdentifier("task-parent")
                    }
                    Text(task.title).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, Space.m)
                    TaskActionBar(task: task, board: board)
                    if let a = state.approvals.first(where: { $0.boardId == board && $0.seq == task.seq }) {
                        Button { approval = a } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "hand.raised.fill").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.accent)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text("Needs your approval").font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.text)
                                    Text(a.title).font(Typo.micro).foregroundStyle(Theme.muted).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(Theme.faint)
                            }
                            .padding(.horizontal, Space.m).padding(.vertical, 10)
                            .background(Theme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                        }
                        .buttonStyle(PressStyle())
                        .padding(.top, Space.m)
                        .accessibilityIdentifier("task-approval")
                    }
                    if !task.notes.isEmpty {
                        MarkdownText(source: task.notes, compact: true).padding(.top, Space.l)
                    }
                    checklist(task)
                    if !subs.isEmpty { subTasks(subs) }
                    Text([task.author.map { String(localized: "Added by \($0)", bundle: .l10n) }, Date().timeIntervalSince1970 - task.updatedAt / 1000 < 60 ? String(localized: "updated just now", bundle: .l10n) : String(localized: "updated \(task.updatedAt.ago) ago", bundle: .l10n)].compactMap { $0 }.joined(separator: " · ").capitalizedFirst)
                        .font(Typo.micro).foregroundStyle(Theme.faint)
                        .padding(.top, Space.xl)
                }
                .padding(.horizontal, Space.l).padding(.top, Space.s).padding(.bottom, Space.xl)
                .frame(maxWidth: .infinity, alignment: .leading)
                .animation(.smooth, value: task)
            } else {
                EmptyNote(icon: "checklist", title: "Task not found", line: "It may have been removed.").padding(.top, 80)
            }
        }
        .background(Theme.bg)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let task = tasks.first(where: { $0.seq == seq }) {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Copy title", systemImage: "doc.on.doc") { UIPasteboard.general.string = task.title }
                        if state.canRemove(task, board: board) {
                            Button("Remove task", systemImage: "trash", role: .destructive) { confirmRemove = true }
                        }
                    } label: { ToolbarIcon("ellipsis").frame(width: 32, height: 32).contentShape(Rectangle()) }
                    .accessibilityLabel("More")
                }
            }
        }
        .confirmationDialog("Remove this task?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove task", role: .destructive) {
                guard let task = tasks.first(where: { $0.seq == seq }) else { return }
                Task { if await state.removeTask(board, task) { dismiss() } }
            }
        } message: { Text("It comes off the task board for everyone. The conversation keeps a note that it was removed.") }
        .sheet(item: $approval) { a in ApprovalDetail(a: a).presentationBackground(Theme.bg) }
        // Live while it's open: pushed over the board (its Tasks tab), the board's own socket stops, so this one
        // keeps ticks and edits from others arriving here (and in the list behind it).
        .task(id: board) { if let b = state.boards.first(where: { $0.id == board }) { await state.watch(b) } }
        .onChange(of: state.pulse) { _, p in if p?.board == board { Task { await state.loadTasks(id: board) } } }
    }

    /// The checklist, in a card: a thin bar for how far along, then one row per line (the whole row ticks it).
    @ViewBuilder private func checklist(_ task: WorkTask) -> some View {
        let lines = Array(task.body.split(separator: "\n", omittingEmptySubsequences: false).enumerated()).compactMap { i, raw -> (Int, String, Bool)? in
            let l = raw.trimmingCharacters(in: .whitespaces)
            guard l.hasPrefix("- [x]") || l.hasPrefix("- [X]") || l.hasPrefix("- [ ]") else { return nil }
            return (i, String(l.dropFirst(5)).trimmingCharacters(in: .whitespaces), !l.hasPrefix("- [ ]"))
        }
        if !lines.isEmpty {
            let done = lines.filter(\.2).count
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(spacing: Space.s) {
                    Text("Checklist").font(Typo.section).foregroundStyle(Theme.muted)
                    Text(verbatim: "\(done)/\(lines.count)").font(Typo.section).monospacedDigit().foregroundStyle(done == lines.count ? Theme.ok : Theme.faint)
                    Spacer()
                }
                GeometryReader { g in
                    Capsule().fill(Theme.raised)
                        .overlay(alignment: .leading) { Capsule().fill(done == lines.count ? Theme.ok : Theme.accent).frame(width: g.size.width * Double(done) / Double(lines.count)) }
                }
                .frame(height: 3)
                .animation(.smooth, value: done)
                VStack(spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { k, item in
                        let (i, text, ticked) = item
                        // The whole line is the target (like Reminders): tap to tick, tap again to untick.
                        Button { Task { await state.toggle(board, task, line: i) } } label: {
                            HStack(alignment: .firstTextBaseline, spacing: 10) {
                                Image(systemName: ticked ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 17)).foregroundStyle(ticked ? Theme.ok : Theme.faint)
                                    .contentTransition(.symbolEffect(.replace))
                                Text(text.md).font(Typo.secondary).foregroundStyle(ticked ? Theme.faint : Theme.text)
                                    .strikethrough(ticked, color: Theme.faint)
                                    .multilineTextAlignment(.leading)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, Space.m).padding(.vertical, 11)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(RowPressStyle())
                        .animation(.spring(duration: 0.35, bounce: 0.4), value: ticked)
                        .accessibilityIdentifier("check-\(text)")
                        .accessibilityValue(ticked ? Text("done") : Text("not done"))
                        if k < lines.count - 1 { Rectangle().fill(Theme.line).frame(height: 0.5).padding(.leading, 39) }
                    }
                }
                .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                .padding(.top, Space.xs)
            }
            .padding(.top, Space.xl)
        }
    }

    private func subTasks(_ subs: [WorkTask]) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(spacing: Space.s) {
                Text("Sub-tasks").font(Typo.section).foregroundStyle(Theme.muted)
                Text(verbatim: "\(subs.filter(\.isDone).count)/\(subs.count)").font(Typo.section).monospacedDigit().foregroundStyle(Theme.faint)
            }
            VStack(spacing: 0) {
                ForEach(Array(subs.enumerated()), id: \.element.id) { k, s in
                    NavigationLink { TaskDetail(seq: s.seq, board: board) } label: {
                        HStack(spacing: 10) {
                            StatusGlyph(task: s).frame(width: 15, height: 15)
                            Text(s.title).font(Typo.secondary).foregroundStyle(s.isDone ? Theme.faint : Theme.text)
                                .strikethrough(s.isDone, color: Theme.faint).lineLimit(1)
                            Spacer(minLength: Space.s)
                            if let c = s.checklist { ChecklistMeter(done: c.done, total: c.total) }
                            OwnerAvatar(task: s, size: 18)
                            Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.faint)
                        }
                        .padding(.horizontal, Space.m).frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(RowPressStyle())
                    .accessibilityIdentifier("sub-task-\(s.title)")
                    if k < subs.count - 1 { Rectangle().fill(Theme.line).frame(height: 0.5).padding(.leading, 37) }
                }
            }
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .padding(.top, Space.xs)
        }
        .padding(.top, Space.xl)
    }
}

/// Where a task stands (a status you change from a compact menu), who's on it, and a button to take it or let it go.
struct TaskActionBar: View {
    @EnvironmentObject var state: AppState
    let task: WorkTask
    let board: String
    static var statuses: [(key: String, label: String, icon: String)] { [("todo", "circle"), ("doing", "circle.lefthalf.filled"), ("blocked", "exclamationmark.circle"), ("done", "checkmark.circle")].map { ($0.0, WorkTask.statusName($0.0), $0.1) } }

    private var color: Color { task.status == "doing" ? Theme.accent : task.isDone ? Theme.ok : task.isBlocked ? Theme.warn : Theme.muted }

    var body: some View {
        let mine = state.holding(task)
        HStack(spacing: 6) {
            Menu {
                ForEach(Self.statuses, id: \.key) { s in
                    Button { Task { await state.setStatus(board, task, s.key) } } label: {
                        Label(s.label, systemImage: (task.status == "stopped" ? "blocked" : task.status) == s.key ? "checkmark" : s.icon)
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    StatusGlyph(task: task).frame(width: 12, height: 12)
                    Text(task.statusLabel).font(Typo.meta.weight(.semibold))
                    Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).opacity(0.7)
                }
                .foregroundStyle(color)
                .padding(.horizontal, 10).frame(height: 30)
                .background(color.opacity(0.13), in: Capsule())
                .contentShape(Capsule())
            }
            .accessibilityIdentifier("task-status")
            .accessibilityValue(task.statusLabel)
            HStack(spacing: 6) {
                OwnerAvatar(task: task, size: 18)
                if task.holder != nil, !task.isDone {
                    (Text(verbatim: task.who ?? "") + Text(" is on it").foregroundStyle(Theme.muted)).font(Typo.meta.weight(.medium)).foregroundStyle(Theme.text).lineLimit(1)
                } else {
                    (task.who.map { Text(verbatim: $0) } ?? Text("Unassigned")).font(Typo.meta.weight(.medium)).foregroundStyle(task.who == nil ? Theme.faint : Theme.text).lineLimit(1)
                }
            }
            .padding(.leading, 6).padding(.trailing, 10).frame(height: 30)
            .background(Theme.card, in: Capsule())
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("task-owner")
            if task.priority == "high" {
                Image(systemName: "flag.fill").font(.system(size: 11)).foregroundStyle(Theme.accent)
                    .frame(width: 30, height: 30).background(Theme.card, in: Circle())
                    .accessibilityLabel("High priority")
            }
            Spacer(minLength: 0)
            if !task.isDone && (mine || task.holder == nil) {
                Button {
                    Task { if mine { await state.release(board, task) } else { await state.claim(board, task) } }
                } label: {
                    (mine ? Text("Release") : Text("Claim")).font(Typo.meta.weight(.semibold))
                        .padding(.horizontal, 11).frame(height: 30)
                        .background(mine ? Theme.raised : Theme.text, in: Capsule())
                        .foregroundStyle(mine ? Theme.text : Theme.bg)
                }
                .buttonStyle(PressStyle())
                .accessibilityIdentifier("task-claim")
                .accessibilityHint(mine ? Text("Let someone else take it") : Text("Take it for the next hour"))
            }
        }
    }
}

/// A new task: a title, and (optionally) the steps as a checklist. One line per item; return adds the next.
struct NewTaskSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    let board: String
    @State private var title = ""
    @State private var items: [String] = [""]
    @State private var busy = false
    @FocusState private var focus: Int?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("What needs doing?", text: $title)
                        .font(Typo.body.weight(.medium))
                        .focused($focus, equals: -1)
                        .submitLabel(.next)
                        .onSubmit { focus = 0 }
                        .accessibilityIdentifier("new-task-title")
                }
                .listRowBackground(Theme.card)
                Section {
                    ForEach(items.indices, id: \.self) { i in
                        HStack(spacing: Space.s) {
                            Image(systemName: "circle").font(.system(size: 13)).foregroundStyle(Theme.faint)
                            TextField(i == 0 ? "Add a step (optional)" as LocalizedStringKey : "Another step", text: $items[i])
                                .font(Typo.secondary)
                                .focused($focus, equals: i)
                                .submitLabel(.next)
                                .onSubmit {
                                    if !items[i].trimmingCharacters(in: .whitespaces).isEmpty {
                                        if i == items.count - 1 { items.append("") }
                                        focus = i + 1
                                    }
                                }
                        }
                    }
                } header: { SectionHeader("Checklist") }
                .listRowBackground(Theme.card)
            }
            .listSectionSpacing(.compact)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("New task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() }.toolbarText() }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        busy = true
                        Task {
                            if await state.createTask(board, title: title.trimmingCharacters(in: .whitespacesAndNewlines), checklist: items) != nil { dismiss() }
                            busy = false
                        }
                    } label: { if busy { ProgressView() } else { Text("Add") } }
                    .toolbarText(primary: true)
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                    .accessibilityIdentifier("new-task-add")
                }
            }
            .onAppear { focus = -1 }
        }
    }
}

extension String {
    /// "updated 4m ago" → "Updated 4m ago".
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
