// Who's doing what, at a glance: a strip pinned at the top of a chat (what's in progress and by whom, what's next),
// and the board's task list behind it (in progress, next, blocked, done), each with its checklist.

import SwiftUI

extension WorkTask {
    var statusLabel: String { ["todo": "To do", "doing": "In progress", "blocked": "Blocked", "done": "Done", "stopped": "Stopped"][status] ?? status }
    /// How far along its checklist is, in words: "2 of 4".
    var progress: String? { checklist.map { "\($0.done) of \($0.total)" } }
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
}

/// A checklist line: ticks with a little spring when it gets done.
struct CheckLine: View {
    let text: String
    let done: Bool
    var compact = false
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .font(.system(size: compact ? 12 : 13)).foregroundStyle(done ? Theme.ok : Theme.faint)
                .contentTransition(.symbolEffect(.replace))
            Text(text.md).font(compact ? Typo.meta : Typo.secondary).foregroundStyle(done ? Theme.faint : Theme.text).strikethrough(done, color: Theme.faint).lineLimit(2)
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

/// The strip under a chat's title: what's being worked on (and by whom), and what's next. A quiet fill, no outline.
struct WorkStrip: View {
    let tasks: [WorkTask]
    let open: () -> Void

    var body: some View {
        let doing = tasks.inProgress, next = tasks.next
        if !doing.isEmpty || !next.isEmpty {
            Button(action: open) {
                HStack(spacing: 10) {
                    if let t = doing.first ?? next.first { ProgressRing(task: t).frame(width: 16, height: 16) }
                    VStack(alignment: .leading, spacing: 1) {
                        if let t = doing.first {
                            (Text(t.title).foregroundStyle(Theme.text) + Text(t.who.map { "  \($0)" } ?? "").font(Typo.micro).foregroundStyle(Theme.muted))
                                .font(Typo.meta.weight(.semibold)).lineLimit(1)
                        }
                        if let n = next.first {
                            (Text("Next  ").foregroundStyle(Theme.faint) + Text(n.title).foregroundStyle(Theme.muted)).font(Typo.micro).lineLimit(1)
                        }
                    }
                    Spacer(minLength: Space.s)
                    Text(summary(doing: doing.count, next: next.count)).font(Typo.micro).foregroundStyle(Theme.faint).monospacedDigit()
                    Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(Theme.faint)
                }
                .padding(.horizontal, Space.m).padding(.vertical, Space.s)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(PressStyle())
            .padding(.horizontal, Space.m).padding(.top, Space.xxs).padding(.bottom, Space.xs)
            .background(Theme.bg)
            .accessibilityIdentifier("work-strip")
        }
    }

    private func summary(doing: Int, next: Int) -> String {
        [doing > 0 ? "\(doing) active" : nil, next > 0 ? "\(next) next" : nil].compactMap { $0 }.joined(separator: " · ")
    }
}

/// A small ring that fills as a task's checklist gets ticked (a spinner-ish dot when there's no checklist).
struct ProgressRing: View {
    let task: WorkTask
    var body: some View {
        // Done: a check. In progress: fills with the checklist (a quarter if it has none). Not started: empty.
        let p = task.status == "done" ? 1 : task.checklist.map { Double($0.done) / Double(max(1, $0.total)) } ?? (task.status == "doing" ? 0.25 : 0)
        ZStack {
            Circle().stroke(Theme.raised, lineWidth: 2)
            Circle().trim(from: 0, to: p).stroke(task.status == "done" ? Theme.ok : Theme.accent, style: StrokeStyle(lineWidth: 2, lineCap: .round)).rotationEffect(.degrees(-90))
            if task.status == "done" { Image(systemName: "checkmark").font(.system(size: 7, weight: .black)).foregroundStyle(Theme.ok) }
        }
        .animation(.smooth, value: p)
    }
}

/// The board's work, top to bottom: in progress (by whom), next, blocked, done.
struct TasksSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    let board: Board
    @State private var newTask = false

