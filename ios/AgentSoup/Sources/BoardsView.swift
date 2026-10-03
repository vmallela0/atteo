// One board or DM: opens on what you saw last (cached), refreshes in place, marks itself read, and sends instantly
// (your message shows at once; if it can't be delivered it says so and you tap to retry).

import PhotosUI
import SwiftUI

struct BoardView: View {
    @EnvironmentObject var state: AppState
    let board: Board
    @State private var draft = ""
    @State private var showTasks = false
    @State private var workPane: WorkPane? // Tasks or Files, from the top bar (always reachable)
    @State private var showAgents = false
    private var live: [BoardAgent] { (state.boardAgents[board.id] ?? []).filter { $0.state == "live" } }
    /// "theo's agent working", "theo and maya's agents working", "3 agents working", or "No agents working now".
    private var presence: String {
        var users: [String] = []
        for a in live where !users.contains(a.user) { users.append(a.user) }
        switch users.count {
        case 0: return board.encrypted == true ? "End-to-end encrypted" : "No agents working now"
        case 1: return "\(users[0])'s agent working"
        case 2: return "\(users[0]) and \(users[1])'s agents working"
        default: return "\(users.count) agents working"
        }
    }
    @State private var focused = false // the message box has the keyboard

    private var list: [Entry] { state.entries[board.id] ?? [] }
    private var canSend: Bool { (!draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty) && preparing == 0 }

    // Pictures and files waiting in the message box (sent with the text, the way the web composer sends them).
    @State private var attachments: [Attachment] = []
    @State private var preparing = 0 // picked, still being made to fit
    @State private var picked: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var showEncryptedNote = false
    private let maxAttachments = 10

    @State private var atBottom = true
    @State private var stick = true // pinned to the latest until you scroll up yourself (like any messenger)
    @State private var position = ScrollPosition(edge: .bottom) // like any messenger: you start at the latest

    // Wave 2: threads, reactions, unsend, receipts, board info, older messages.
    @State private var flash: Int? // a message just jumped to, lit for a moment
    @State private var scrollRequest: ScrollRequest?
    @State private var thread: ThreadTarget? // the thread open, pushed full screen (its root)
    @State private var profile: ProfileTarget? // someone's card (a picture, a name or an @mention tapped)
    @State private var seenBy: Receipt? // who's seen one of your messages, as a list
    @State private var reactingTo: SeqRef? // the message the full emoji picker is for
    @State private var unsending: Entry? // asking "Unsend?" first
    @State private var openReceipts: Set<Int> = [] // your older messages you tapped to see who's seen them
    @State private var holdBottom = false // older messages going in above: keep what you're reading where it is

    @ObservedObject private var threadSeen = ThreadSeen.shared
    private var me: String? { state.me?.owner }
    private func isMine(_ e: Entry) -> Bool { e.author == me && e.via != "agent" }

    /// What every row needs to know about the others: the chat as shown, by number, what was unsent, who answered what.
    struct Rows {
        let shown: [Entry]
        let bySeq: [Int: Entry]
        let gone: Set<Int>
        let replies: [Int: [Entry]]
        let latestMine: Int?
    }

