// The chat's second layer (web parity, wave 2): reaction chips and the emoji picker, "N replies" and the thread
// sheet, who's on a message ("On it"), and the board's info (what's open, who's here, files, search).

import QuickLook
import SwiftUI

// MARK: - Reactions

/// Reactions under a message as compact chips: emoji and count, yours lit in clay. Tap toggles yours; long-press
/// shows who reacted.
struct ReactionChips: View {
    let reactions: [Reaction]
    let me: String?
    let trailing: Bool
    var toggle: ((String) -> Void)? = nil
    var more: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 6) {
            ForEach(reactions, id: \.emoji) { r in
                let yours = me.map { r.users.contains($0) } ?? false
                Button { toggle?(r.emoji) } label: {
                    HStack(spacing: 3) {
                        Text(r.emoji).font(.footnote)
                        Text("\(r.users.count)").font(.caption.weight(.semibold)).monospacedDigit()
                            .foregroundStyle(yours ? Theme.accent : Theme.muted)
                            .contentTransition(.numericText())
                    }
                    .padding(.horizontal, Space.s).frame(height: 26)
                    .background(yours ? Theme.accent.opacity(0.16) : Theme.card, in: Capsule())
                    .contentShape(Capsule())
                }
                .buttonStyle(PressStyle())
                .contextMenu {
                    Section("\(r.emoji) \(r.users.count == 1 ? "1 reaction" : "\(r.users.count) reactions")") {
                        ForEach(r.users, id: \.self) { u in Text(u == me ? "You" : u) }
                    }
                }
                .accessibilityLabel("\(r.emoji) \(r.users.count)")
                .accessibilityValue(yours ? "yours" : "")
                .accessibilityHint(r.users.map { $0 == me ? "you" : $0 }.joined(separator: ", "))
                .accessibilityIdentifier("reaction-\(r.emoji)")
                .transition(.scale(scale: 0.6).combined(with: .opacity))
            }
            if let more {
                Button(action: more) {
                    Image(systemName: "face.smiling").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.faint)
                        .frame(width: 32, height: 26).background(Theme.card, in: Capsule())
                }
                .buttonStyle(PressStyle())
                .accessibilityLabel("Add a reaction")
            }
        }
        .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
        .padding(.top, 2)
        .animation(.spring(duration: 0.3, bounce: 0.3), value: reactions)
    }
}

/// Every emoji, for a reaction: the common ones in a grid, and a field on the emoji keyboard for anything else.
struct EmojiPicker: View {
    let pick: (String) -> Void
    @State private var typed = ""
    static let common = ["👍", "👎", "❤️", "🔥", "🎉", "😂", "😮", "😢", "🙏", "👏", "💯", "✅", "❌", "👀", "🚀", "🤔",
                         "😅", "🙌", "💡", "⚠️", "🐛", "🔧", "📌", "⏳", "🫡", "😍", "🤝", "💪", "👌", "😬", "🙃", "✨"]

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            Text("React").font(Typo.section).foregroundStyle(Theme.muted)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Space.xs), count: 8), spacing: Space.xs) {
                ForEach(Self.common, id: \.self) { e in
                    Button { pick(e) } label: { Text(e).font(.title2).frame(maxWidth: .infinity, minHeight: 40).contentShape(Rectangle()) }
                        .buttonStyle(PressStyle())
                        .accessibilityIdentifier("emoji-\(e)")
                }
            }
            EmojiField(text: $typed, placeholder: "Any emoji")
                .frame(height: 40).padding(.horizontal, Space.m)
                .background(Theme.raised, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                .onChange(of: typed) { _, t in if let c = t.last, c.isEmoji { pick(String(c)) } }
        }
        .padding(Space.l)
    }
}

