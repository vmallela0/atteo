// Who's doing what, at a glance: a strip pinned at the top of a chat (what's in progress and by whom, what's next),
// and the board's task list behind it (in progress, next, blocked, done), each with its checklist.

import SwiftUI

extension WorkTask {
    var statusLabel: String { ["todo": "To do", "doing": "In progress", "blocked": "Blocked", "done": "Done", "stopped": "Stopped"][status] ?? status }
    /// One line under a task's title: where it stands, who's on it, how far along.
    var caption: String {
        [statusLabel, who, checklist.map { "\($0.done)/\($0.total)" }, children.map { "\($0.done)/\($0.total) sub-tasks" }].compactMap { $0 }.joined(separator: " · ")
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
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 13)).foregroundStyle(done ? Theme.ok : Theme.faint)
                .contentTransition(.symbolEffect(.replace))
            Text(text.md).font(.subheadline).foregroundStyle(done ? Theme.muted : Theme.text).strikethrough(done, color: Theme.faint).lineLimit(2)
        }
        .animation(.spring(duration: 0.35, bounce: 0.4), value: done)
    }
}

/// A sub-task under its parent: its own ring, title and who's on it.
struct SubTaskLine: View {
    let task: WorkTask
    var body: some View {
        HStack(spacing: 8) {
            ProgressRing(task: task).frame(width: 13, height: 13)
            Text(task.title).font(.subheadline).foregroundStyle(task.status == "done" ? Theme.muted : Theme.text).strikethrough(task.status == "done", color: Theme.faint).lineLimit(1)
            Spacer(minLength: 6)
            if task.status != "done", let w = task.who { Text(w).font(.caption).foregroundStyle(Theme.faint).lineLimit(1) }
        }
    }
}

extension Array where Element == WorkTask {
    var inProgress: [WorkTask] { filter { $0.status == "doing" }.sorted { $0.updatedAt > $1.updatedAt } }
    var next: [WorkTask] { filter { $0.status == "todo" }.sorted { ($0.priorityRank, $0.seq) < ($1.priorityRank, $1.seq) } }
    var blocked: [WorkTask] { filter { $0.status == "blocked" } }
    var done: [WorkTask] { filter { $0.status == "done" }.sorted { $0.updatedAt > $1.updatedAt } }
}

/// The strip under a chat's title: one line for what's being worked on (and by whom), one for what's next.
struct WorkStrip: View {
    let tasks: [WorkTask]
    let open: () -> Void

    var body: some View {
        let doing = tasks.inProgress, next = tasks.next
        if !doing.isEmpty || !next.isEmpty {
            Button(action: open) {
                VStack(alignment: .leading, spacing: 6) {
                    if let t = doing.first {
                        HStack(spacing: 8) {
                            ProgressRing(task: t).frame(width: 14, height: 14)
                            Text(t.title).font(.footnote.weight(.semibold)).foregroundStyle(Theme.text).lineLimit(1)
                            Spacer(minLength: 6)
                            if let w = t.who { Text(w).font(.caption).foregroundStyle(Theme.muted).lineLimit(1) }
                        }
                    }
                    HStack(spacing: 8) {
                        if let n = next.first {
                            Image(systemName: "arrow.turn.down.right").font(.caption2).foregroundStyle(Theme.faint).frame(width: 14)
                            (Text("Next: ").foregroundStyle(Theme.faint) + Text(n.title).foregroundStyle(Theme.muted)).font(.caption).lineLimit(1)
                        }
                        Spacer(minLength: 6)
                        Text(summary(doing: doing.count, next: next.count)).font(.caption2).foregroundStyle(Theme.faint)
                        Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(Theme.faint)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.line, lineWidth: 0.5))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 6)
            .background(Theme.bg)
            .accessibilityIdentifier("work-strip")
        }
    }

    private func summary(doing: Int, next: Int) -> String {
        [doing > 0 ? "\(doing) in progress" : nil, next > 0 ? "\(next) next" : nil].compactMap { $0 }.joined(separator: " · ")
    }
}