    private func rows() -> Rows {
        let bySeq = Dictionary(list.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })
        // Retractions aren't messages: their targets read "Unsent" instead.
        let gone = Set(list.compactMap(\.retracts))
        // Like Slack: the chat is the top-level messages; answers live in their thread ("3 replies" under the root).
        let shown = list.filter { $0.retracts == nil && $0.replyTo == nil }
        let replies = Dictionary(grouping: list.filter { $0.replyTo != nil && $0.retracts == nil && $0.seq > 0 && !gone.contains($0.seq) }, by: { rootOf($0, in: bySeq) })
        let latestMine = shown.last { isMine($0) && $0.seq > 0 && $0.type != "task" && !gone.contains($0.seq) }?.seq
        return Rows(shown: shown, bySeq: bySeq, gone: gone, replies: replies, latestMine: latestMine)
    }

    private var anyUnreadThread: Bool { ThreadIndex.threads(list).contains { threadSeen.unread(board.id, $0, me: me) } }

    var body: some View { threads(chat) }

    /// Threads: pushed on this stack (a reply, a preview card, a "#123"), and the list of them in the top bar.
    private func threads(_ v: some View) -> some View {
        v
        .navigationDestination(item: $thread) { t in ThreadView(board: board, root: t.root, prefill: t.prefill) }
        .toolbar {
            // Every thread here, newest first (a dot when one has answers you haven't seen).
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink { ThreadsList(board: board) } label: {
                    Image(systemName: "bubble.left.and.text.bubble.right").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                        .overlay(alignment: .topTrailing) {
                            if anyUnreadThread { Circle().fill(Theme.accent).frame(width: 7, height: 7).offset(x: 3, y: -2) }
                        }
                }
                .accessibilityIdentifier("threads")
                .accessibilityLabel("Threads")
                .accessibilityValue(anyUnreadThread ? "new replies" : "")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Tasks", systemImage: "checklist") { workPane = .tasks }
                    Button("Files", systemImage: "doc.on.doc") { workPane = .files }
                } label: { Image(systemName: "square.stack").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text) }
                .accessibilityIdentifier("work-menu")
                .accessibilityLabel("Tasks and files")
            }
        }
        // A "#123" in a message: go to it (or open its thread, if it's an answer).
        .environment(\.openURL, OpenURLAction { url in
            if let p = personLink(url) { Haptic.tap(); profile = p; return .handled }
            guard let n = entryLink(url) else { return .systemAction }
            jump(to: n)
            return .handled
        })
        .sheet(item: $seenBy) { r in SeenBySheet(receipt: r).presentationDetents([.medium, .large]).presentationBackground(Theme.bg) }
        // Someone's card: Message opens your DM; "Ask theo's agent" starts a message to it here.
        .sheet(item: $profile) { p in
            NavigationStack {
                PersonCard(name: p.name, open: { b in profile = nil; state.openRequest = b }, agentFirst: p.agent, ask: {
                    profile = nil
                    let handle = "@\(p.name)'s agent "
                    if !draft.localizedCaseInsensitiveContains(handle.trimmingCharacters(in: .whitespaces)) { draft = handle + draft }
                    focused = true
                })
            }
            .presentationDetents([.fraction(0.8), .large]).presentationBackground(Theme.bg)
        }
        .onChange(of: list.count) { _, _ in threadSeen.baseline(board.id, ThreadIndex.threads(list)) }
        // Opened from a search hit in Chats: go to that message (its thread, if it's an answer) once it's here.
        .task(id: state.jumpRequest) {
            guard let j = state.jumpRequest, j.board == board.id else { return }
            if state.entries[board.id] == nil { await state.loadEntries(board) }
            state.jumpRequest = nil
            jump(to: j.seq, after: 0.3)
        }
    }

    @ViewBuilder private var chat: some View {
        let r = rows()
        ScrollViewReader { proxy in
        ScrollView {
                // Placeholders and messages are separate containers: sharing one list would give them colliding ids
                // (placeholder 1… and message #1…), and SwiftUI kept showing placeholders in place of messages.
                if state.entries[board.id] == nil {
                    VStack(alignment: .leading, spacing: 0) { ForEach(0..<6, id: \.self) { _ in PlaceholderMessage() } }
                        .padding(.horizontal, Space.l).padding(.vertical, Space.m)
                        .transition(.opacity)
                }
                if state.loadingEarlier.contains(board.id) {
                    ProgressView().controlSize(.small).tint(Theme.faint).frame(maxWidth: .infinity).padding(.top, Space.m)
                        .accessibilityIdentifier("loading-earlier")
                }
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(r.shown.enumerated()), id: \.element.id) { i, e in
                        row(i, r)
                            .id(e.id)
                            .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
                    }
                }
                .padding(.horizontal, Space.l).padding(.top, Space.xs).padding(.bottom, Space.s)
            }
            .scrollPosition($position)
            .onChange(of: scrollRequest) { _, r in
                guard let r else { return }
                if r.animated { withAnimation(.smooth(duration: 0.35)) { proxy.scrollTo(r.id, anchor: r.anchor) } } else { proxy.scrollTo(r.id, anchor: r.anchor) }
                scrollRequest = nil
            }
            // Like any messenger: it opens at the latest, a short chat sits right above the message box, and while
            // you're at the latest it stays there as things change size (the keyboard sliding up, the message box
            // growing as you type, a new message or a receipt arriving), natively, without scrolling it by hand.
            // Scrolled up to read history: nothing moves you.
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .alignment)
            // (and while older messages go in above, the bottom holds too, so what you're reading stays put)
            .defaultScrollAnchor(stick || holdBottom ? .bottom : nil, for: .sizeChanges)
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            // At the latest: the visible part (which includes what's under the composer) reaches the end.
            .onScrollGeometryChange(for: Bool.self) { g in g.visibleRect.maxY >= g.contentSize.height - 80 } action: { _, bottom in
                if bottom != atBottom { withAnimation(.snappy) { atBottom = bottom } }
            }
            // Near the top of what's loaded (and it's long enough to scroll): bring in the page before it.
            .onScrollGeometryChange(for: Bool.self) { g in g.contentSize.height > g.containerSize.height && g.visibleRect.minY < 360 } action: { _, top in
                if top && !stick { loadOlder() }
            }
            // Only your own scrolling unpins it; coming back to the latest re-pins.
            .onScrollPhaseChange { old, phase in
                if phase == .interacting { stick = false }
                else if phase == .idle && (old == .interacting || old == .decelerating) { stick = atBottom } // after a swipe, not our own scrolls
            }
            .onChange(of: list.last?.id) { _, _ in
                // A new message: yours always scrolls into view (and re-pins); others' do if you're at the latest.
                if list.last.map({ $0.author == state.me?.owner && $0.via != "agent" }) == true { stick = true }
                if stick { withAnimation(.smooth(duration: 0.3)) { position.scrollTo(edge: .bottom) } }
            }
            .overlay(alignment: .bottomTrailing) {
                if !atBottom && !list.isEmpty {
                    Button { Haptic.tap(); stick = true; withAnimation(.smooth(duration: 0.35)) { position.scrollTo(edge: .bottom) } } label: {
                        Image(systemName: "chevron.down").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text)
                            .frame(width: 36, height: 36).background(Theme.raised, in: Circle())
                            .shadow(color: .black.opacity(0.4), radius: 8, y: 2)
                            .frame(width: 44, height: 44).contentShape(Circle())
                    }
                    .buttonStyle(PressStyle())
                    .padding(.trailing, Space.s).padding(.bottom, Space.xs)
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                    .accessibilityLabel("Jump to latest")
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { WorkStrip(tasks: state.tasks[board.id] ?? []) { Haptic.tap(); showTasks = true } }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .sheet(isPresented: $showTasks) { TasksSheet(board: board).presentationDetents([.large]).presentationBackground(Theme.bg) }
        .sheet(item: $workPane) { p in TasksSheet(board: board, initial: p).presentationDetents([.large]).presentationBackground(Theme.bg) }
        .navigationTitle(board.displayName(me: state.me?.owner))
        .toolbar {
            // The title, and under it who's working here right now (tap for everyone, live / idle / gone).
            ToolbarItem(placement: .principal) {
                Button { Haptic.tap(); showAgents = true } label: {
                    VStack(spacing: 1) {
                        Text(board.displayName(me: state.me?.owner)).font(.headline).foregroundStyle(Theme.text).lineLimit(1)
                        HStack(spacing: Space.xs) {
                            if board.encrypted == true { Image(systemName: "lock.fill").font(.system(size: 9)).foregroundStyle(Theme.faint) }
                            if !live.isEmpty { LiveDot(size: 6) }
                            Text(presence).font(Typo.micro.weight(.medium)).foregroundStyle(live.isEmpty ? Theme.faint : Theme.ok).lineLimit(1)
                        }
                    }
                    .padding(.horizontal, Space.s)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("presence")
            }
        }
        .photosPicker(isPresented: $showPhotos, selection: $picked, maxSelectionCount: max(1, min(5, maxAttachments - attachments.count)), selectionBehavior: .ordered, matching: .images)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            for item in items { add { guard let d = try await item.loadTransferable(type: Data.self) else { throw AttachError.unreadable("That picture") }; return try await Attachments.picture(d, name: nil) } }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { r in
            switch r {
            case .success(let urls): for u in urls.prefix(max(0, maxAttachments - attachments.count)) { add { try await Attachments.file(u) } }
            case .failure(let e): state.report(e)
            }
        }
        .fullScreenCover(isPresented: $showCamera) { CameraPicker { img in add { try await Attachments.photo(img) } }.ignoresSafeArea() }
        // The title opens the board's info: what's open, who's here, files, search.
        .sheet(isPresented: $showAgents) {
            BoardInfoSheet(board: board) { seq in showAgents = false; jump(to: seq, after: 0.35) }
                .presentationDetents([.large]).presentationBackground(Theme.bg)
        }
        .sheet(item: $reactingTo) { r in
            EmojiPicker { emoji in reactingTo = nil; Task { await state.react(emoji, to: r.id, in: board) } }
                .presentationDetents([.height(300)]).presentationBackground(Theme.card)
        }
        .confirmationDialog("Unsend this message?", isPresented: Binding(get: { unsending != nil }, set: { if !$0 { unsending = nil } }), titleVisibility: .visible, presenting: unsending) { e in
            Button("Unsend", role: .destructive) { Task { await state.retract(e.seq, in: board) } }
        } message: { _ in Text("Everyone here will see it as unsent.") }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar) // inside a conversation the message box owns the bottom edge
        .task { async let e: Void = state.loadEntries(board); async let t: Void = state.loadTasks(board); async let a: Void = state.loadAgents(board); async let m: Void = state.loadMembers(board); _ = await (e, t, a, m); await state.markRead(board); await state.loadHandling(board); await state.markSeen(board) }
        .onChange(of: state.pulse) { _, p in if p?.board == board.id { Task { async let e: Void = state.loadEntries(board); async let t: Void = state.loadTasks(board); async let a: Void = state.loadAgents(board); _ = await (e, t, a); await state.markRead(board) } } }
        .onChange(of: list.last?.seq) { _, _ in Task { await state.markSeen(board) } } // you've seen what just landed
        .task(id: board.id) { await state.watch(board) } // live: ticks and new messages as they happen
        .refreshable { await state.loadEntries(board) }
    }

    /// One message in the chat: a day line or hairline above it when it starts something new, then the message.
    @ViewBuilder private func row(_ i: Int, _ r: Rows) -> some View {
        let e = r.shown[i]
        let prev = i > 0 ? r.shown[i - 1] : nil
        let newDay = prev.map { !Calendar.current.isDate(Date(timeIntervalSince1970: $0.ts / 1000), inSameDayAs: Date(timeIntervalSince1970: e.ts / 1000)) } ?? true
        let grouped = !newDay && prev != nil && prev!.author == e.author && prev!.via == e.via && e.ts - prev!.ts < 5 * 60_000 && e.type == "note" && e.replyTo == nil
        let mine = isMine(e)
        let prevMine = prev.map { isMine($0) && $0.type != "task" } ?? false
        VStack(alignment: .leading, spacing: 0) {
            if newDay { DaySeparator(ts: e.ts) }
            // A hairline between separate messages from others (bubbles are separate already).
            else if !(mine && e.type != "task") && !prevMine { Rectangle().fill(Theme.line.opacity(grouped ? 0.45 : 0.8)).frame(height: 0.5).padding(.leading, 38).padding(.top, grouped ? Space.xs : Space.s) }
            entryRow(e, grouped: grouped, mine: mine, r)
        }
    }

    private func entryRow(_ e: Entry, grouped: Bool, mine: Bool, _ r: Rows) -> EntryRow {
        let unsent = r.gone.contains(e.seq)
        let live = e.seq > 0 && e.pending != true && e.failed != true && !unsent
        let showReceipt = mine && live && (e.seq == r.latestMine || openReceipts.contains(e.seq))
        return EntryRow(e: e, grouped: grouped, mine: mine, board: board.id, tasks: state.tasks[board.id] ?? [], reactions: state.reactions[board.id]?[e.seq] ?? [],
                        parent: e.replyTo.flatMap { r.bySeq[$0] }, me: me, members: state.members[board.id] ?? [], progress: state.uploads[e.seq],
                        reply: live ? { startReply(to: e) } : nil,
                        unsent: unsent, replies: r.replies[e.seq] ?? [], threadUnread: threadUnread(e.seq, r), handling: state.handling[board.id]?[e.seq], lit: flash == e.seq,
                        receipt: showReceipt ? receipt(for: e) : nil,
                        openReceipt: mine && live ? { if let r = receipt(for: e) { Haptic.tap(); seenBy = r } } : nil,
                        actions: actions(for: e, mine: mine, live: live, r)) {
            Task { if e.local != nil { await state.retryUpload(e, in: board) } else { await state.send(e.text, to: board, retrying: e) } }
        }
    }

    private func actions(for e: Entry, mine: Bool, live: Bool, _ r: Rows) -> EntryActions {
        var a = EntryActions()
        a.openProfile = { name, agent in Haptic.tap(); profile = ProfileTarget(name: name, agent: agent) }
        if live {
            a.react = { emoji in Task { await state.react(emoji, to: e.seq, in: board) } }
            a.moreReactions = { reactingTo = SeqRef(id: e.seq) }
            let root = rootOf(e, in: r.bySeq)
            a.openThread = { thread = ThreadTarget(root: root) }
            if mine {
                a.unsend = { unsending = e }
                a.toggleReceipt = { withAnimation(.snappy) { if openReceipts.contains(e.seq) { openReceipts.remove(e.seq) } else { openReceipts.insert(e.seq) } } }
            }
            if forMe(e) { a.takeOn = { Task { await state.takeOn(e.seq, in: board) } } }
        }
        if let p = e.replyTo { a.jumpToParent = { jump(to: p) } }
        return a
    }

    /// Reply (swipe right, or long-press → Reply): the message's thread opens, its box starting with who you're
    /// answering, like the web: "@theo " or "@theo's agent " (not yourself).
    private func startReply(to e: Entry) {
        Haptic.tap()
        focused = false
        let handle = isMine(e) ? nil : "@" + (e.byAgent ? "\(e.author)'s agent" : e.author) + " "
        thread = ThreadTarget(root: rootOf(e, in: Dictionary(list.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })), prefill: handle)
    }

    /// Scrolls to a message and lights it for a moment, loading older messages first if it's before what's here.
    private func jump(to seq: Int, after delay: Double = 0) {
        Task {
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1e9)) }
            // Further back than what's loaded: bring it in (pages of up to 500, until it's here).
            var tries = 0
            while !list.contains(where: { $0.seq == seq }), tries < 20, (state.firstLoaded(board) ?? 0) > seq {
                holdBottom = true
                guard await state.loadEarlier(board, through: seq) || list.contains(where: { $0.seq == seq }) else { break }
                tries += 1
            }
            if holdBottom { try? await Task.sleep(nanoseconds: 250_000_000); holdBottom = false }
            guard let target = list.first(where: { $0.seq == seq }) else { Haptic.warn(); return }
            // An answer lives in its thread: open that.
            if target.replyTo != nil {
                thread = ThreadTarget(root: rootOf(target, in: Dictionary(list.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })), focus: seq)
                return
            }
            stick = false
            if focused { // the keyboard would cover it: let it go down first, then scroll
                focused = false
                try? await Task.sleep(nanoseconds: 350_000_000)
            }
            Haptic.tap()
            scrollRequest = ScrollRequest(id: seq, anchor: .center, animated: true)
            try? await Task.sleep(nanoseconds: 300_000_000)
            withAnimation(.smooth(duration: 0.25)) { flash = seq }
            try? await Task.sleep(nanoseconds: 1_300_000_000)
            withAnimation(.smooth(duration: 0.8)) { if flash == seq { flash = nil } }
        }
    }

    /// The page before what's loaded, put in above without moving what you're reading.
    private func loadOlder() {
        guard !holdBottom, !state.loadingEarlier.contains(board.id), let first = state.firstLoaded(board), first > 1 else { return }
        holdBottom = true
        Task {
            await state.loadEarlier(board)
            try? await Task.sleep(nanoseconds: 400_000_000) // until the rows above have settled
            holdBottom = false
        }
    }

    /// The top of a reply chain (what its thread is about), as far as it's loaded.
    private func rootOf(_ e: Entry, in bySeq: [Int: Entry]) -> Int { ThreadIndex.root(of: e, in: bySeq) }

    /// Answers in a message's thread you haven't seen yet.
    private func threadUnread(_ seq: Int, _ r: Rows) -> Bool {
        guard let replies = r.replies[seq], !replies.isEmpty else { return false }
        return threadSeen.unread(board.id, ThreadSummary(root: seq, rootEntry: r.bySeq[seq], replies: replies), me: me)
    }

    /// A question or task for you or your agent (by `to` or an @mention), from someone else.
    private func forMe(_ e: Entry) -> Bool {
        guard let me = me?.lowercased(), e.type == "question" || e.type == "task", !isMine(e) else { return false }
        return e.to?.lowercased() == me || (e.mentions ?? []).contains { $0.user.lowercased() == me }
    }

    /// Everyone who should see one of your messages, and whether they have (the web's ring): each member as a
    /// person, and each member's agent once it has been on the board, your own agent included ("Your agent").
    private func readers(for e: Entry) -> [Reader]? {
        guard let reads = state.reads[board.id], let me else { return nil }
        var names = state.members[board.id] ?? []
        for u in reads.keys.sorted() where !names.contains(u) { names.append(u) }
        var out: [Reader] = []
        for u in names {
            if u != me { out.append(Reader(user: u, agent: false, mine: false, seen: (reads[u]?.personSeen ?? 0) >= e.seq)) }
            if let a = reads[u]?.agentSeen, a >= 0 { out.append(Reader(user: u, agent: true, mine: u == me, seen: a >= e.seq)) }
        }
        return out.isEmpty ? nil : out
    }

    /// "Seen by jxn, your agent" / "Seen by everyone" / "Delivered", with its check.
    private func receipt(for e: Entry) -> Receipt? {
        guard let who = readers(for: e) else { return nil }
        let seen = who.filter(\.seen)
        if seen.isEmpty { return Receipt(text: "Delivered", level: 0, readers: who) }
        if seen.count == who.count { return Receipt(text: "Seen by everyone", level: 2, readers: who) }
        return Receipt(text: "Seen by " + seen.map(\.label).joined(separator: ", "), level: 1, readers: who)
    }

    // MARK: - The message box

    /// What "@" can name here: each member's agent and each member (you can hand work to your own agent, but you
    /// don't mention yourself), plus everyone's agents and everyone.
    private var mentionables: [Mentionable] {
        let me = state.me?.owner
        var people = state.members[board.id] ?? []
        for u in list.map(\.author) + (state.boardAgents[board.id] ?? []).map(\.user) where !people.contains(u) { people.append(u) }
        return people.flatMap { u in [Mentionable(handle: "\(u)'s agent", user: u, agent: true)] + (u == me ? [] : [Mentionable(handle: u, user: u, agent: false)]) }
            + [Mentionable(handle: "agents", user: nil, agent: true), Mentionable(handle: "humans", user: nil, agent: false)]
    }

    /// The "@word" being typed at the end of the message, if any.
    private var mentionQuery: String? {
        guard let at = draft.lastIndex(of: "@") else { return nil }
        if at > draft.startIndex, let before = draft[draft.index(before: at)...].first, !before.isWhitespace { return nil }
        let q = draft[draft.index(after: at)...]
        return q.contains(where: { $0.isWhitespace && $0 != " " }) || q.count > 32 || q.contains("  ") ? nil : String(q)
    }

    private var suggestions: [Mentionable] {
        guard focused, let q = mentionQuery?.lowercased() else { return [] }
        // "theo", "theo's", "theo's ag": match the handle as typed so far (and don't offer what's already complete).
        return Array(mentionables.filter { $0.handle.lowercased().hasPrefix(q) && $0.handle.lowercased() != q }.prefix(5))
    }

    private func insert(_ m: Mentionable) {
        guard let at = draft.lastIndex(of: "@") else { return }
        Haptic.tap()
        draft = String(draft[..<at]) + "@\(m.handle) "
    }

    /// The message box: one soft field on the page (no bar, no outline), the send button inside its trailing edge.
    /// Above it, when they apply: who you're replying to, and who "@" can name.
    var composer: some View {
        VStack(spacing: 0) {
            if !suggestions.isEmpty {
                MentionList(items: suggestions, pick: insert)
                    .padding(.horizontal, Space.m).padding(.bottom, Space.xs)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            VStack(spacing: 0) {
            if !attachments.isEmpty || preparing > 0 {
                AttachmentTray(items: attachments, preparing: preparing) { a in
                    withAnimation(.spring(duration: 0.28, bounce: 0.1)) { attachments.removeAll { $0.id == a.id } }
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            HStack(alignment: .bottom, spacing: 0) {
                attachButton
                // A text view of its own, so Paste takes pictures too (ComposerField.swift).
                ComposerField(text: $draft, focused: $focused,
                              placeholder: attachments.isEmpty ? (board.kind == "direct" ? "Message \(board.displayName(me: state.me?.owner))" : "Message \(board.title)") : "Add a note",
                              pasteImages: pasted)
                    .padding(.leading, Space.xs).padding(.trailing, Space.s)
                Button(action: send) {
                    Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold))
                        .frame(width: 30, height: 30)
                        .background(canSend ? Theme.accent : Theme.raised, in: Circle())
                        .foregroundStyle(canSend ? .black : Theme.faint)
                        .scaleEffect(canSend ? 1 : 0.9)
                        .animation(.spring(duration: 0.3, bounce: 0.35), value: canSend)
                        .padding(5)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .disabled(!canSend)
                .accessibilityIdentifier("send")
                .accessibilityLabel("Send")
            }
            }
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .padding(.horizontal, Space.m)
        }
        .padding(.top, Space.m).padding(.bottom, Space.s) // a little air between the last message and the box
        .background(Theme.bg)
        .animation(.spring(duration: 0.28, bounce: 0.1), value: suggestions.map(\.handle))
        .animation(.spring(duration: 0.28, bounce: 0.1), value: attachments.map(\.id))
        .animation(.spring(duration: 0.28, bounce: 0.1), value: preparing)
    }

    /// + at the leading edge of the message box: Photos, the camera (when there is one), Files. Encrypted boards
    /// can't take attachments yet: the + is dimmed and says so.
    @ViewBuilder private var attachButton: some View {
        let label = Image(systemName: "plus").font(.system(size: 15, weight: .semibold))
            .frame(width: 30, height: 30)
            .background(Theme.raised, in: Circle())
            .padding(5)
            .contentShape(Rectangle())
        if board.encrypted == true {
            Button { Haptic.tap(); showEncryptedNote = true } label: { label.foregroundStyle(Theme.faint).opacity(0.55) }
                .buttonStyle(PressStyle())
                .popover(isPresented: $showEncryptedNote, arrowEdge: .bottom) {
                    Label("Pictures and files can't be sent on encrypted boards yet.", systemImage: "lock.fill")
                        .font(Typo.secondary).foregroundStyle(Theme.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(width: 260, alignment: .leading)
                        .padding(.horizontal, Space.m).padding(.vertical, Space.s + 2)
                        .presentationCompactAdaptation(.popover)
                        .presentationBackground(Theme.raised)
                        .accessibilityIdentifier("attach-unavailable")
                }
                .accessibilityIdentifier("attach")
                .accessibilityLabel("Attach")
                .accessibilityHint("Not available on encrypted boards yet")
        } else {
            Menu {
                Button("Photos", systemImage: "photo.on.rectangle") { showPhotos = true }
                if UIImagePickerController.isSourceTypeAvailable(.camera) { Button("Camera", systemImage: "camera") { showCamera = true } }
                Button("Files", systemImage: "folder") { showFiles = true }
            } label: { label.foregroundStyle(Theme.muted) }
                .menuOrder(.fixed)
                .disabled(attachments.count + preparing >= maxAttachments)
                .accessibilityIdentifier("attach")
                .accessibilityLabel("Attach")
        }
    }

    /// Pictures pasted into the message box: attached like ones picked from Photos (not on encrypted boards, which
    /// can't take attachments yet: the + says why).
    private func pasted(_ images: [UIImage]) {
        guard board.encrypted != true else { Haptic.warn(); showEncryptedNote = true; return }
        Haptic.tap()
        for img in images.prefix(max(0, maxAttachments - attachments.count - preparing)) { add { try await Attachments.photo(img) } }
    }

    /// Prepares something picked (made to fit the size limit) and puts it in the message box.
    private func add(_ make: @escaping () async throws -> Attachment) {
        preparing += 1
        Task {
            do {
                let a = try await make()
                withAnimation(.spring(duration: 0.28, bounce: 0.1)) { attachments.append(a) }
            } catch { Haptic.warn(); state.report(error) }
            preparing -= 1
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = attachments
        guard canSend else { return }
        draft = ""
        withAnimation(.spring(duration: 0.3, bounce: 0.15)) { attachments = [] }
        Haptic.tap()
        Task {
            if files.isEmpty { await state.send(text, to: board) } else { await state.send(files: files, caption: text, to: board) }
        }
    }
}

/// A scroll the chat should make (to a message, by its id).
struct ScrollRequest: Equatable { let id: Int; let anchor: UnitPoint; let animated: Bool }
/// A message, by number, for sheets that open on one.
struct SeqRef: Identifiable { let id: Int }
/// A thread to open: its root, what its box starts with (a reply's @mention), and an answer to show.
struct ThreadTarget: Hashable { let root: Int; var prefill: String? = nil; var focus: Int? = nil }

/// Someone "@" can name: a member's agent, a member, or everyone's agents / everyone.
struct Mentionable: Hashable {
    let handle: String // what goes after the "@"
    let user: String? // nil: a group
    let agent: Bool
}

/// What "@" suggests, just above the message box: a compact list, one tap to insert.
struct MentionList: View {
    let items: [Mentionable]
    let pick: (Mentionable) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(items, id: \.handle) { m in
                Button { pick(m) } label: {
                    HStack(spacing: 10) {
                        if let u = m.user { Avatar(name: u, agent: m.agent, size: 24) } else {
                            Image(systemName: m.agent ? "sparkles" : "person.2.fill").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted)
                                .frame(width: 24, height: 24).background(Theme.raised, in: Circle())
                        }
                        Text("@" + m.handle).font(Typo.secondary.weight(.medium)).foregroundStyle(Theme.text)
                        Spacer(minLength: Space.s)
                        Text(m.user == nil ? (m.agent ? "every agent here" : "everyone here") : (m.agent ? "agent" : "person")).font(Typo.micro).foregroundStyle(Theme.faint)
                    }
                    .padding(.horizontal, Space.m).frame(minHeight: 40)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("mention-\(m.handle)")
            }
        }
        .padding(.vertical, Space.xs)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .shadow(color: .black.opacity(0.35), radius: 12, y: 4)
    }
}

/// Swipe a message right to reply (a horizontal pan only: scrolling and the back swipe from the edge are untouched).
struct SwipeToReply: UIGestureRecognizerRepresentable {
    var changed: (CGFloat) -> Void
    var ended: (CGFloat) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let g = UIPanGestureRecognizer()
        g.delegate = context.coordinator
        return g
    }

    func handleUIGestureRecognizerAction(_ g: UIPanGestureRecognizer, context: Context) {
        let dx = max(0, g.translation(in: g.view).x)
        switch g.state {
        case .changed: changed(dx)
        case .ended, .cancelled, .failed: ended(dx)
        default: break
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard let p = g as? UIPanGestureRecognizer else { return false }
            let v = p.velocity(in: p.view)
            return v.x > 0 && abs(v.x) > abs(v.y) * 1.6 && p.location(in: nil).x > 28 // not the back swipe
        }
    }
}

