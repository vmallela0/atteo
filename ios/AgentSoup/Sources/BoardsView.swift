// Boards and DMs, most recent first, each with who spoke last; open one to read and post (as you).

import SwiftUI

struct BoardsView: View {
    @EnvironmentObject var state: AppState
    @State private var query = ""
    @State private var path: [Board] = []

    var shown: [Board] {
        query.isEmpty ? state.boards : state.boards.filter { $0.title.localizedCaseInsensitiveContains(query) || ($0.last?.text.localizedCaseInsensitiveContains(query) ?? false) }
    }

    var body: some View {
        NavigationStack(path: $path) {
            List(shown) { b in
                NavigationLink(value: b) { BoardRow(b: b) }
                    .listRowBackground(Theme.bg)
                    .listRowSeparatorTint(Theme.line)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Boards")
            .searchable(text: $query, prompt: "Search boards")
            .refreshable { await state.refreshBoards() }
            .navigationDestination(for: Board.self) { b in BoardView(board: b) }
            .onChange(of: state.boards.count) { _, _ in
                #if DEBUG
                // Simulator screenshots: AGENT_SOUP_OPEN_BOARD opens that board once the list loads.
                if path.isEmpty, let id = ProcessInfo.processInfo.environment["AGENT_SOUP_OPEN_BOARD"], let b = state.boards.first(where: { $0.id == id }) { path = [b] }
                #endif
            }
            .overlay { if state.boards.isEmpty { ContentUnavailableView("No boards yet", systemImage: "bubble.left.and.bubble.right", description: Text("Create one on the website, then invite people.")) } }
        }
    }
}

struct BoardRow: View {
    let b: Board
    var dm: Bool { b.kind == "direct" }

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.hue(b.id).opacity(0.2)).frame(width: 40, height: 40)
                Image(systemName: dm ? "person.2.fill" : b.encrypted == true ? "lock.fill" : "number").foregroundStyle(Theme.hue(b.id))
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(b.title).font(.body.weight(.semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    Spacer()
                    Text(b.lastActivity.ago).font(.caption).foregroundStyle(Theme.faint)
                }
                if let l = b.last {
                    (Text(l.by).fontWeight(.medium).foregroundStyle(Theme.muted) + Text("  ") + Text(l.text.md).foregroundStyle(Theme.faint))
                        .font(.subheadline).lineLimit(1)
                } else {
                    Text(b.entryCount == 1 ? "1 message" : "\(b.entryCount) messages").font(.subheadline).foregroundStyle(Theme.faint)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct BoardView: View {
    @EnvironmentObject var state: AppState
    let board: Board
    @State private var entries: [Entry] = []
    @State private var draft = ""
    @State private var sending = false
    @FocusState private var focused: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(entries) { e in EntryRow(e: e).id(e.seq) }
                }
                .padding(16)
            }
            .background(Theme.bg)
            .onChange(of: entries.last?.seq) { _, s in if let s { withAnimation(.snappy) { proxy.scrollTo(s, anchor: .bottom) } } }
        }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle(board.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: state.tape.first?.id) { _, _ in
            if state.tape.first?.boardId == board.id { Task { await load() } }
        }
        .refreshable { await load() }
    }

    var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message", text: $draft, axis: .vertical)
                .lineLimit(1...6).focused($focused)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.line, lineWidth: 0.5))
            Button { Task { await send() } } label: {
                Image(systemName: sending ? "ellipsis" : "arrow.up").font(.system(size: 15, weight: .bold))
                    .frame(width: 36, height: 36).background(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Theme.line : Theme.accent, in: Circle())
                    .foregroundStyle(.black)
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }

    func load() async {
        let after = max(0, board.entryCount - 80)
        do {
            let r = try await API.shared.get("/api/boards/\(board.id)/entries?after=\(after)&limit=200", as: EntriesResponse.self)
            entries = r.entries
        } catch { state.report(error) }
    }

    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        Haptic.tap()
        defer { sending = false }
        do {
            // Retries with one message id: never lost, never posted twice. The text stays until it lands.
            let data = try await API.shared.send("/api/boards/\(board.id)/entries", body: ["type": "note", "text": text])
            if let r = try? JSONDecoder.soup.decode(PostResponse.self, from: data) { entries.append(r.entry) }
            draft = ""
            Haptic.done()
        } catch { state.report(error) }
    }
}

struct EntryRow: View {
    let e: Entry
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Avatar(name: e.author, agent: e.byAgent, size: 28)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(e.byAgent ? "\(e.author)'s agent" : e.author).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
                    if e.type != "note" { Pill(text: e.type, color: e.type == "question" ? Theme.warn : e.type == "decision" ? Theme.ok : Theme.accent) }
                    if let to = e.to { Text("→ \(to)").font(.caption).foregroundStyle(Theme.faint) }
                    Spacer()
                    Text(e.ts.ago).font(.caption2).foregroundStyle(Theme.faint)
                }
                if let a = e.artifactName { Label(a, systemImage: "doc.text").font(.caption.monospaced()).foregroundStyle(Theme.accent) }
                Text(e.text.md).font(.subheadline).foregroundStyle(Theme.text.opacity(0.88)).textSelection(.enabled)
            }
        }
    }
}
