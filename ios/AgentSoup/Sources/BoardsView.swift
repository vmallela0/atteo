// One board or DM: opens on what you saw last (cached), refreshes in place, marks itself read, and sends instantly
// (your message shows at once; if it can't be delivered it says so and you tap to retry).

import SwiftUI

struct BoardView: View {
    @EnvironmentObject var state: AppState
    let board: Board
    @State private var draft = ""
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
                        EntryRow(e: e, grouped: grouped) { Task { await state.send(e.text, to: board, retrying: e) } }
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
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .navigationTitle(board.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar) // inside a conversation the message box owns the bottom edge
        .task { await state.loadEntries(board); await state.markRead(board) }
        .onChange(of: state.pulse) { _, p in if p?.board == board.id { Task { await state.loadEntries(board); await state.markRead(board) } } }
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
    var retry: () -> Void = {}

    private var who: String { e.byAgent ? "\(e.author)'s agent" : e.author }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if grouped { Color.clear.frame(width: 28, height: 1) } else { Avatar(name: e.author, agent: e.byAgent, size: 28) }
            VStack(alignment: .leading, spacing: 3) {
                if !grouped {
                    HStack(spacing: 6) {
                        Text(who).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
                        if e.type != "note" { Pill(text: e.type, color: e.type == "question" ? Theme.warn : e.type == "decision" ? Theme.ok : Theme.accent) }
                        if let to = e.to { Text("→ \(to)").font(.caption).foregroundStyle(Theme.faint) }
                        Spacer(minLength: 4)
                        Text(e.ts.ago).font(.caption2).foregroundStyle(Theme.faint)
                    }
                }
                if let a = e.artifactName { Label(a, systemImage: "doc.text").font(.caption.monospaced()).foregroundStyle(Theme.accent) }
                Text(e.text.md).font(.subheadline).foregroundStyle(Theme.text.opacity(e.pending == true ? 0.5 : 0.88)).textSelection(.enabled)
                if e.pending == true {
                    Text("Sending…").font(.caption2).foregroundStyle(Theme.faint)
                } else if e.failed == true {
                    Button(action: retry) { Label("Not sent. Tap to retry", systemImage: "exclamationmark.circle").font(.caption2.weight(.semibold)) }
                        .buttonStyle(.plain).foregroundStyle(Theme.danger)
                }
            }
        }
        .padding(.top, grouped ? 3 : 14)
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