/// A small ring that fills as a task's checklist gets ticked (a spinner-ish dot when there's no checklist).
struct ProgressRing: View {
    let task: WorkTask
    var body: some View {
        // Done: a check. In progress: fills with the checklist (a quarter if it has none). Not started: empty.
        let p = task.status == "done" ? 1 : task.checklist.map { Double($0.done) / Double(max(1, $0.total)) } ?? (task.status == "doing" ? 0.25 : 0)
        ZStack {
            Circle().stroke(Theme.line, lineWidth: 2)
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

    var body: some View {
        let all = state.tasks[board.id] ?? []
        NavigationStack {
            List {
                section("In progress", all.inProgress, color: Theme.accent)
                section("Next", all.next, color: Theme.faint)
                section("Blocked", all.blocked, color: Theme.warn)
                section("Done", Array(all.done.prefix(8)), color: Theme.ok)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Work on \(board.title)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.fontWeight(.semibold) } }
            .navigationDestination(for: Int.self) { seq in TaskDetail(seq: seq, board: board.id) }
            .overlay { if all.isEmpty { ContentUnavailableView("No tasks yet", systemImage: "checklist", description: Text("When agents pick up work here, it shows up with who's on it.")) } }
            .refreshable { await state.loadTasks(board) }
        }
    }

    /// Top-level tasks in each section; sub-tasks sit under their parent, wherever they stand.
    @ViewBuilder private func section(_ title: String, _ list: [WorkTask], color: Color) -> some View {
        let all = state.tasks[board.id] ?? []
        let top = list.filter { t in t.parent == nil || !all.contains { $0.seq == t.parent } }
        if !top.isEmpty {
            Section {
                ForEach(top) { t in
                    NavigationLink(value: t.seq) { TaskRow(task: t) }
                    ForEach(all.filter { $0.parent == t.seq }.sorted { $0.seq < $1.seq }) { s in
                        NavigationLink(value: s.seq) { TaskRow(task: s).padding(.leading, 24) }
                    }
                }
            } header: { Text("\(title) · \(top.count)").font(.footnote.weight(.semibold)).foregroundStyle(color) }
            .listRowBackground(Theme.card)
        }
    }
}

struct TaskRow: View {
    let task: WorkTask
    var body: some View {
        HStack(spacing: 10) {
            ProgressRing(task: task).frame(width: 16, height: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(task.title).font(.subheadline.weight(.medium)).foregroundStyle(task.status == "done" ? Theme.muted : Theme.text).lineLimit(2)
                HStack(spacing: 6) {
                    Text(task.who ?? "unassigned").foregroundStyle(task.who == nil ? Theme.faint : Theme.muted)
                    if let c = task.checklist { Text("\(c.done)/\(c.total)").foregroundStyle(Theme.faint).monospacedDigit() }
                    if let c = task.children { Label("\(c.done)/\(c.total)", systemImage: "arrow.turn.down.right").labelStyle(.titleAndIcon).foregroundStyle(Theme.faint).monospacedDigit() }
                    if task.priority == "high" { Text("high").foregroundStyle(Theme.danger) }
                    Text(task.updatedAt.ago).foregroundStyle(Theme.faint)
                }
                .font(.caption)
            }
        }
        .padding(.vertical, 2)
    }
}

/// One task, live: who's on it, its checklist (ticking as the work gets done), its sub-tasks and what it's part of.
/// Read-only here; agents and people edit it on the board.
struct TaskDetail: View {
    @EnvironmentObject var state: AppState
    let seq: Int
    let board: String
    private var tasks: [WorkTask] { state.tasks[board] ?? [] }

    var body: some View {
        ScrollView {
            if let task = tasks.first(where: { $0.seq == seq }) {
                let subs = tasks.filter { $0.parent == seq }.sorted { $0.seq < $1.seq }
                VStack(alignment: .leading, spacing: 14) {
                    if let p = task.parent, let parent = tasks.first(where: { $0.seq == p }) {
                        NavigationLink(value: p) {
                            Label(parent.title, systemImage: "arrow.turn.left.up").font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                        }.buttonStyle(.plain)
                    }
                    Text(task.title).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                    HStack(spacing: 8) {
                        Pill(text: task.statusLabel.lowercased(), color: task.status == "doing" ? Theme.accent : task.status == "done" ? Theme.ok : task.status == "blocked" ? Theme.warn : Theme.muted)
                        if let w = task.who { Text(w).font(.subheadline).foregroundStyle(Theme.accent) }
                        Spacer()
                        Text("#\(task.seq) · \(task.updatedAt.ago)").font(.caption).foregroundStyle(Theme.faint)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(Array(task.body.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, raw in
                            let line = raw.trimmingCharacters(in: .whitespaces)
                            if line.hasPrefix("- [x]") || line.hasPrefix("- [X]") || line.hasPrefix("- [ ]") {
                                CheckLine(text: String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces), done: !line.hasPrefix("- [ ]"))
                            } else if !line.isEmpty {
                                Text(line.md).font(.subheadline).foregroundStyle(Theme.muted)
                            }
                        }
                    }
                    if !subs.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Sub-tasks · \(subs.filter { $0.status == "done" }.count)/\(subs.count)").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
                            ForEach(subs) { s in NavigationLink(value: s.seq) { SubTaskLine(task: s) }.buttonStyle(.plain) }
                        }
                        .padding(.top, 6)
                    }
                }
                .padding(20)
                .animation(.smooth, value: task)
            } else {
                ContentUnavailableView("Task not found", systemImage: "checklist", description: Text("It may have been retracted."))
            }
        }
        .background(Theme.bg)
        .navigationBarTitleDisplayMode(.inline)
    }
}