/// What you can do to a message (nil: not here, not now).
struct EntryActions {
    var react: ((String) -> Void)? = nil // toggle your reaction
    var moreReactions: (() -> Void)? = nil // the full emoji picker
    var unsend: (() -> Void)? = nil // yours: take it back
    var openThread: (() -> Void)? = nil // the thread it's in, in a sheet
    var jumpToParent: (() -> Void)? = nil // tap the quote: go to what it answers
    var toggleReceipt: (() -> Void)? = nil // yours: show or hide who's seen it
    var takeOn: (() -> Void)? = nil // "On it", for a question or task for you
    var openProfile: ((String, Bool) -> Void)? = nil // tap a picture or a name: their card (agent: their agent's)
}

struct EntryRow: View {
    let e: Entry
    var grouped = false
    var mine = false
    var board = "" // the board's id
    var tasks: [WorkTask] = [] // the board's tasks, so a task posted here shows as it is now
    var reactions: [Reaction] = [] // on this message (agents' 👀 / ✅: read and working / done)
    var parent: Entry? = nil // what this one answers
    var me: String? = nil
    var members: [String] = [] // who's on the board (for @-mentions while a message is still sending)
    var progress: Double? = nil // a picture or file going up: how far
    var reply: (() -> Void)? = nil // answer this message (nil: it can't be answered yet)
    var unsent = false // its author took it back
    var replies: [Entry] = [] // answers to it (its thread)
    var threadUnread = false // answers in its thread you haven't seen
    var handling: Handling? = nil // who's on it
    var lit = false // just jumped to
    var receipt: Receipt? = nil // yours: "Seen by …" / "Delivered", with its check
    var openReceipt: (() -> Void)? = nil // tap it: who's seen it, as a list
    var actions = EntryActions()
    var retry: () -> Void = {}
    @State var drag: CGFloat = 0 // swipe right to reply