    var body: some View {
        let all = state.tasks[board.id] ?? []
        NavigationStack {
            List {
                section("In progress", all.inProgress, color: Theme.accent)
                section("Next", all.next, color: Theme.muted)
                section("Blocked", all.blocked, color: Theme.warn)
                section("Done", Array(all.done.prefix(8)), color: Theme.ok)
            }
            .listSectionSpacing(.compact)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Work on \(board.title)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // The board's files (every file is a versioned doc), read-only.
                    NavigationLink { FilesList(board: board.id) } label: { Image(systemName: "doc.on.doc").font(.system(size: 15, weight: .semibold)) }
                        .accessibilityLabel("Files")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Haptic.tap(); newTask = true } label: { Image(systemName: "plus").font(.system(size: 16, weight: .semibold)) }
                        .accessibilityLabel("New task")
                }
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.fontWeight(.semibold) }
            }
            .navigationDestination(for: Int.self) { seq in TaskDetail(seq: seq, board: board.id) }
            .overlay { if all.isEmpty { ContentUnavailableView("No tasks yet", systemImage: "checklist", description: Text("Tap + to add one. When agents pick up work here, it shows up with who's on it.")) } }
            .refreshable { await state.loadTasks(board) }
            .sheet(isPresented: $newTask) { NewTaskSheet(board: board.id).presentationDetents([.medium, .large]).presentationBackground(Theme.bg) }
        }
    }

    /// Top-level tasks in each section; sub-tasks sit under their parent, wherever they stand.
    @ViewBuilder private func section(_ title: String, _ list: [WorkTask], color: Color) -> some View {
        let all = state.tasks[board.id] ?? []
        let top = list.filter { t in t.parent == nil || !all.contains { $0.seq == t.parent } }
        if !top.isEmpty {
            Section {
                ForEach(top) { t in
                    NavigationLink(value: t.seq) { TaskRow(task: t) }.accessibilityIdentifier("task-row-\(t.title)").modifier(TaskSwipes(task: t, board: board.id))
                    ForEach(all.filter { $0.parent == t.seq }.sorted { $0.seq < $1.seq }) { s in
                        NavigationLink(value: s.seq) { TaskRow(task: s).padding(.leading, Space.xl) }.accessibilityIdentifier("task-row-\(s.title)").modifier(TaskSwipes(task: s, board: board.id))
                    }
                }
            } header: { Text("\(title) · \(top.count)").font(Typo.section).foregroundStyle(color).textCase(nil) }
            .listRowBackground(Theme.card)
        }
    }
}

/// Swipe a task in the list: right to mark it done (or reopen it), left to remove it (if it's yours to remove).
struct TaskSwipes: ViewModifier {
    @EnvironmentObject var state: AppState
    let task: WorkTask
    let board: String
    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .leading) {
                Button { Task { await state.setStatus(board, task, task.status == "done" ? "todo" : "done") } } label: {
                    Label(task.status == "done" ? "Reopen" : "Done", systemImage: task.status == "done" ? "arrow.uturn.backward" : "checkmark")
                }.tint(task.status == "done" ? Theme.muted : Theme.ok)
            }
            .swipeActions(edge: .trailing) {
                if state.canRemove(task, board: board) {
                    Button(role: .destructive) { Task { _ = await state.removeTask(board, task) } } label: { Label("Remove", systemImage: "trash") }
                }
            }
    }
}

/// A task in the list: ring, title, and one quiet line (who, how far along, urgent).
struct TaskRow: View {
    let task: WorkTask
    var body: some View {
        HStack(spacing: Space.m) {
            ProgressRing(task: task).frame(width: 16, height: 16)
            VStack(alignment: .leading, spacing: Space.xxs) {
                Text(task.title).font(Typo.secondary.weight(.medium)).foregroundStyle(task.status == "done" ? Theme.muted : Theme.text).lineLimit(2)
                HStack(spacing: Space.xs) {
                    Text([task.who ?? "Unassigned", task.progress].compactMap { $0 }.joined(separator: " · "))
                        .foregroundStyle(task.who == nil ? Theme.faint : Theme.muted)
                    if task.priority == "high" { Image(systemName: "flag.fill").font(.system(size: 9)).foregroundStyle(Theme.accent).accessibilityLabel("High priority") }
                }
                .font(Typo.micro).lineLimit(1)
            }
        }
    }
}

