// One board or DM: opens on what you saw last (cached), refreshes in place, marks itself read, and sends instantly
// (your message shows at once; if it can't be delivered it says so and you tap to retry).

import SwiftUI

struct BoardView: View {
    @EnvironmentObject var state: AppState
    let board: Board
    @State private var draft = ""
    @State private var showTasks = false
    @FocusState private var focused: Bool

    private var list: [Entry] { state.entries[board.id] ?? [] }
    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // Placeholders and messages are separate containers: sharing one list would give them colliding ids
                // (placeholder 1… and message #1…), and SwiftUI kept showing placeholders in place of messages.
                if state.entries[board.id] == nil {
                    VStack(alignment: .leading, spacing: 0) { ForEach(0..<6, id: \.self) { _ in PlaceholderMessage() } }
                        .padding(.horizontal, 16).padding(.vertical, 12)
                        .transition(.opacity)
                }
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(list.enumerated()), id: \.element.id) { i, e in
                        let prev = i > 0 ? list[i - 1] : nil
                        let grouped = prev != nil && prev!.author == e.author && prev!.via == e.via && e.ts - prev!.ts < 5 * 60_000 && e.type == "note"
                        EntryRow(e: e, grouped: grouped, mine: e.author == state.me?.owner && e.via != "agent") { Task { await state.send(e.text, to: board, retrying: e) } }
                            .id(e.id)
                            .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            .onChange(of: list.last?.id) { _, id in if let id { withAnimation(.smooth) { proxy.scrollTo(id, anchor: .bottom) } } }
        }
        .safeAreaInset(edge: .top, spacing: 0) { WorkStrip(tasks: state.tasks[board.id] ?? []) { Haptic.tap(); showTasks = true } }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .sheet(isPresented: $showTasks) { TasksSheet(board: board).presentationDetents([.medium, .large]).presentationBackground(Theme.bg) }
        .navigationTitle(board.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar) // inside a conversation the message box owns the bottom edge
        .task { async let e: Void = state.loadEntries(board); async let t: Void = state.loadTasks(board); _ = await (e, t); await state.markRead(board) }
        .onChange(of: state.pulse) { _, p in if p?.board == board.id { Task { async let e: Void = state.loadEntries(board); async let t: Void = state.loadTasks(board); _ = await (e, t); await state.markRead(board) } } }
        .refreshable { await state.loadEntries(board) }
    }

    var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(board.kind == "direct" ? "Message" : "Message \(board.title)", text: $draft, axis: .vertical)
                .lineLimit(1...6).focused($focused)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.line, lineWidth: 0.5))
                .accessibilityIdentifier("composer")
            Button(action: send) {
                Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold))
                    .frame(width: 36, height: 36)
                    .background(canSend ? Theme.accent : Theme.line, in: Circle())
                    .foregroundStyle(canSend ? .black : Theme.faint)
                    .scaleEffect(canSend ? 1 : 0.92)
                    .animation(.snappy, value: canSend)
            }
            .disabled(!canSend)
            .accessibilityIdentifier("send")
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.bar)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        Haptic.tap()
        Task { await state.send(text, to: board) }
    }
}

struct EntryRow: View {
    let e: Entry
    var grouped = false
    var mine = false
    var retry: () -> Void = {}

    private var who: String { e.byAgent ? "\(e.author)'s agent" : e.author }

    var body: some View {
        if mine { myMessage } else { theirMessage }
    }

    /// Yours: a right-aligned bubble, like any messenger.
    private var myMessage: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if e.type != "note" { Text(e.type).font(.caption2.weight(.medium)).foregroundStyle(Theme.faint) }
            Text(e.text.md)
                .font(.callout).foregroundStyle(Theme.text.opacity(e.pending == true ? 0.55 : 1))
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(Theme.raised, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .textSelection(.enabled)
            if e.pending == true {
                Text("Sending…").font(.caption2).foregroundStyle(Theme.faint)
            } else if e.failed == true {
                Button(action: retry) { Label("Not sent. Tap to retry", systemImage: "exclamationmark.circle").font(.caption2.weight(.semibold)) }
                    .buttonStyle(.plain).foregroundStyle(Theme.danger)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
        .padding(.top, grouped ? 4 : 14)
    }

    /// Everyone else (people and agents): plain text under who said it.
    private var theirMessage: some View {
        HStack(alignment: .top, spacing: 10) {
            if grouped { Color.clear.frame(width: 26, height: 1) } else { Avatar(name: e.author, agent: e.byAgent, size: 26) }
            VStack(alignment: .leading, spacing: 3) {
                if !grouped {
                    HStack(spacing: 6) {
                        Text(who).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
                        if e.type != "note" && e.type != "task" { Text(e.type).font(.caption).foregroundStyle(e.type == "question" ? Theme.warn : Theme.faint) }
                        if let to = e.to { Text("→ \(to)").font(.caption).foregroundStyle(Theme.faint) }
                        Spacer(minLength: 4)
                        Text(e.ts.ago).font(.caption2).foregroundStyle(Theme.faint)
                    }
                }
                if let a = e.artifactName { Label(a, systemImage: "doc.text").font(.caption.monospaced()).foregroundStyle(Theme.muted) }
                if e.type == "task" { TaskCard(text: e.text) } else {
                    Text(e.text.md).font(.callout).foregroundStyle(Theme.text.opacity(0.92)).textSelection(.enabled).lineSpacing(2)
                }
            }
        }
        .padding(.top, grouped ? 4 : 16)
    }
}

/// A grey stand-in while a board loads for the first time (no blank flash).
struct PlaceholderMessage: View {
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(Theme.card).frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 6) {
                RoundedRectangle(cornerRadius: 4).fill(Theme.card).frame(width: 110, height: 11)
                RoundedRectangle(cornerRadius: 4).fill(Theme.card).frame(maxWidth: .infinity).frame(height: 11)
                RoundedRectangle(cornerRadius: 4).fill(Theme.card).frame(width: 180, height: 11)
            }
        }
        .padding(.top, 16)
    }
}

/// A task posted in the chat, shown as what it is (a task with a checklist), not as raw "- [ ]" text.
struct TaskCard: View {
    let text: String
    var body: some View {
        let lines = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        let title = lines.first ?? text
        let done = lines.filter { $0.hasPrefix("- [x]") || $0.hasPrefix("- [X]") }.count
        let total = done + lines.filter { $0.hasPrefix("- [ ]") }.count
        HStack(spacing: 10) {
            Image(systemName: "circle.dashed").font(.system(size: 15)).foregroundStyle(Theme.muted)
            VStack(alignment: .leading, spacing: 2) {
                Text(title.md).font(.callout.weight(.medium)).foregroundStyle(Theme.text).lineLimit(2)
                Text(total > 0 ? "Task · \(done)/\(total) done" : "Task").font(.caption).foregroundStyle(Theme.faint)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.line, lineWidth: 0.5))
    }
}
