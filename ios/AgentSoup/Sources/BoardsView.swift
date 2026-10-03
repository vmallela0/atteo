// One board or DM: opens on what you saw last (cached), refreshes in place, marks itself read, and sends instantly
// (your message shows at once; if it can't be delivered it says so and you tap to retry).

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
    @State private var atBottom = true
    @State private var stick = true // pinned to the latest until you scroll up yourself (like any messenger)
    @State private var position = ScrollPosition(edge: .bottom) // like any messenger: you start at the latest

    // Wave 2: threads, reactions, unsend, receipts, board info, older messages.
    @State private var flash: Int? // a message just jumped to, lit for a moment
    @State private var scrollRequest: ScrollRequest?
    @State private var thread: ThreadTarget? // the thread open, over the chat (iMessage-style), with its own box
    @State private var newAt: Int? // your first unread message when the chat opened: a thin "New" line above it
    @State private var unreadResolved = false // where to open (first unread or the latest) is settled, once per visit
    @State private var userScrolled = false // you've scrolled yourself since it opened (nothing moves you after)
    @State private var profile: ProfileTarget? // someone's card (a picture, a name or an @mention tapped)
    @State private var seenBy: Receipt? // who's seen one of your messages, as a list
    @State private var group: GroupTarget? // "@agents" / "@humans" tapped: who that reaches
    @State private var reactingTo: SeqRef? // the message the full emoji picker is for
    @State private var unsending: Entry? // asking "Unsend?" first
    @State private var openReceipts: Set<Int> = [] // your older messages you tapped to see who's seen them
    @State private var holdBottom = false // older messages going in above: keep what you're reading where it is
    @State private var decisionPrompt: DecisionPrompt? // objecting (why?) or closing a human decision
    @State private var decisionNote = ""
    @State private var toSession: String? // "Your agent": one of your sessions (nil: any of your agents)
    @State private var confetti = 0 // bumped when a "Shipped" change card arrives while you're here
    @State private var newestSeen: Int? // the newest message when the chat opened (so only arrivals celebrate)

    @ObservedObject private var threadSeen = ThreadSeen.shared
    @Environment(\.chatDensity) private var density
    @Environment(\.colorScheme) private var scheme // the title's ink, fixed (Color.fixed)
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
        // Every message in order, replies included (jxn #1040): a reply lands at the bottom like any message, under a
        // bar quoting what it answers; the message it answers says "3 replies", which opens the thread.
        let shown = list.filter { $0.retracts == nil }
        let replies = Dictionary(grouping: list.filter { $0.replyTo != nil && $0.retracts == nil && $0.seq > 0 && !gone.contains($0.seq) }, by: { rootOf($0, in: bySeq) })
        let latestMine = shown.last { isMine($0) && $0.seq > 0 && $0.type != "task" && !gone.contains($0.seq) }?.seq
        return Rows(shown: shown, bySeq: bySeq, gone: gone, replies: replies, latestMine: latestMine)
    }

    private var anyUnreadThread: Bool { ThreadIndex.threads(list).contains { threadSeen.unread(board.id, $0, me: me) } }

    // ("#123" in messages, checklists and the task sheets reads as that message's title.)
    var body: some View { threads(chat).refTitles(list, tasks: state.tasks[board.id] ?? []) }

    /// Threads: over the chat as a sheet (a reply, "N replies", a reply's quote bar), and the list of them in the top bar.
    private func threads(_ v: some View) -> some View {
        v
        // Tapping into the message box (#842): to the latest, pinned there as the keyboard comes up and the box
        // grows (the sizeChanges anchor), until you scroll up to read, which unpins it.
        .onChange(of: focused) { _, on in
            guard on else { return }
            stick = true
            withAnimation(.smooth(duration: 0.3)) { position.scrollTo(edge: .bottom) }
        }
        // iMessage-style: the thread slides up over the chat, with the same message box as the chat (jxn #1040, #1094).
        .sheet(item: $thread) { t in
            NavigationStack { ThreadView(board: board, root: t.root, prefill: t.prefill, focus: t.focus, replyTo: t.replyTo, overChat: true, closes: true) }
                .environment(\.chatDensity, density)
                .presentationDetents([.large]).presentationDragIndicator(.visible)
                .presentationBackground(Theme.bg)
        }
        .toolbar {
            // Every thread here, newest first (a dot when one has answers you haven't seen).
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink { ThreadsList(board: board) } label: {
                    ToolbarIcon("bubble.left.and.text.bubble.right")
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
                } label: { ToolbarIcon("square.stack") }
                .accessibilityIdentifier("work-menu")
                .accessibilityLabel("Tasks and files")
            }
        }
        // A "#123" in a message: go to it (or open its thread, if it's an answer).
        .environment(\.openURL, OpenURLAction { url in
            if let p = personLink(url) { profile = p; return .handled }
            if let g = groupLink(url) { group = g; return .handled }
            guard let n = entryLink(url) else { return .systemAction }
            jump(to: n)
            return .handled
        })
        .sheet(item: $group) { g in GroupSheet(board: board, agents: g.agents).presentationDetents([.medium, .large]).presentationBackground(Theme.bg) }
        .sheet(item: $seenBy) { r in SeenBySheet(receipt: r).environment(\.chatDensity, density).presentationDetents([.medium, .large]).presentationBackground(Theme.bg) }
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
                if phase == .interacting { stick = false; userScrolled = true }
                else if phase == .idle && (old == .interacting || old == .decelerating) { stick = atBottom } // after a swipe, not our own scrolls
            }
            .onChange(of: list.last?.id) { _, _ in
                // A new message: yours always scrolls into view (and re-pins); others' do if you're at the latest.
                if list.last.map({ $0.author == state.me?.owner && $0.via != "agent" }) == true { stick = true }
                if stick { withAnimation(.smooth(duration: 0.3)) { position.scrollTo(edge: .bottom) } }
            }
            .overlay(alignment: .bottomTrailing) {
                if !atBottom && !list.isEmpty {
                    Button { stick = true; withAnimation(.smooth(duration: 0.35)) { position.scrollTo(edge: .bottom) } } label: {
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
        .safeAreaInset(edge: .top, spacing: 0) { WorkStrip(tasks: state.tasks[board.id] ?? []) { showTasks = true } }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .sheet(isPresented: $showTasks) { TasksSheet(board: board).environment(\.chatDensity, density).presentationDetents([.large]).presentationBackground(Theme.bg) }
        .sheet(item: $workPane) { p in TasksSheet(board: board, initial: p).environment(\.chatDensity, density).presentationDetents([.large]).presentationBackground(Theme.bg) }
        .navigationTitle(board.displayName(me: state.me?.owner))
        .toolbar {
            // The title, and under it who's working here right now (tap for everyone, live / idle / gone).
            ToolbarItem(placement: .principal) {
                Button { showAgents = true } label: {
                    VStack(spacing: 1) {
                        HStack(spacing: 6) { BoardPicture(board: board, size: 20).accessibilityHidden(true); Text(board.displayName(me: state.me?.owner)).font(.headline).foregroundStyle(Theme.text.fixed(scheme)).lineLimit(1) }
                        HStack(spacing: Space.xs) {
                            if board.encrypted == true { Image(systemName: "lock.fill").font(.system(size: 9)).foregroundStyle(Theme.faint.fixed(scheme)) }
                            if !live.isEmpty { LiveDot(size: 6) }
                            Text(presence).font(Typo.micro.weight(.medium)).foregroundStyle((live.isEmpty ? Theme.faint : Theme.ok).fixed(scheme)).lineLimit(1)
                        }
                    }
                    .padding(.horizontal, Space.s)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("presence")
            }
        }
        // The title opens the board's info: what's open, who's here, files, search.
        .sheet(isPresented: $showAgents) {
            BoardInfoSheet(board: board) { seq in showAgents = false; jump(to: seq, after: 0.35) }
                .environment(\.chatDensity, density)
                .presentationDetents([.large]).presentationBackground(Theme.bg)
        }
        .sheet(item: $reactingTo) { r in
            EmojiPicker { emoji in reactingTo = nil; Task { await state.react(emoji, to: r.id, in: board) } }
                .presentationDetents([.height(300)]).presentationBackground(Theme.card)
        }
        .confirmationDialog("Unsend this message?", isPresented: Binding(get: { unsending != nil }, set: { if !$0 { unsending = nil } }), titleVisibility: .visible, presenting: unsending) { e in
            Button("Unsend", role: .destructive) { Task { await state.retract(e.seq, in: board) } }
        } message: { _ in Text("Everyone here will see it as unsent.") }
        .decisionPrompts($decisionPrompt, note: $decisionNote, board: board, state: state)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar) // inside a conversation the message box owns the bottom edge
        .task {
            // Where to open is settled by the server's fresh "seen up to" for you, before anything marks it read.
            await state.loadEntries(board)
            openAtFirstUnread()
            if newestSeen == nil { newestSeen = list.lazy.filter { $0.seq > 0 }.map(\.seq).max() ?? 0 }
            async let t: Void = state.loadTasks(board); async let a: Void = state.loadAgents(board); async let m: Void = state.loadMembers(board); _ = await (t, a, m)
            await state.markRead(board); await state.loadHandling(board); await state.markSeen(board)
        }
        .onChange(of: state.pulse) { _, p in if p?.board == board.id { Task { async let e: Void = state.loadEntries(board); async let t: Void = state.loadTasks(board); async let a: Void = state.loadAgents(board); _ = await (e, t, a); await state.markRead(board) } } }
        .onChange(of: list.last?.seq) { _, _ in Task { await state.markSeen(board) } } // you've seen what just landed
        // Shipped to production while you watch: about a second of confetti and the shipped buzz (Effects / Haptics).
        .onChange(of: list.last?.seq) { _, _ in celebrateShipped() }
        .overlay { Confetti(trigger: confetti).ignoresSafeArea() }
        // A long chat is laid out lazily (row heights are guesses until rows are made), so "the latest" keeps moving for a
        // moment after it opens: hold it there until it stops, unless you scroll up or a search hit sent you somewhere.
        .task(id: board.id) {
            for _ in 0..<12 {
                try? await Task.sleep(for: .milliseconds(150))
                guard stick, state.jumpRequest == nil, !Task.isCancelled else { return }
                position.scrollTo(edge: .bottom)
            }
        }
        .task(id: board.id) { await state.watch(board) } // live: ticks and new messages as they happen
        .task(id: board.id) { if board.isAgentChat { _ = await state.openAgentChat() } } // its sessions, fresh
        .refreshable { await state.loadEntries(board) }
    }

    /// One message in the chat: a day line or hairline above it when it starts something new, then the message.
    @ViewBuilder private func row(_ i: Int, _ r: Rows) -> some View {
        let e = r.shown[i]
        let prev = i > 0 ? r.shown[i - 1] : nil
        let newDay = prev.map { !Calendar.current.isDate(Date(timeIntervalSince1970: $0.ts / 1000), inSameDayAs: Date(timeIntervalSince1970: e.ts / 1000)) } ?? true
        let grouped = !newDay && prev != nil && prev!.author == e.author && prev!.via == e.via && e.ts - prev!.ts < 5 * 60_000 && e.type == "note" && e.replyTo == nil && e.seq != newAt
        let mine = isMine(e)
        let prevMine = prev.map { isMine($0) && $0.type != "task" } ?? false
        VStack(alignment: .leading, spacing: 0) {
            if newDay { DaySeparator(ts: e.ts) }
            // Where you'd read up to when the chat opened (jxn #1011).
            if e.seq == newAt { NewDivider() }
            // A hairline between separate messages from others (bubbles are separate already).
            else if !newDay, !(mine && e.type != "task") && !prevMine { Rectangle().fill(Theme.line.opacity(grouped ? 0.45 : 0.8)).frame(height: 0.5).padding(.leading, 38).padding(.top, grouped ? (density == .compact ? Space.xxs : Space.xs) : Space.gap(density)) }
            entryRow(e, grouped: grouped, mine: mine, r)
        }
    }

    private func entryRow(_ e: Entry, grouped: Bool, mine: Bool, _ r: Rows) -> EntryRow {
        let unsent = r.gone.contains(e.seq)
        let live = e.seq > 0 && e.pending != true && e.failed != true && !unsent
        let showReceipt = mine && live && (e.seq == r.latestMine || openReceipts.contains(e.seq))
        let hd = e.type == "decision" && !unsent ? state.decisions[board.id]?[e.seq] ?? e.humanDecision : nil
        return EntryRow(e: e, grouped: grouped, mine: mine, board: board.id, tasks: state.tasks[board.id] ?? [], reactions: state.reactions[board.id]?[e.seq] ?? [],
                        parent: e.replyTo.flatMap { r.bySeq[$0] }, me: me, members: state.members[board.id] ?? [], progress: state.uploads[e.seq],
                        reply: live ? { startReply(to: e) } : nil,
                        unsent: unsent, replies: r.replies[e.seq] ?? [], threadUnread: threadUnread(e.seq, r), handling: state.handling[board.id]?[e.seq], lit: flash == e.seq,
                        receipt: showReceipt ? receipt(for: e) : nil,
                        openReceipt: mine && live ? { if let r = receipt(for: e) { seenBy = r } } : nil,
                        actions: actions(for: e, mine: mine, live: live, r),
                        decision: hd, decisionActions: DecisionActions.make(hd, seq: e.seq, board: board, state: state) { p in decisionNote = ""; decisionPrompt = p }) {
            Task { if e.local != nil || e.isMultiFile { await state.retryUpload(e, in: board) } else { await state.send(e.text, to: board, retrying: e) } }
        }
    }

    private func actions(for e: Entry, mine: Bool, live: Bool, _ r: Rows) -> EntryActions {
        var a = EntryActions()
        a.openProfile = { name, agent in profile = ProfileTarget(name: name, agent: agent) }
        if live {
            a.react = { emoji in Task { await state.react(emoji, to: e.seq, in: board) } }
            a.moreReactions = { reactingTo = SeqRef(id: e.seq) }
            let root = rootOf(e, in: r.bySeq)
            a.openThread = { focused = false; thread = ThreadTarget(root: root, focus: e.replyTo != nil ? e.seq : nil) }
            if mine {
                a.unsend = { unsending = e }
                a.toggleReceipt = { withAnimation(.snappy) { if openReceipts.contains(e.seq) { openReceipts.remove(e.seq) } else { openReceipts.insert(e.seq) } } }
            }
            if forMe(e) { a.takeOn = { Task { await state.takeOn(e.seq, in: board) } } }
        }
        // A reply's quote bar: its thread, over the chat, on this reply (jxn #1040).
        if e.replyTo != nil, e.seq > 0 { let root = rootOf(e, in: r.bySeq); a.jumpToParent = { focused = false; thread = ThreadTarget(root: root, focus: e.seq) } }
        return a
    }

    /// Reply (swipe right, or long-press → Reply): the message's thread opens over the chat, its box answering that
    /// message and starting with who wrote it, like the web: "@theo ", "@theo's agent ", and your own agent's posts too
    /// ("@maya's agent ", #975); only your own messages start empty.
    private func startReply(to e: Entry) {
        focused = false
        thread = ThreadTarget(root: rootOf(e, in: Dictionary(list.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })),
                              prefill: Self.replyHandle(e, me: me), replyTo: e.seq)
    }

    /// What a reply to this message starts with: "@who " (a person, or their agent: yours too), nil for your own.
    static func replyHandle(_ e: Entry, me: String?) -> String? {
        if e.author == me && e.via != "agent" { return nil }
        return "@" + (e.byAgent ? "\(e.author)'s agent" : e.author) + " "
    }

    /// A shipped change card that arrived since the chat opened (never one already here, scrolled back into view).
    private func celebrateShipped() {
        let top = list.lazy.filter { $0.seq > 0 }.map(\.seq).max() ?? 0
        guard let seen = newestSeen else { newestSeen = top; return }
        newestSeen = max(seen, top)
        guard list.contains(where: { $0.seq > seen && $0.type == "change" && $0.text.localizedCaseInsensitiveContains("shipped") }) else { return }
        Haptics.play(.shipped)
        confetti += 1
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
            // (A reply is in the chat like any message now, jxn #1040: it scrolls there too.)
            guard list.contains(where: { $0.seq == seq && $0.retracts == nil }) else { Haptics.play(.warning); return }
            stick = false
            if focused { // the keyboard would cover it: let it go down first, then scroll
                focused = false
                try? await Task.sleep(nanoseconds: 350_000_000)
            }
            scrollRequest = ScrollRequest(id: seq, anchor: .center, animated: true)
            try? await Task.sleep(nanoseconds: 300_000_000)
            withAnimation(.smooth(duration: 0.25)) { flash = seq }
            try? await Task.sleep(nanoseconds: 1_300_000_000)
            withAnimation(.smooth(duration: 0.8)) { if flash == seq { flash = nil } }
        }
    }

    /// Opens the chat at your first unread message (jxn #1011), like the web: a thin "New" line above it, and Jump to
    /// latest below. Nothing unread (or your first visit): the latest, as it opened. Your own messages never count as
    /// unread (your agent's do). Once per visit, from the server's "seen up to" for you; not when a search hit or a
    /// link sent you somewhere, nor once you've scrolled yourself.
    private func openAtFirstUnread() {
        guard !unreadResolved else { return }
        unreadResolved = true
        guard state.jumpRequest == nil, !userScrolled, let me, let seen = state.reads[board.id]?[me]?.personSeen, seen > 0,
              let first = list.first(where: { $0.seq > seen && $0.retracts == nil && !isMine($0) }) else { return }
        newAt = first.seq
        stick = false
        // The lazy layout guesses row heights until rows are made: hold it there while it settles.
        Task {
            for _ in 0..<10 {
                guard !userScrolled, newAt == first.seq, !Task.isCancelled else { break }
                scrollRequest = ScrollRequest(id: first.seq, anchor: .top, animated: false)
                try? await Task.sleep(nanoseconds: 150_000_000)
            }
            if atBottom { stick = true } // everything unread fits: stay with the latest
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

    /// The message box (ChatComposer.swift, the same one threads use).
    var composer: some View {
        ChatComposer(board: board, draft: $draft, focused: $focused, placeholder: placeholder,
                     toSession: board.isAgentChat ? $toSession : nil)
    }

    /// "Message theo", "Message Checkout bug", "Message your agent…" / "Message builder…".
    private var placeholder: String {
        if board.isAgentChat { return toSession.map { "Message \($0)…" } ?? "Message your agent…" }
        return board.kind == "direct" ? "Message \(board.displayName(me: state.me?.owner))" : "Message \(board.title)"
    }
}

/// The message box's measures: its two round buttons the same size, the same distance in from each end, centred on
/// a single line of text and pinned to the last line as it grows; even room between the text and each button.
enum Composer {
    static let button: CGFloat = 32
    static let inset: CGFloat = 6 // from the box's inner edge to a button
    static let line: CGFloat = button + 2 * inset // one line of text is this tall, so the buttons sit on its centre
    static let gap: CGFloat = 6 // between the text and a button
}

extension View {
    /// A message-box button: a 32 pt circle, inset evenly from the box's edge.
    func composerCircle(fill: Color) -> some View {
        frame(width: Composer.button, height: Composer.button)
            .background(fill, in: Circle())
            .padding(Composer.inset)
            .contentShape(Rectangle())
    }
}

/// A scroll the chat should make (to a message, by its id).
struct ScrollRequest: Equatable { let id: Int; let anchor: UnitPoint; let animated: Bool }
/// A message, by number, for sheets that open on one.
struct SeqRef: Identifiable { let id: Int }
/// A thread to open: its root, what its box starts with (a reply's @mention), and an answer to show.
/// `replyTo`: the message its box answers (a reply started on one message); nil: the thread's root.
struct ThreadTarget: Hashable, Identifiable { let root: Int; var prefill: String? = nil; var focus: Int? = nil; var replyTo: Int? = nil; var id: Int { root } }

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
    var decision: HumanDecision? = nil // a person's decision: where it stands, and your vote / close
    var decisionActions = DecisionActions()
    var retry: () -> Void = {}
    @State var drag: CGFloat = 0 // swipe right to reply
    @Environment(\.chatDensity) private var density
    @Environment(\.refTitle) private var refTitle
    /// Room above a message: tight under the one before when grouped, a little more otherwise (less when compact).
    private func gapAbove(_ comfortable: CGFloat) -> CGFloat {
        density == .compact ? (grouped ? Space.xxs : Space.gap(density)) : (grouped ? Space.xs : comfortable)
    }

    private var who: String { e.byAgent ? "\(e.author)'s agent" : e.author }
    private static let replyAt: CGFloat = 56
    private var replyAt: CGFloat { Self.replyAt }
    static let quick = ["👍", "❤️", "😂", "🎉", "👀", "✅"]

    /// Agents' 👀 / ✅ are read receipts (the quiet line); everything else is a reaction chip.
    private var receipts: [Reaction] {
        reactions.compactMap { r in
            guard Self.receiptEmoji.contains(r.emoji) else { return nil }
            let agents = r.users.filter(Self.isAgent)
            return agents.isEmpty ? nil : Reaction(emoji: r.emoji, users: agents)
        }
    }
    private var chips: [Reaction] {
        reactions.compactMap { r in
            let people = Self.receiptEmoji.contains(r.emoji) ? r.users.filter { !Self.isAgent($0) } : r.users
            return people.isEmpty ? nil : Reaction(emoji: r.emoji, users: people)
        }
    }
    /// A message's link, as the web addresses it.
    static func link(board: String, seq: Int) -> String { API.shared.base.appendingPathComponent("b/\(board)").absoluteString + "#e\(seq)" }

    static func isAgent(_ u: String) -> Bool { u.hasSuffix("'s agent") || u.contains("/") }
    /// An agent's 🤔 (picked it up; 👀 on older messages) and ✅ (answered): read receipts, not reactions.
    static let receiptEmoji: Set<String> = ["🤔", "👀", "✅"]

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
                if !unsent { Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = e.text; Haptics.play(.copied) } }
                // The message's address (its number is in it, for agents and the web): /b/<board>#e<seq>.
                if e.seq > 0, !board.isEmpty { Button("Copy link", systemImage: "link") { UIPasteboard.general.string = Self.link(board: board, seq: e.seq); Haptics.play(.copied) } }
                if e.failed == true { Button("Retry", systemImage: "arrow.clockwise", action: retry) }
                if let unsend = actions.unsend { Button("Unsend", systemImage: "arrow.uturn.backward", role: .destructive, action: unsend) }
            }
            .gesture(SwipeToReply(changed: { dx in
                guard reply != nil else { return }
                let d = dx < replyAt ? dx : replyAt + (dx - replyAt) * 0.25 // rubber band past the threshold
                if drag < replyAt && d >= replyAt { Haptics.play(.armed) } // once, crossing into "will reply"
                drag = d
            }, ended: { _ in
                if drag >= replyAt { reply?() }
                withAnimation(.spring(duration: 0.35, bounce: 0.3)) { drag = 0 }
            }))
    }

    /// What this message answers, as a small bar above it ("↩ theo: the first line…", like the web's, jxn #1040).
    /// Tap: the thread, on this reply (in a thread: scrolls to what it answers). Numbers read as titles (#675).
    @ViewBuilder private var quote: some View {
        if e.replyTo != nil {
            let name = parent.map { $0.byAgent ? "\($0.author)'s agent" : ($0.author == me && $0.via != "agent" ? "You" : $0.author) }
            let line = parent.map { ThreadPreview.line($0).plainRefs(refTitle.callAsFunction) } ?? "an earlier message"
            Button { actions.jumpToParent?() } label: {
                HStack(spacing: 0) {
                    RoundedRectangle(cornerRadius: 1.5, style: .continuous).fill(Theme.faint.opacity(0.7)).frame(width: 3)
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Image(systemName: "arrow.turn.up.left").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.faint)
                        (Text(name ?? "An earlier message").fontWeight(.semibold).foregroundColor(Theme.text.opacity(0.9)) + Text(name == nil ? "" : ": " + line))
                            .font(Typo.micro).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                    .padding(.leading, 7).padding(.trailing, 10).padding(.vertical, 4)
                }
                .fixedSize(horizontal: false, vertical: true)
                .background(Theme.card, in: UnevenRoundedRectangle(cornerRadii: .init(topLeading: 2, bottomLeading: 2, bottomTrailing: 8, topTrailing: 8), style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(PressStyle())
            .disabled(actions.jumpToParent == nil)
            .padding(.vertical, 1)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Reply to \(name ?? "an earlier message")" + (name == nil ? "" : ": " + line))
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("reply-quote")
            .accessibilityHint("Opens the thread")
        }
    }

    /// A question, a claim, a decision: said in words, not as a type tag.
    private var kind: String? {
        switch e.type {
        case "note", "task", "artifact", "change": return nil // a file, a task, a change: each shows as itself
        default: return e.type.prefix(1).uppercased() + e.type.dropFirst()
        }
    }

    /// The words under a picture or file; nil when they'd only repeat its name ("Shared photo.jpg", "Shared 3 images").
    private var caption: String? {
        if let a = e.artifactName, e.text == "Shared \(a)" || e.text.isEmpty { return nil }
        if e.isMultiFile, e.text.range(of: "^Shared \\d+ (images|files)$", options: .regularExpression) != nil { return nil }
        return e.text
    }

    /// A picture inline, or a file as a chip.
    @ViewBuilder private var attachment: some View {
        if e.artifactName != nil && !unsent {
            if e.isMultiFile { MultiAttachment(e: e, board: board, progress: progress) }
            else if e.isImage { ChatImage(e: e, board: board, progress: progress) } else { FileChip(e: e, board: board, progress: progress) }
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
                let m = caption.mentioned(e.mentions, members: members, me: me, refTitle: refTitle.callAsFunction)
                m.text.textRenderer(MentionBoxes())
                    .font(Typo.body).foregroundStyle(Theme.text.opacity(e.pending == true ? 0.55 : 1))
                    .accessibilityValue(m.handles.isEmpty ? "" : "Mentions " + m.handles.joined(separator: ", "))
                    .padding(.horizontal, Space.m + 1).padding(.vertical, Space.row(density))
                    .background(Theme.raised, in: RoundedRectangle(cornerRadius: Radius.bubble, style: .continuous))
                    .onTapGesture { actions.toggleReceipt?() }
            }
            if let decision, !unsent { HumanDecisionCard(hd: decision, me: me, trailing: true, actions: decisionActions) }
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
        .padding(.top, gapAbove(Space.m))
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
                    let m = caption.mentioned(e.mentions, members: members, me: me, refTitle: refTitle.callAsFunction)
                    m.text.textRenderer(MentionBoxes()).font(Typo.body).foregroundStyle(Theme.text.opacity(0.92)).lineSpacing(1.5)
                        .accessibilityValue(m.handles.isEmpty ? "" : "Mentions " + m.handles.joined(separator: ", "))
                }
                if let decision, !unsent { HumanDecisionCard(hd: decision, me: me, actions: decisionActions).padding(.top, Space.xs) }
                footer
            }
        }
        .padding(.top, gapAbove(Space.s + 2))
    }
}