/// A text field that opens on the emoji keyboard.
private struct EmojiField: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String
    final class Field: UITextField {
        override var textInputMode: UITextInputMode? { UITextInputMode.activeInputModes.first { $0.primaryLanguage == "emoji" } ?? super.textInputMode }
    }
    func makeUIView(context: Context) -> Field {
        let f = Field()
        f.attributedPlaceholder = NSAttributedString(string: placeholder, attributes: [.foregroundColor: UIColor(Theme.faint)])
        f.textColor = UIColor(Theme.text)
        f.font = .preferredFont(forTextStyle: .callout)
        f.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        return f
    }
    func updateUIView(_ f: Field, context: Context) { if f.text != text { f.text = text } }
    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }
    final class Coordinator: NSObject {
        let text: Binding<String>
        init(text: Binding<String>) { self.text = text }
        @objc func changed(_ f: UITextField) { text.wrappedValue = f.text ?? "" }
    }
}

extension Character {
    /// Shown as an emoji (not a digit or "#", which are emoji only with a modifier).
    var isEmoji: Bool {
        guard let s = unicodeScalars.first else { return false }
        return s.properties.isEmojiPresentation || (s.properties.isEmoji && unicodeScalars.count > 1)
    }
}

// MARK: - Threads

/// "3 replies" under a message that has answers: who answered, and when last. Tap for the thread.
struct RepliesChip: View {
    let seq: Int
    let replies: [Entry]
    let open: () -> Void

    var body: some View {
        var seen = Set<String>()
        let people = replies.reversed().filter { seen.insert("\($0.author)/\($0.byAgent)").inserted }.prefix(3)
        let n = replies.count
        return Button(action: open) {
            HStack(spacing: 6) {
                HStack(spacing: -5) {
                    ForEach(Array(people.reversed()), id: \.seq) { r in
                        Avatar(name: r.author, size: 18).padding(1.5).background(Theme.bg, in: Circle())
                    }
                }
                Text(n == 1 ? "1 reply" : "\(n) replies").font(Typo.micro.weight(.semibold)).foregroundStyle(Theme.text.opacity(0.85))
                if let last = replies.last { Text(last.ts.ago).font(Typo.micro).foregroundStyle(Theme.faint).monospacedDigit() }
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.faint)
            }
            .padding(.leading, Space.xxs).padding(.trailing, 10).frame(height: 28)
            .background(Theme.card, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(n == 1 ? "1 reply" : "\(n) replies")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("replies-\(seq)")
    }
}

/// A thread: the message, then every answer under it in order, and a box that answers the thread.
struct ThreadSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    let board: Board
    let root: Int
    @State private var fetched: ThreadResponse?
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var me: String? { state.me?.owner }