    private var who: String { e.byAgent ? "\(e.author)'s agent" : e.author }
    private static let replyAt: CGFloat = 56
    private var replyAt: CGFloat { Self.replyAt }
    static let quick = ["👍", "❤️", "😂", "🎉", "👀", "✅"]

    /// Agents' 👀 / ✅ are read receipts (the quiet line); everything else is a reaction chip.
    private var receipts: [Reaction] {
        reactions.compactMap { r in
            guard r.emoji == "👀" || r.emoji == "✅" else { return nil }
            let agents = r.users.filter(Self.isAgent)
            return agents.isEmpty ? nil : Reaction(emoji: r.emoji, users: agents)
        }
    }
    private var chips: [Reaction] {
        reactions.compactMap { r in
            let people = r.emoji == "👀" || r.emoji == "✅" ? r.users.filter { !Self.isAgent($0) } : r.users
            return people.isEmpty ? nil : Reaction(emoji: r.emoji, users: people)
        }
    }
    static func isAgent(_ u: String) -> Bool { u.hasSuffix("'s agent") || u.contains("/") }

    var body: some View {
        Group { if mine && e.type != "task" { myMessage } else { theirMessage } }
            .background {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous).fill(Theme.accent.opacity(lit ? 0.14 : 0))
                    .padding(.horizontal, -Space.s).padding(.vertical, -Space.xxs)
            }
            .offset(x: drag)
            .background(alignment: .leading) {
                // The reply arrow surfaces from the left edge as you swipe.
                Image(systemName: "arrowshape.turn.up.left.fill").font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(drag >= replyAt ? Theme.accent : Theme.muted)
                    .frame(width: 28, height: 28).background(Theme.raised, in: Circle())
                    .scaleEffect(min(1, 0.5 + drag / replyAt / 2)).opacity(min(1, drag / replyAt))
                    .offset(x: -36 + min(drag, replyAt) * 0.6)
            }
            .contextMenu {
                if let react = actions.react {
                    // A quick-reaction row, like any messenger (the palette holds six); every other emoji just under it.
                    ControlGroup {
                        ForEach(Self.quick, id: \.self) { q in Button { react(q) } label: { Text(q) } }
                    }
                    .controlGroupStyle(.palette)
                    .menuActionDismissBehavior(.enabled) // a palette stays open by default; picking one closes it
                }
                if let more = actions.moreReactions { Button("More reactions", systemImage: "face.smiling", action: more) }
                if let reply { Button("Reply", systemImage: "arrowshape.turn.up.left", action: reply) }
                if let open = actions.openThread, !replies.isEmpty || e.replyTo != nil { Button("View thread", systemImage: "bubble.left.and.bubble.right", action: open) }
                if let take = actions.takeOn, handling == nil { Button("On it", systemImage: "hand.raised", action: take) }
                if !unsent { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = e.text; Haptic.tap() } }
                if e.failed == true { Button("Retry", systemImage: "arrow.clockwise", action: retry) }
                if let unsend = actions.unsend { Button("Unsend", systemImage: "arrow.uturn.backward", role: .destructive, action: unsend) }
            }
            .gesture(SwipeToReply(changed: { dx in
                guard reply != nil else { return }
                let d = dx < replyAt ? dx : replyAt + (dx - replyAt) * 0.25 // rubber band past the threshold
                if (drag < replyAt) != (d < replyAt) { Haptic.tap() }
                drag = d
            }, ended: { _ in
                if drag >= replyAt { reply?() }
                withAnimation(.spring(duration: 0.35, bounce: 0.3)) { drag = 0 }
            }))
    }

    /// What this message answers, as one light line above it. Tap: go there (loading it if it's further back).
    @ViewBuilder private var quote: some View {
        if e.replyTo != nil {
            Button { actions.jumpToParent?() } label: {
                HStack(spacing: 6) {
                    Capsule().fill(Theme.faint.opacity(0.6)).frame(width: 2)
                    if let p = parent {
                        (Text(p.byAgent ? "\(p.author)'s agent" : (p.author == me && p.via != "agent" ? "You" : p.author)).fontWeight(.semibold) + Text("  " + (p.text.split(separator: "\n").first.map(String.init) ?? p.text)))
                            .font(Typo.micro).foregroundStyle(Theme.muted).lineLimit(1)
                    } else {
                        Text("An earlier message").font(Typo.micro.weight(.semibold)).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 1)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(actions.jumpToParent == nil)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("reply-quote")
            .accessibilityHint("Shows the message it answers")
        }
    }

    /// A question, a claim, a decision: said in words, not as a type tag.
    private var kind: String? {
        switch e.type {
        case "note", "task", "artifact", "change": return nil // a file, a task, a change: each shows as itself
        default: return e.type.prefix(1).uppercased() + e.type.dropFirst()
        }
    }

    /// The words under a picture or file; nil when they'd only repeat its name ("Shared photo.jpg").
    private var caption: String? {
        if let a = e.artifactName, e.text == "Shared \(a)" || e.text.isEmpty { return nil }
        return e.text
    }

    /// A picture inline, or a file as a chip.
    @ViewBuilder private var attachment: some View {
        if e.artifactName != nil && !unsent {
            if e.isImage { ChatImage(e: e, board: board, progress: progress) } else { FileChip(e: e, board: board, progress: progress) }
        }
    }

    /// Taken back: what it said, struck through and faint, marked "Unsent" (like the web).
    private var unsentBody: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: Space.xxs) {
            Text(caption ?? e.artifactName ?? "").font(Typo.body).strikethrough(true, color: Theme.faint).foregroundStyle(Theme.faint).lineLimit(2)
            Label("Unsent", systemImage: "arrow.uturn.backward").labelStyle(.titleAndIcon).font(Typo.micro.weight(.medium)).foregroundStyle(Theme.faint)
                .accessibilityIdentifier("unsent")
        }
        .padding(.horizontal, mine ? Space.m + 1 : 0).padding(.vertical, mine ? Space.s : 0)
        .background(mine ? Theme.card : .clear, in: RoundedRectangle(cornerRadius: Radius.bubble, style: .continuous))
    }

    /// Reactions, answers, who's on it: the small things under a message.
    @ViewBuilder private var footer: some View {
        if !unsent {
            if !chips.isEmpty || !receipts.isEmpty {
                VStack(alignment: mine ? .trailing : .leading, spacing: Space.xs) {
                    if !chips.isEmpty { ReactionChips(reactions: chips, me: me, trailing: mine, toggle: actions.react, more: actions.moreReactions) }
                    if !receipts.isEmpty { ReactionLine(reactions: receipts, trailing: mine) }
                }
            }
            if !replies.isEmpty, let open = actions.openThread { ThreadPreview(seq: e.seq, replies: replies, unread: threadUnread, open: open).padding(.top, Space.xs) }
            if let h = handling { HandlingLine(h: h, me: me) }
            else if let take = actions.takeOn { OnItButton(seq: e.seq, take: take).padding(.top, Space.xxs) }
        }
    }

    /// Yours: a right-aligned bubble, like any messenger. Tap it to see who's seen it.
    private var myMessage: some View {
        VStack(alignment: .trailing, spacing: Space.xs) {
            if let k = kind { Text(k).font(Typo.micro.weight(.medium)).foregroundStyle(Theme.faint) }
            quote
            attachment
            if unsent { unsentBody } else if e.type == "change" { ChangeCardView(e: e, board: board) } else if let caption {
                let m = caption.mentioned(e.mentions, members: members, me: me)
                m.text.textRenderer(MentionBoxes())
                    .font(Typo.body).foregroundStyle(Theme.text.opacity(e.pending == true ? 0.55 : 1))
                    .accessibilityValue(m.handles.isEmpty ? "" : "Mentions " + m.handles.joined(separator: ", "))
                    .padding(.horizontal, Space.m + 1).padding(.vertical, Space.s)
                    .background(Theme.raised, in: RoundedRectangle(cornerRadius: Radius.bubble, style: .continuous))
                    .onTapGesture { actions.toggleReceipt?() }
            }
            footer
            if e.pending == true {
                Text("Sending…").font(.caption2).foregroundStyle(Theme.faint)
            } else if e.failed == true {
                Button(action: retry) { Label("Not sent. Tap to retry", systemImage: "exclamationmark.circle").font(.caption2.weight(.semibold)) }
                    .buttonStyle(.plain).foregroundStyle(Theme.danger)
            } else if let receipt {
                Button { openReceipt?() } label: {
                    HStack(spacing: 3) {
                        ReceiptCheck(level: receipt.level)
                        Text(receipt.text).lineLimit(2).multilineTextAlignment(.trailing)
                    }
                    .font(.caption2).foregroundStyle(receipt.level == 2 ? Theme.accent : Theme.faint)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .transition(.opacity)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(receipt.text)
                .accessibilityHint("Shows who's seen it")
                .accessibilityAddTraits(.isButton)
                .accessibilityIdentifier("seen-by")
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 56)
        .padding(.top, grouped ? Space.xs : Space.m)
    }

    /// Everyone else (people and agents): plain text under who said it.
    private var theirMessage: some View {
        HStack(alignment: .top, spacing: 10) {
            if grouped { Color.clear.frame(width: 28, height: 1) } else {
                Avatar(name: e.author, agent: e.byAgent, size: 28)
                    .contentShape(Rectangle())
                    .onTapGesture { actions.openProfile?(e.author, e.byAgent) }
                    .accessibilityAddTraits(.isButton)
                    .accessibilityLabel(who)
                    .accessibilityIdentifier("avatar-\(who)")
            }
            VStack(alignment: .leading, spacing: Space.xxs) {
                if !grouped {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(who).font(Typo.secondary.weight(.semibold)).foregroundStyle(Theme.text).lineLimit(1)
                            .onTapGesture { actions.openProfile?(e.author, e.byAgent) }
                        if let k = kind { Text(k).font(Typo.micro.weight(.medium)).foregroundStyle(e.type == "question" ? Theme.warn : Theme.faint) }
                        if let to = e.to { Text("to \(to)").font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1) }
                        Spacer(minLength: Space.xs)
                        Text(e.ts.ago).font(Typo.micro).foregroundStyle(Theme.faint).monospacedDigit()
                    }
                }
                attachment.padding(.vertical, Space.xxs)
                quote
                if unsent { unsentBody } else if e.type == "change" { ChangeCardView(e: e, board: board).padding(.top, Space.xxs) } else if e.type == "task" { TaskCard(seq: e.seq, board: board, text: e.text, tasks: tasks).padding(.top, Space.xxs) } else if let caption {
                    let m = caption.mentioned(e.mentions, members: members, me: me)
                    m.text.textRenderer(MentionBoxes()).font(Typo.body).foregroundStyle(Theme.text.opacity(0.92)).lineSpacing(1.5)
                        .accessibilityValue(m.handles.isEmpty ? "" : "Mentions " + m.handles.joined(separator: ", "))
                }
                footer
            }
        }
        .padding(.top, grouped ? Space.xs : Space.s + 2)
    }
}