/// One task, live: who's on it, its checklist (ticking as the work gets done), its sub-tasks and what it's part of.
/// You act on it here, like on the web: claim or release it, change where it stands, tick its checklist by tapping a
/// line, or remove it (if you posted it or made the board). Every change shows at once and rolls back if refused.
struct TaskDetail: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    let seq: Int
    let board: String
    @State private var confirmRemove = false
    private var tasks: [WorkTask] { state.tasks[board] ?? [] }

    var body: some View {
        ScrollView {
            if let task = tasks.first(where: { $0.seq == seq }) {
                let subs = tasks.filter { $0.parent == seq }.sorted { $0.seq < $1.seq }
                VStack(alignment: .leading, spacing: Space.m) {
                    if let p = task.parent, let parent = tasks.first(where: { $0.seq == p }) {
                        NavigationLink(value: p) {
                            Label(parent.title, systemImage: "arrow.turn.left.up").font(Typo.micro).foregroundStyle(Theme.muted).lineLimit(1)
                        }.buttonStyle(.plain)
                    }
                    Text(task.title).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                    TaskActionBar(task: task, board: board)
                    VStack(alignment: .leading, spacing: Space.xxs) {
                        ForEach(Array(task.body.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { i, raw in
                            let line = raw.trimmingCharacters(in: .whitespaces)
                            if line.hasPrefix("- [x]") || line.hasPrefix("- [X]") || line.hasPrefix("- [ ]") {
                                let text = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                                // The whole line is the target (like Reminders): tap to tick, tap again to untick.
                                Button { Task { await state.toggle(board, task, line: i) } } label: {
                                    CheckLine(text: text, done: !line.hasPrefix("- [ ]"))
                                        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("check-\(text)")
                                .accessibilityValue(line.hasPrefix("- [ ]") ? "not done" : "done")
                            } else if !line.isEmpty {
                                Text(line.md).font(Typo.secondary).foregroundStyle(Theme.muted).padding(.vertical, Space.xxs)
                            }
                        }
                    }
                    .padding(.top, Space.xxs)
                    if !subs.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Sub-tasks · \(subs.filter { $0.status == "done" }.count) of \(subs.count) done").font(Typo.section).foregroundStyle(Theme.muted)
                            ForEach(subs) { s in NavigationLink(value: s.seq) { SubTaskLine(task: s) }.buttonStyle(.plain) }
                        }
                        .padding(.top, Space.s)
                    }
                }
                .padding(.horizontal, Space.l).padding(.vertical, Space.l)
                .animation(.smooth, value: task)
            } else {
                ContentUnavailableView("Task not found", systemImage: "checklist", description: Text("It may have been removed."))
            }
        }
        .background(Theme.bg)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let task = tasks.first(where: { $0.seq == seq }), state.canRemove(task, board: board) {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Remove task", systemImage: "trash", role: .destructive) { confirmRemove = true }
                    } label: { Image(systemName: "ellipsis").font(.system(size: 15, weight: .semibold)).frame(width: 32, height: 32).contentShape(Rectangle()) }
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
    }
}

/// Where a task stands and what you can do about it: a status you change from a compact menu, who's on it, and
/// one button to take it (or let it go).
struct TaskActionBar: View {
    @EnvironmentObject var state: AppState
    let task: WorkTask
    let board: String
    static let statuses: [(key: String, label: String, icon: String)] = [("todo", "To do", "circle"), ("doing", "In progress", "circle.lefthalf.filled"), ("blocked", "Blocked", "exclamationmark.circle"), ("done", "Done", "checkmark.circle")]

    private var color: Color { task.status == "doing" ? Theme.accent : task.status == "done" ? Theme.ok : task.status == "blocked" || task.status == "stopped" ? Theme.warn : Theme.muted }

    var body: some View {
        let mine = state.holding(task)
        HStack(spacing: Space.s) {
            Menu {
                ForEach(Self.statuses, id: \.key) { s in
                    Button { Task { await state.setStatus(board, task, s.key) } } label: {
                        Label(s.label, systemImage: (task.status == "stopped" ? "blocked" : task.status) == s.key ? "checkmark" : s.icon)
                    }
                }
            } label: {
                HStack(spacing: Space.xs) {
                    Text(task.statusLabel).font(Typo.meta.weight(.semibold))
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
                }
                .foregroundStyle(color)
                .padding(.horizontal, 10).frame(height: 28)
                .background(color.opacity(0.14), in: Capsule())
                .contentShape(Capsule())
            }
            .accessibilityIdentifier("task-status")
            .accessibilityValue(task.statusLabel)
            Text(task.who ?? "Unassigned").font(Typo.secondary).foregroundStyle(task.who == nil ? Theme.faint : Theme.muted).lineLimit(1)
            Spacer(minLength: Space.s)
            Text(task.updatedAt.ago).font(Typo.micro).foregroundStyle(Theme.faint)
            if task.status != "done" {
                Button { Task { if mine { await state.release(board, task) } else { await state.claim(board, task) } } } label: {
                    Text(mine ? "Release" : "Claim").font(Typo.meta.weight(.semibold))
                        .padding(.horizontal, Space.m).frame(height: 28)
                        .background(mine ? Theme.raised : Theme.text, in: Capsule())
                        .foregroundStyle(mine ? Theme.text : .black)
                }
                .buttonStyle(PressStyle())
                .accessibilityIdentifier("task-claim")
                .accessibilityHint(mine ? "Let someone else take it" : "Take it for the next hour")
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
                            TextField(i == 0 ? "Add a step (optional)" : "Another step", text: $items[i])
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
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        busy = true
                        Task {
                            if await state.createTask(board, title: title.trimmingCharacters(in: .whitespacesAndNewlines), checklist: items) != nil { dismiss() }
                            busy = false
                        }
                    } label: { if busy { ProgressView() } else { Text("Add").fontWeight(.semibold) } }
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                    .accessibilityIdentifier("new-task-add")
                }
            }
            .onAppear { focus = -1 }
        }
    }
}