/// Where your unread messages start (jxn #1011): "NEW" and a thin line, in the web's red.
struct NewDivider: View {
    var body: some View {
        HStack(spacing: Space.s) {
            Text("New").textCase(.uppercase).font(Typo.micro.weight(.semibold)).tracking(0.7).foregroundStyle(Theme.danger)
            Rectangle().fill(Theme.danger.opacity(0.45)).frame(height: 0.5)
        }
        .padding(.top, Space.m).padding(.bottom, Space.xxs)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("New messages")
        .accessibilityIdentifier("new-divider")
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
        Button { if t != nil { open = true } } label: {
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Group {
                        if let t { ProgressRing(task: t).frame(width: Metrics.glyph, height: Metrics.glyph) } else {
                            Image(systemName: "circle.dashed").font(.system(size: 15)).foregroundStyle(Theme.muted).frame(width: Metrics.glyph, height: Metrics.glyph)
                        }
                    }
                    .onFirstLine()
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
                let receipt = EntryRow.receiptEmoji.contains(r.emoji)
                HStack(spacing: 3) {
                    Text(r.emoji).font(.caption2)
                    Text(receipt ? names(r.users) : "\(r.users.count)").font(.caption2).foregroundStyle(r.emoji == "✅" ? Theme.ok : Theme.faint).lineLimit(1)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(receipt ? "\(r.emoji == "✅" ? "Done" : "Seen, working"): \(names(r.users))" : "\(r.emoji) \(r.users.count)")
            }
        }
        .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
        .padding(.top, 2)
        .transition(.opacity)
    }
    private func names(_ users: [String]) -> String { users.count <= 2 ? users.joined(separator: ", ") : "\(users[0]) and \(users.count - 1) more" }
}