/// "Today", "Yesterday", or the date, between days.
struct DaySeparator: View {
    let ts: Double
    var body: some View {
        let d = Date(timeIntervalSince1970: ts / 1000)
        let label = Calendar.current.isDateInToday(d) ? "Today" : Calendar.current.isDateInYesterday(d) ? "Yesterday" : d.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
        Text(label).font(Typo.micro.weight(.semibold)).foregroundStyle(Theme.faint)
            .frame(maxWidth: .infinity).padding(.top, Space.l).padding(.bottom, Space.xxs)
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
        .padding(.top, Space.l)
    }
}

/// A task posted in the chat, shown as what it is (a task with a checklist), not as raw "- [ ]" text.
/// A task in the chat as it is now, not as it was posted: live title, who's on it, its checklist ticking off
/// as the work gets done, and its sub-tasks. Tap for the whole task.
struct TaskCard: View {
    let seq: Int
    let board: String
    let text: String
    let tasks: [WorkTask]
    @State private var open = false

    var body: some View {
        let t = tasks.first { $0.seq == seq }
        let subs = tasks.filter { $0.parent == seq }.sorted { $0.seq < $1.seq }
        // A checklist line that is also a sub-task shows once, as the sub-task (it has its own ring and owner).
        let items = (t?.items ?? []).filter { it in !subs.contains { $0.covers(it.text) } }
        Button { if t != nil { Haptic.tap(); open = true } } label: {
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(alignment: .top, spacing: 10) {
                    Group {
                        if let t { ProgressRing(task: t).frame(width: 16, height: 16) } else {
                            Image(systemName: "circle.dashed").font(.system(size: 15)).foregroundStyle(Theme.muted)
                        }
                    }
                    .padding(.top, 2)
                    VStack(alignment: .leading, spacing: Space.xxs) {
                        Text((t?.title ?? String(text.split(separator: "\n").first ?? Substring(text))).md)
                            .font(Typo.secondary.weight(.semibold)).foregroundStyle(t?.status == "done" ? Theme.muted : Theme.text).lineLimit(2)
                        Text(t.map { $0.caption } ?? "Task").font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                if !items.isEmpty || !subs.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(items.prefix(6).enumerated()), id: \.offset) { _, it in CheckLine(text: it.text, done: it.done, compact: true) }
                        if items.count > 6 { Text("+\(items.count - 6) more").font(Typo.micro).foregroundStyle(Theme.faint) }
                        ForEach(subs.prefix(6)) { s in SubTaskLine(task: s) }
                    }
                    .padding(.leading, 26)
                }
            }
            .padding(.horizontal, Space.m).padding(.vertical, 10)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .animation(.smooth, value: t)
            .animation(.smooth, value: subs)
        }
        .buttonStyle(PressStyle())
        .accessibilityIdentifier("task-card-\(seq)")
        .accessibilityValue(t?.caption ?? "")
        .sheet(isPresented: $open) {
            NavigationStack {
                TaskDetail(seq: seq, board: board)
                    .navigationDestination(for: Int.self) { s in TaskDetail(seq: s, board: board) }
            }
                .presentationDetents([.medium, .large]).presentationBackground(Theme.bg)
        }
    }
}

