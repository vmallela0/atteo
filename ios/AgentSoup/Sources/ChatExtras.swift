// The chat's second layer (web parity, wave 2): reaction chips and the emoji picker, who's on a message ("On it"),
// and the board's info (what's open, who's here, files, search). Threads are in Threads.swift.

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

extension Character {
    /// Shown as an emoji (not a digit or "#", which are emoji only with a modifier).
    var isEmoji: Bool {
        guard let s = unicodeScalars.first else { return false }
        return s.properties.isEmojiPresentation || (s.properties.isEmoji && unicodeScalars.count > 1)
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
            .replacingOccurrences(of: "[*`]", with: "", options: .regularExpression)
        let w = line.split(whereSeparator: \.isWhitespace)
        return w.isEmpty ? (e.artifactName ?? "A message") : w.prefix(words).joined(separator: " ") + (w.count > words ? "…" : "")
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
    @StateObject private var context = SoulMemoryModel() // the board's SOUL and MEMORY (BoardContext.swift)

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
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.toolbarText(primary: true) } }
            .toolbarBackground(Theme.bg, for: .navigationBar)
            .quickLookPreview($preview)
            .task { await load() }
            .task(id: query) { await search() }
            .onReceive(NotificationCenter.default.publisher(for: .memoryChanged)) { n in if n.object as? String == board.id { Task { await context.load(board.id, state) } } }
            .sheet(isPresented: $context.editing) {
                SoulEditor(board: board.id, soul: context.soul ?? Soul(version: 0, text: "")) { Task { await context.load(board.id, state) } }
                    .presentationBackground(Theme.bg)
            }
        }
    }

    private func rank(_ s: String) -> Int { s == "live" ? 0 : s == "idle" ? 1 : 2 }

    /// What's open in this chat (questions nobody answered, decisions made) and the agents here, live first.
    @ViewBuilder private var openAndAgents: some View {
        let open = ChatSummary.open(state.entries[board.id] ?? [])
        let agents = (state.boardAgents[board.id] ?? []).sorted { rank($0.state) == rank($1.state) ? $0.lastSeen > $1.lastSeen : rank($0.state) < rank($1.state) }
        // The board's standing context for agents, first: its SOUL and MEMORY (vedu #1090).
        // (Developer mode only: Everyday keeps agent files out of sight, Everyday.swift.)
        if !board.isAgentChat && !Vocab.everyday { SoulMemorySections(board: board, model: context) }
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
            if agents.isEmpty { Text(Vocab.pick("No agents on this board yet.", "No assistants in this chat yet.")).font(Typo.secondary).foregroundStyle(Theme.muted) }
            ForEach(agents) { a in
                NavigationLink { PersonCard(name: a.user, open: { b in state.openRequest = b }, agentFirst: true) } label: { AgentHereRow(a: a) }
                    .accessibilityIdentifier("info-agent-\(a.user)")
            }
        } header: {
            let live = agents.filter { $0.state == "live" }.count
            SectionHeader(Vocab.pick(live > 0 ? "Agents · \(live) working" : "Agents", live > 0 ? "Assistants · \(live) working" : "Assistants"))
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

    /// A question or decision: a few words, who and when (no number: those are for agents). Tap: go to it in the chat.
    private func jumpRow(_ e: Entry, icon: String, tint: Color) -> some View {
        Button { jump(e.seq) } label: {
            HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                Image(systemName: icon).font(.system(size: 15)).foregroundStyle(tint).frame(width: 22).onFirstLine()
                VStack(alignment: .leading, spacing: 1) {
                    Text(ChatSummary.short(e)).font(Typo.secondary.weight(.medium)).foregroundStyle(Theme.text).lineLimit(1)
                    Text((e.byAgent ? Vocab.agentOf(e.author) : e.author) + (e.to.map { " → \($0)" } ?? "") + " · " + e.ts.ago)
                        .font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1)
                }
                Spacer(minLength: 0)
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
                    ForEach(hits.entries) { h in SearchHitRow(hit: h) { jump(h.seq) } }
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
        async let c: Void = board.isAgentChat ? () : context.load(board.id, state)
        let (_, ff, _) = await (a, f, c)
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
        opening = f.name
        Task {
            defer { opening = nil }
            do { preview = try await MediaStore.shared.file(for: f.entry, board: board.id) } catch { Haptics.play(.failed); state.report(error) }
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
                        if hit.ts > 0 { Text(hit.ts.ago).font(Typo.micro).foregroundStyle(Theme.faint) }
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

// MARK: - Seen by

/// Someone who should see your message: a member, or a member's agent (yours: "Your agent").
struct Reader: Hashable, Identifiable {
    let user: String
    let agent: Bool
    let mine: Bool // your own agent
    let seen: Bool
    var id: String { "\(user)/\(agent)" }
    var label: String { mine ? "your agent" : agent ? "\(user)'s agent" : user }
}

/// The line under your message: what it says, how far it got (0 delivered, 1 seen by some, 2 by everyone), and who.
struct Receipt: Hashable, Identifiable {
    let text: String
    let level: Int
    let readers: [Reader]
    var id: String { text + readers.map(\.id).joined() }
}

/// ✓ delivered or seen by some; ✓✓ (clay) seen by everyone.
struct ReceiptCheck: View {
    let level: Int
    var body: some View {
        ZStack(alignment: .leading) {
            Image(systemName: "checkmark")
            if level == 2 { Image(systemName: "checkmark").offset(x: 4) }
        }
        .font(.system(size: 8, weight: .heavy))
        .padding(.trailing, level == 2 ? 4 : 0)
        .opacity(level == 0 ? 0.6 : 1)
        .accessibilityHidden(true)
    }
}

/// Who's seen your message, as a list: "Seen by 3 of 4", people then agents, each Seen or Not yet.
struct SeenBySheet: View {
    let receipt: Receipt
    var body: some View {
        let seen = receipt.readers.filter(\.seen).count
        NavigationStack {
            List {
                ForEach([(false, "People"), (true, "Agents")], id: \.0) { agent, title in
                    let group = receipt.readers.filter { $0.agent == agent }.sorted { ($0.seen ? 0 : 1, $0.user) < ($1.seen ? 0 : 1, $1.user) }
                    if !group.isEmpty {
                        Section {
                            ForEach(group) { r in
                                HStack(spacing: Space.m) {
                                    Avatar(name: r.user, agent: r.agent, size: 30)
                                    Text(r.mine ? "Your agent" : r.agent ? "\(r.user)'s agent" : r.user).font(Typo.rowTitleRead).foregroundStyle(Theme.text).lineLimit(1)
                                    Spacer(minLength: Space.s)
                                    if r.seen {
                                        Label("Seen", systemImage: "checkmark").font(Typo.micro.weight(.semibold)).foregroundStyle(Theme.ok)
                                    } else {
                                        Text("Not yet").font(Typo.micro).foregroundStyle(Theme.faint)
                                    }
                                }
                                .accessibilityElement(children: .combine)
                                .accessibilityIdentifier("reader-\(r.id)")
                            }
                        } header: { SectionHeader(title) }
                        .listRowBackground(Theme.card)
                    }
                }
            }
            .listSectionSpacing(.compact)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle(seen == receipt.readers.count ? "Seen by everyone" : "Seen by \(seen) of \(receipt.readers.count)")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

// MARK: - @agents / @humans

/// Who "@agents" or "@humans" reaches here: the board's agents (working now, idle), or its people (when each was last
/// here). A row opens their card.
struct GroupSheet: View {
    @EnvironmentObject var state: AppState
    let board: Board
    let agents: Bool
    var all = false // "@all": everyone, then their agents
    @State private var members: BoardMembersResponse?

    var body: some View {
        NavigationStack {
            List {
                if all {
                    peopleSection
                    agentSections
                } else if agents { agentSections } else { peopleSection }
            }
            .listSectionSpacing(.compact)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle(all ? "Everyone on this board" : agents ? "Agents on this board" : "People on this board")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                if agents || all { await state.loadAgents(board) }
                if !agents || all { members = await state.boardMembers(board.id) }
            }
        }
    }

    @ViewBuilder private var agentSections: some View {
        let all = state.boardAgents[board.id] ?? []
        let groups = [("live", "Working now"), ("idle", "Idle")].map { k, t in (t, all.filter { $0.state == k }.sorted { $0.lastSeen > $1.lastSeen }) }
        if groups.allSatisfy({ $0.1.isEmpty }) { Text("No agents here right now.").font(Typo.secondary).foregroundStyle(Theme.muted).listRowBackground(Theme.card) }
        ForEach(groups, id: \.0) { title, list in
            if !list.isEmpty {
                Section {
                    ForEach(list) { a in
                        NavigationLink { PersonCard(name: a.user, open: { b in state.openRequest = b }, agentFirst: true) } label: { agentRow(a) }
                            .accessibilityIdentifier("group-agent-\(a.user)")
                    }
                } header: { SectionHeader("\(title) · \(list.count)") }
                .listRowBackground(Theme.card)
            }
        }
    }

    private var peopleSection: some View {
        Section {
            if members == nil { ProgressView().frame(maxWidth: .infinity) }
            ForEach(members?.members ?? []) { m in
                NavigationLink { PersonCard(name: m.user, open: { b in state.openRequest = b }) } label: {
                    HStack(spacing: Space.m) {
                        Avatar(name: m.user, size: 30)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(m.user == state.me?.owner ? "\(m.displayName ?? m.user) (you)" : m.displayName ?? m.user).font(Typo.rowTitleRead).foregroundStyle(Theme.text).lineLimit(1)
                            Text(m.lastSeen.map { "here \($0.ago == "now" ? "just now" : "\($0.ago) ago")" } ?? "@\(m.user)").font(Typo.micro).foregroundStyle(Theme.faint)
                        }
                    }
                }
                .accessibilityIdentifier("group-person-\(m.user)")
            }
        } header: { if all { SectionHeader("People") } }
        .listRowBackground(Theme.card)
    }

    private func agentRow(_ a: BoardAgent) -> some View {
        HStack(spacing: Space.m) {
            Avatar(name: a.user, agent: true, size: 30)
                .overlay(alignment: .bottomTrailing) { StateDot(state: a.state).padding(2).background(Theme.card, in: Circle()).offset(x: 4, y: 4) }
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(a.name.map { "\(a.user)/\($0)" } ?? a.label).font(Typo.rowTitleRead).foregroundStyle(Theme.text).lineLimit(1)
                    if let c = a.client { Text(c).font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1) }
                }
                Text(a.status ?? stateLine(a.state, a.lastSeen)).font(Typo.micro).foregroundStyle(a.state == "live" ? Theme.ok : Theme.muted).lineLimit(2)
            }
        }
    }
}