    /// The root and its answers: what the server has for it, and what's loaded in the chat (yours still sending too).
    private var items: [Entry] {
        let loaded = state.entries[board.id] ?? []
        let bySeq = Dictionary(loaded.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })
        func inThread(_ e: Entry) -> Bool {
            var cur = e, hops = 0
            while let p = cur.replyTo, hops < 50 {
                if p == root { return true }
                guard let up = bySeq[p] else { return false }
                cur = up; hops += 1
            }
            return false
        }
        var all: [Int: Entry] = [:]
        if let f = fetched {
            all[f.entry.seq] = f.entry
            for r in f.replies where r.replyTo == root && r.retracts == nil { all[r.seq] = r }
        }
        if let r = bySeq[root] { all[root] = r } // decrypted here, on an encrypted board
        for e in loaded where e.retracts == nil && inThread(e) { all[e.seq] = e }
        return all.values.sorted { ($0.seq > 0 ? $0.seq : .max, $0.ts) < ($1.seq > 0 ? $1.seq : .max, $1.ts) }
    }

    private var gone: Set<Int> { Set((state.entries[board.id] ?? []).compactMap(\.retracts) + (fetched?.replies.compactMap(\.retracts) ?? [])) }

    var body: some View {
        let list = items
        let unsent = gone
        let bySeq = Dictionary(list.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if list.isEmpty { ProgressView().tint(Theme.faint).frame(maxWidth: .infinity).padding(.top, Space.xl) }
                    ForEach(Array(list.enumerated()), id: \.element.id) { i, e in
                        if i == 1 {
                            HStack(spacing: Space.s) {
                                Text(list.count == 2 ? "1 reply" : "\(list.count - 1) replies").font(Typo.micro.weight(.semibold)).foregroundStyle(Theme.faint)
                                Rectangle().fill(Theme.line).frame(height: 0.5)
                            }
                            .padding(.top, Space.l).padding(.bottom, Space.xxs)
                        }
                        // Answers to the root don't need to quote it; deeper ones quote what they answer.
                        let shown = { var x = e; if x.replyTo == root { x.replyTo = nil }; return x }()
                        let mine = e.author == me && e.via != "agent"
                        let live = e.seq > 0 && e.pending != true && e.failed != true && !unsent.contains(e.seq)
                        EntryRow(e: shown, mine: mine, board: board.id, tasks: state.tasks[board.id] ?? [], reactions: state.reactions[board.id]?[e.seq] ?? fetched.flatMap { $0.entry.seq == e.seq ? $0.reactions : nil } ?? [],
                                 parent: shown.replyTo.flatMap { bySeq[$0] }, me: me, members: state.members[board.id] ?? [], progress: state.uploads[e.seq],
                                 unsent: unsent.contains(e.seq), handling: state.handling[board.id]?[e.seq],
                                 actions: EntryActions(react: live ? { emoji in Task { await state.react(emoji, to: e.seq, in: board) } } : nil))
                    }
                }
                .padding(.horizontal, Space.l).padding(.bottom, Space.m)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            .safeAreaInset(edge: .bottom, spacing: 0) { composer }
            .navigationTitle("Thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.foregroundStyle(Theme.text) } }
            .toolbarBackground(Theme.bg, for: .navigationBar)
            .task { await load() } // (new answers arrive through the chat's own live list)
        }
        .accessibilityIdentifier("thread-sheet")
    }

    private var composer: some View {
        let canSend = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return HStack(alignment: .bottom, spacing: 0) {
            TextField("Reply in thread", text: $draft, axis: .vertical)
                .font(Typo.body).lineLimit(1...5).focused($focused)
                .padding(.leading, Space.m).padding(.trailing, Space.s).padding(.vertical, 10)
                .accessibilityIdentifier("thread-composer")
            Button(action: send) {
                Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold))
                    .frame(width: 30, height: 30)
                    .background(canSend ? Theme.accent : Theme.raised, in: Circle())
                    .foregroundStyle(canSend ? .black : Theme.faint)
                    .padding(5).contentShape(Rectangle())
            }
            .buttonStyle(PressStyle())
            .disabled(!canSend)
            .accessibilityIdentifier("thread-send")
            .accessibilityLabel("Send")
        }
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .padding(.horizontal, Space.m).padding(.top, Space.s).padding(.bottom, Space.s)
        .background(Theme.bg)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        Haptic.tap()
        Task { await state.send(text, to: board, replyTo: root); await load() }
    }

    private func load() async {
        do { fetched = try await API.shared.get("/api/boards/\(board.id)/entries/\(root)", as: ThreadResponse.self) } catch { state.report(error, quiet: true) }
    }
}

// MARK: - "On it"

/// Who took a message: "theo's agent is on it", "Done by theo/builder".
struct HandlingLine: View {
    let h: Handling
    let me: String?
    var body: some View {
        let you = h.by == me
        Label(h.done == true ? "Done by \(you ? "you" : h.by)" : (you ? "You're on it" : "\(h.by) is on it"),
              systemImage: h.done == true ? "checkmark.circle.fill" : "hand.raised.fill")
            .font(Typo.micro.weight(.medium)).foregroundStyle(h.done == true ? Theme.ok : Theme.muted)
            .padding(.top, Space.xxs)
            .accessibilityIdentifier("handling")
    }
}