/// One agent here: its state, whose it is, which tool, and what it says it's doing.
struct AgentHereRow: View {
    let a: BoardAgent
    var body: some View {
        HStack(spacing: Space.m) {
            Avatar(name: a.user, agent: true, size: 32)
                .overlay(alignment: .bottomTrailing) { StateDot(state: a.state).padding(2).background(Theme.card, in: Circle()).offset(x: 4, y: 4) }
            VStack(alignment: .leading, spacing: Space.xxs) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(a.label).font(Typo.rowTitle).foregroundStyle(Theme.text).lineLimit(1)
                    if let d = a.detail { Text(d).font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1) }
                }
                Text(a.status ?? stateLine(a.state, a.lastSeen)).font(Typo.secondary).foregroundStyle(a.state == "live" ? Theme.ok : Theme.muted).lineLimit(2)
            }
        }
        .padding(.vertical, Space.xxs)
    }
}

/// live: green and breathing; idle: grey; gone: an empty ring.
struct StateDot: View {
    let state: String?
    var body: some View {
        switch state {
        case "live": LiveDot(size: 8)
        case "idle": Circle().fill(Theme.faint).frame(width: 8, height: 8)
        default: Circle().stroke(Theme.faint, lineWidth: 1.2).frame(width: 8, height: 8)
        }
    }
}

