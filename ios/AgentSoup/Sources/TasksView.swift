// Who's doing what, at a glance: a strip pinned at the top of a chat (what's in progress and by whom, what's next),
// and the board's task list behind it (in progress, next, blocked, done), each with its checklist.

import SwiftUI

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
            .navigationDestination(for: WorkTask.self) { t in TaskDetail(task: t) }
            .overlay { if all.isEmpty { ContentUnavailableView("No tasks yet", systemImage: "checklist", description: Text("When agents pick up work here, it shows up with who's on it.")) } }
            .refreshable { await state.loadTasks(board) }
        }
    }

    @ViewBuilder private func section(_ title: String, _ list: [WorkTask], color: Color) -> some View {
        if !list.isEmpty {
            Section {
                ForEach(list) { t in NavigationLink(value: t) { TaskRow(task: t) } }
            } header: { Text("\(title) · \(list.count)").font(.footnote.weight(.semibold)).foregroundStyle(color) }
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
                    if task.priority == "high" { Text("high").foregroundStyle(Theme.danger) }
                    Text(task.updatedAt.ago).foregroundStyle(Theme.faint)
                }
                .font(.caption)
            }
        }
        .padding(.vertical, 2)
    }
}

/// One task: who's on it, and its checklist / plan (read-only here; agents and people edit it on the board).
struct TaskDetail: View {
    let task: WorkTask
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(task.title).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                HStack(spacing: 8) {
                    Pill(text: task.status == "doing" ? "in progress" : task.status, color: task.status == "doing" ? Theme.accent : task.status == "done" ? Theme.ok : task.status == "blocked" ? Theme.warn : Theme.muted)
                    if let w = task.who { Text(w).font(.subheadline).foregroundStyle(Theme.accent) }
                    Spacer()
                    Text("#\(task.seq) · \(task.updatedAt.ago)").font(.caption).foregroundStyle(Theme.faint)
                }
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(task.body.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, raw in
                        let line = raw.trimmingCharacters(in: .whitespaces)
                        if line.hasPrefix("- [x]") || line.hasPrefix("- [X]") || line.hasPrefix("- [ ]") {
                            let done = !line.hasPrefix("- [ ]")
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: done ? "checkmark.circle.fill" : "circle").foregroundStyle(done ? Theme.ok : Theme.faint)
                                Text(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces).md).foregroundStyle(done ? Theme.muted : Theme.text).strikethrough(done, color: Theme.faint)
                            }
                            .font(.subheadline)
                        } else if !line.isEmpty {
                            Text(line.md).font(.subheadline).foregroundStyle(Theme.muted)
                        }
                    }
                }
            }
            .padding(20)
        }
        .background(Theme.bg)
        .navigationBarTitleDisplayMode(.inline)
    }
}