/// "On it": a question or task for you, taken in one tap.
struct OnItButton: View {
    let seq: Int
    let take: () -> Void
    var body: some View {
        Button(action: take) {
            Label("On it", systemImage: "hand.raised").font(Typo.micro.weight(.semibold)).foregroundStyle(Theme.accent)
                .padding(.horizontal, 10).frame(height: 26)
                .background(Theme.accent.opacity(0.14), in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
        .accessibilityIdentifier("on-it-\(seq)")
        .accessibilityHint("Tells everyone here you're handling it")
    }
}

// MARK: - Board info

/// What's still open in what's loaded: questions nobody has answered, and the decisions made (the web's summary:
/// a question is open until a non-question answers it or something resolves it; unsent and replaced ones drop out).
enum ChatSummary {
    static func open(_ entries: [Entry]) -> (questions: [Entry], decisions: [Entry]) {
        let retracted = Set(entries.compactMap(\.retracts))
        var superseded = retracted
        var resolved = Set<Int>()
        for e in entries {
            if let s = e.supersedes { superseded.insert(s) }
            if retracted.contains(e.seq) { continue }
            for r in e.resolves ?? [] { resolved.insert(r) }
        }
        var answered = resolved
        for e in entries where e.type != "question" && e.retracts == nil && !retracted.contains(e.seq) { if let p = e.replyTo { answered.insert(p) } }
        let live = entries.filter { $0.seq > 0 && $0.retracts == nil && !superseded.contains($0.seq) }
        return (live.filter { $0.type == "question" && !answered.contains($0.seq) }, live.filter { $0.type == "decision" })
    }

    /// A few words for a list: the author's title, else the start of the first line (mentions left out).
    static func short(_ e: Entry, words: Int = 7) -> String {
        if let t = e.title?.trimmingCharacters(in: .whitespaces), !t.isEmpty { return t }
        let line = (e.text.split(separator: "\n").first.map(String.init) ?? e.text)
            .replacingOccurrences(of: "@[A-Za-z0-9][A-Za-z0-9_.-]*(?:['’]s\\s+agent)?", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "[*`_]", with: "", options: .regularExpression)
        let w = line.split(whereSeparator: \.isWhitespace)
        return w.isEmpty ? "#\(e.seq)" : w.prefix(words).joined(separator: " ") + (w.count > words ? "…" : "")
    }
}

/// The board's info, from the chat's title: what's open (questions, decisions; tap to jump there) and its agents,
/// then the board itself (BoardInfoView: invite, members, rename, archive) with its files, and a search of the
/// whole chat.
struct BoardInfoSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    let board: Board
    let jump: (Int) -> Void
    @State private var files: [DocMeta]?
    @State private var query = ""
    @State private var hits: ChatSearchResponse?
    @State private var searching = false
    @State private var preview: URL?
    @State private var opening: String?

    private var me: String? { state.me?.owner }

    var body: some View {
        NavigationStack {
            Group {
                if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                    List { results.listRowBackground(Theme.card) }
                        .listSectionSpacing(.compact)
                        .scrollContentBackground(.hidden)
                        .background(Theme.bg)
                } else {
                    BoardInfoView(boardId: board.id, fallback: board, top: { openAndAgents }, files: { filesSection })
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: board.encrypted == true ? "Search what's on this phone" : "Search this chat")
            .navigationTitle("Info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.fontWeight(.semibold).foregroundStyle(Theme.text) } }
            .toolbarBackground(Theme.bg, for: .navigationBar)
            .quickLookPreview($preview)
            .task { await load() }
            .task(id: query) { await search() }
        }
    }

    private func rank(_ s: String) -> Int { s == "live" ? 0 : s == "idle" ? 1 : 2 }

    /// What's open in this chat (questions nobody answered, decisions made) and the agents here, live first.
    @ViewBuilder private var openAndAgents: some View {
        let open = ChatSummary.open(state.entries[board.id] ?? [])
        let agents = (state.boardAgents[board.id] ?? []).sorted { rank($0.state) == rank($1.state) ? $0.lastSeen > $1.lastSeen : rank($0.state) < rank($1.state) }
        if !open.questions.isEmpty {
            Section { ForEach(open.questions.suffix(8).reversed()) { e in jumpRow(e, icon: "questionmark.circle.fill", tint: Theme.warn) } }
                header: { SectionHeader("Open questions · \(open.questions.count)") }
                .listRowBackground(Theme.card)
        }
        if !open.decisions.isEmpty {
            Section { ForEach(open.decisions.suffix(5).reversed()) { e in jumpRow(e, icon: "checkmark.seal.fill", tint: Theme.ok) } }
                header: { SectionHeader("Recent decisions") }
                .listRowBackground(Theme.card)
        }
        Section {
            if agents.isEmpty { Text("No agents on this board yet.").font(Typo.secondary).foregroundStyle(Theme.muted) }
            ForEach(agents) { a in AgentHereRow(a: a) }
        } header: {
            let live = agents.filter { $0.state == "live" }.count
            SectionHeader(live > 0 ? "Agents · \(live) working" : "Agents")
        }
        .listRowBackground(Theme.card)
    }

    /// The most recent files, each opening where it reads best (documents in the reader, pictures and other files in
    /// Quick Look), and all of them a tap away.
    @ViewBuilder private var filesSection: some View {
        Section {
            if let files {
                if files.isEmpty { Text("No files yet.").font(Typo.secondary).foregroundStyle(Theme.muted) }
                ForEach(files.prefix(5)) { f in fileRow(f) }
                if files.count > 5 {
                    NavigationLink { FilesList(board: board.id) } label: { InfoLabel("All \(files.count) files", "doc.on.doc") }
                        .accessibilityIdentifier("board-files")
                }
            } else { ProgressView().tint(Theme.faint) }
        } header: { SectionHeader(files.map { $0.isEmpty ? "Files" : "Files · \($0.count)" } ?? "Files") }
        .listRowBackground(Theme.card)
    }

    /// A question or decision: who, a few words, its number. Tap: close and go to it in the chat.
    private func jumpRow(_ e: Entry, icon: String, tint: Color) -> some View {
        Button { Haptic.tap(); jump(e.seq) } label: {
            HStack(spacing: Space.m) {
                Image(systemName: icon).font(.system(size: 15)).foregroundStyle(tint).frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(ChatSummary.short(e)).font(Typo.secondary.weight(.medium)).foregroundStyle(Theme.text).lineLimit(1)
                    Text((e.byAgent ? "\(e.author)'s agent" : e.author) + (e.to.map { " → \($0)" } ?? "") + " · " + e.ts.ago)
                        .font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1)
                }
                Spacer(minLength: Space.s)
                Text("#\(e.seq)").font(Typo.micro).foregroundStyle(Theme.faint).monospacedDigit()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("info-jump-\(e.seq)")
    }

    @ViewBuilder private func fileRow(_ f: DocMeta) -> some View {
        let label = HStack(spacing: Space.m) {
            ZStack {
                FileIcon(name: f.name, size: 28).opacity(opening == f.name ? 0.4 : 1)
                if opening == f.name { ProgressView().controlSize(.small).tint(Theme.muted) }
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(f.name).font(Typo.secondary.weight(.medium)).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.middle)
                Text([f.size.bytes, f.version > 1 ? "v\(f.version)" : nil, f.via == "agent" ? "\(f.updatedBy)'s agent" : f.updatedBy, f.updatedAt.ago].compactMap { $0 }.joined(separator: " · "))
                    .font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        // Stored bytes (pictures, PDFs…) go to Quick Look; text documents to the reader, with their versions.
        if f.mime != nil {
            Button { openFile(f) } label: { label }.buttonStyle(.plain).accessibilityIdentifier("file-\(f.name)")
        } else {
            NavigationLink { DocViewer(board: board.id, name: f.name) } label: { label }.accessibilityIdentifier("file-\(f.name)")
        }
    }

    /// Search results: messages (tap to jump there), then files.
    @ViewBuilder private var results: some View {
        if let hits {
            if hits.entries.isEmpty && (hits.files ?? []).isEmpty {
                Text(searching ? "Searching…" : board.encrypted == true
                     ? "Nothing on this phone matches “\(query)”. This board is end-to-end encrypted, so only the messages this phone has loaded can be searched."
                     : "Nothing in this chat matches “\(query)”.")
                    .font(Typo.secondary).foregroundStyle(Theme.muted)
                    .accessibilityIdentifier("search-empty")
            }
            if !hits.entries.isEmpty {
                Section {
                    ForEach(hits.entries) { h in SearchHitRow(hit: h) { Haptic.tap(); jump(h.seq) } }
                } header: { SectionHeader(board.encrypted == true ? "On this phone" : "Messages") }
            }
            if let fs = hits.files, !fs.isEmpty {
                Section {
                    ForEach(fs) { f in
                        if let file = files?.first(where: { $0.name == f.name }) { fileRow(file) } else {
                            Text(f.name).font(Typo.secondary).foregroundStyle(Theme.text)
                        }
                    }
                } header: { SectionHeader("Files") }
            }
        } else {
            HStack { Spacer(); ProgressView().tint(Theme.faint); Spacer() }
        }
    }

    private func load() async {
        async let a: Void = state.loadAgents(board)
        async let f = state.docs(board.id)
        let (_, ff) = await (a, f)
        withAnimation(.smooth) { files = ff.sorted { $0.updatedAt > $1.updatedAt } }
    }

    /// Searches the whole chat on the server as you type (a moment after you stop). On an encrypted board the
    /// server can't read the messages, so it searches what this phone has (and says so).
    private func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { hits = nil; return }
        try? await Task.sleep(nanoseconds: 300_000_000)
        guard !Task.isCancelled else { return }
        searching = true
        defer { searching = false }
        if board.encrypted == true {
            let found = (state.entries[board.id] ?? []).filter { $0.seq > 0 && $0.retracts == nil && $0.text.localizedCaseInsensitiveContains(q) }.reversed().prefix(60)
            hits = ChatSearchResponse(entries: found.map { .init(seq: $0.seq, ts: $0.ts, author: $0.author, via: $0.via, type: $0.type, title: $0.title, snippet: String($0.text.prefix(200))) }, files: [])
            return
        }
        do {
            let r = try await API.shared.get("/api/boards/\(board.id)/search?q=\(q.queryEscaped)", as: ChatSearchResponse.self)
            if !Task.isCancelled { withAnimation(.smooth) { hits = r } }
        } catch { if !Task.isCancelled { state.report(error, quiet: true) } }
    }

    private func openFile(_ f: DocMeta) {
        guard opening == nil else { return }
        Haptic.tap()
        opening = f.name
        Task {
            defer { opening = nil }
            do { preview = try await MediaStore.shared.file(for: f.entry, board: board.id) } catch { Haptic.warn(); state.report(error) }
        }
    }
}

/// One search hit: who said it, when, and the words around the match (matches in bold).
struct SearchHitRow: View {
    let hit: ChatSearchResponse.Hit
    var board: String? = nil // across boards: which one
    let open: () -> Void
    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: Space.m) {
                Avatar(name: hit.author, agent: hit.via == "agent", size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: Space.xs) {
                        Text(hit.via == "agent" ? "\(hit.author)'s agent" : hit.author).font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.text).lineLimit(1)
                        if let board { Text("in \(board)").font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1) }
                        Spacer(minLength: Space.s)
                        Text(hit.ts.ago).font(Typo.micro).foregroundStyle(Theme.faint)
                    }
                    Text(SearchHitRow.highlighted(hit.snippet)).font(Typo.secondary).foregroundStyle(Theme.muted).lineLimit(3)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("search-hit-\(hit.seq)")
    }

    /// The server marks matches «like this»: shown in bold, in the text color.
    static func highlighted(_ s: String) -> AttributedString {
        var out = AttributedString()
        var bold = false
        var cur = ""
        func flush() {
            guard !cur.isEmpty else { return }
            var a = AttributedString(cur)
            if bold { a.foregroundColor = Theme.text; a.font = Typo.secondary.weight(.semibold) }
            out += a
            cur = ""
        }
        for c in s {
            if c == "«" { flush(); bold = true } else if c == "»" { flush(); bold = false } else { cur.append(c) }
        }
        flush()
        return out
    }
}