func stateLine(_ state: String?, _ lastSeen: Double) -> String {
    switch state {
    case "live": return "working now"
    case "idle": return "idle · last active \(lastSeen.ago) ago".replacingOccurrences(of: "now ago", with: "just now")
    default: return "gone · last seen \(lastSeen.ago) ago".replacingOccurrences(of: "now ago", with: "just now")
    }
}

/// Reactions under a message. Agents' 👀 (read it, working) and ✅ (done) read like a messenger's receipts:
/// "👀 theo's agent". Others are compact: "👍 2".
struct ReactionLine: View {
    let reactions: [Reaction]
    let trailing: Bool
    var body: some View {
        HStack(spacing: 8) {
            ForEach(reactions, id: \.emoji) { r in
                let receipt = r.emoji == "👀" || r.emoji == "✅"
                HStack(spacing: 3) {
                    Text(r.emoji).font(.caption2)
                    Text(receipt ? names(r.users) : "\(r.users.count)").font(.caption2).foregroundStyle(r.emoji == "✅" ? Theme.ok : Theme.faint).lineLimit(1)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(receipt ? "\(r.emoji == "👀" ? "Seen, working" : "Done"): \(names(r.users))" : "\(r.emoji) \(r.users.count)")
            }
        }
        .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
        .padding(.top, 2)
        .transition(.opacity)
    }
    private func names(_ users: [String]) -> String { users.count <= 2 ? users.joined(separator: ", ") : "\(users[0]) and \(users.count - 1) more" }
}
