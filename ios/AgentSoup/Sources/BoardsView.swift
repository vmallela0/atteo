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
    @State private var invitingAgent = false // "Invite an agent", from the empty chat (InviteAgent.swift)
    @State private var invitePage: [InviteAgentSheet.Page] = [] // its page, kept here (InviteAgentSheet.path)
    @State private var talking = false // the voice chat sheet, from the phone at the top right (vedu #1783)
    @ObservedObject private var talkStatus = TalkStatus.shared // the phone shows once voice is set up on the server
    private var live: [BoardAgent] { (state.boardAgents[board.id] ?? []).filter { $0.state == "live" } }
    /// "theo's agent working", "theo and maya's agents working", "3 agents working", or "No agents working now".
    private var presence: String {
        var users: [String] = []
        for a in live where !users.contains(a.user) { users.append(a.user) }
        switch users.count {
        case 0:
            if board.encrypted == true { return String(localized: "End-to-end encrypted", bundle: .l10n) }
            return Vocab.pick(String(localized: "No agents working now", bundle: .l10n), String(localized: "No assistants working now", bundle: .l10n))
        case 1: return Vocab.pick(String(localized: "\(users[0])'s agent working", bundle: .l10n), String(localized: "\(users[0].capitalizedFirst)'s assistant working", bundle: .l10n))
        case 2: return Vocab.pick(String(localized: "\(users[0]) and \(users[1])'s agents working", bundle: .l10n), String(localized: "\(users[0].capitalizedFirst) and \(users[1].capitalizedFirst)'s assistants working", bundle: .l10n))
        default: return Vocab.pick(String(localized: "\(users.count) agents working", bundle: .l10n), String(localized: "\(users.count) assistants working", bundle: .l10n))
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
    @State private var quiet = QuietBox() // where the list is while it's being put at the first unread (not drawn)
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
    /// Scrolled up to read: the newest message when you left the latest. What lands after it is counted on the pill
    /// ("3 new messages"), and the list stays where you are (jxn #1366, #1367; the web's unseen).
    @State private var unseenAfter: Int?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The People filter (jxn #1731, vedu #1060; the web's Hide agents): only what people wrote, their replies included.
    /// For you only, remembered for this board on this phone. Never on "Your agent" (it's all your agents there).
    @State private var peopleOnly: Bool

    init(board: Board) {
        self.board = board
        _peopleOnly = State(initialValue: !board.isAgentChat && UserDefaults.standard.bool(forKey: Self.filterKey(board.id)))
    }
    static func filterKey(_ board: String) -> String { "people-filter.\(board)" }
    /// `follow`: at the latest, stay there as rows leave or come back (the web's toBottom while pinned); a jump to a
    /// message doesn't (it scrolls there itself).
    private func setPeopleOnly(_ on: Bool, follow: Bool = true) {
        let pinned = follow && (stick || atBottom)
        withAnimation(.smooth(duration: 0.25)) { peopleOnly = on }
        if on { UserDefaults.standard.set(true, forKey: Self.filterKey(board.id)) } else { UserDefaults.standard.removeObject(forKey: Self.filterKey(board.id)) }
        guard pinned else { return }
        stick = true
        Task {
            for _ in 0..<4 { // the lazy layout settles over a few passes
                try? await Task.sleep(for: .milliseconds(120))
                position.scrollTo(edge: .bottom)
            }
        }
    }
    /// Hidden by the People filter: an agent's post.
    private func filteredOut(_ e: Entry) -> Bool { peopleOnly && e.byAgent }
    /// Kept in its thread (Settings → Display → Replies: Only in threads, vedu #2360): a reply whose thread's first
    /// message is in the chat, which says "N replies" for it. One whose first message isn't loaded, or is hidden, stays
    /// in the chat, so a reply is never out of sight altogether.
    private func folded(_ e: Entry, in bySeq: [Int: Entry]) -> Bool {
        guard state.display.repliesInThread, e.replyTo != nil, e.retracts == nil,
              let root = bySeq[rootOf(e, in: bySeq)], root.seq != e.seq, root.retracts == nil, !filteredOut(root) else { return false }
        return true
    }

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
        var openQuestions: Set<Int> = [] // unanswered questions (a quick reply shows only under an open one)
    }

    private func rows() -> Rows {
        let bySeq = Dictionary(list.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })
        // Retractions aren't messages: their targets read "Unsent" instead.
        let gone = Set(list.compactMap(\.retracts))
        // Every message in order, replies included (jxn #1040): a reply lands at the bottom like any message, under a
        // bar quoting what it answers; the message it answers says "3 replies", which opens the thread.
        // (The People filter leaves agents' posts out of what's shown only: a person's reply still quotes what it answers.)
        // Replies only in their thread (Settings → Display): the chat keeps just the message they answer and its "N replies".
        let shown = list.filter { $0.retracts == nil && !filteredOut($0) && !folded($0, in: bySeq) }
        let replies = Dictionary(grouping: list.filter { $0.replyTo != nil && $0.retracts == nil && $0.seq > 0 && !gone.contains($0.seq) }, by: { rootOf($0, in: bySeq) })
        let latestMine = shown.last { isMine($0) && $0.seq > 0 && $0.type != "task" && !gone.contains($0.seq) }?.seq
        let open = state.quickChips[board.id]?.isEmpty == false ? Set(ChatSummary.open(list).questions.map(\.seq)) : []
        return Rows(shown: shown, bySeq: bySeq, gone: gone, replies: replies, latestMine: latestMine, openQuestions: open)
    }

    private var anyUnreadThread: Bool { ThreadIndex.threads(list).contains { threadSeen.unread(board.id, $0, me: me) } }

    // ("#123" in messages, checklists and the task sheets reads as that message's title.)
    var body: some View { threads(chat).refTitles(list, tasks: state.tasks[board.id] ?? []) }

    /// Threads: over the chat as a sheet (a reply, "N replies", a reply's quote bar), and the list of them in the top bar.
    private func threads(_ v: some View) -> some View {
        v
        // Tapping into the message box (#842): to the latest, pinned there as the keyboard comes up and the box
        // grows (the sizeChanges anchor), until you scroll up to read, which unpins it. While it's still being put at
        // your first unread, that stops and takes it to the latest instead (openAtFirstUnread).
        .onChange(of: focused) { _, on in
            guard on else { return }
            stick = true
            guard !quiet.on else { return }
            withAnimation(.smooth(duration: 0.3)) { position.scrollTo(edge: .bottom) }
            // The rows between where you were and the end are only guesses until they're made, and the keyboard is
            // coming up meanwhile: the first scroll can land short. Once it's done, make sure.
            Task {
                try? await Task.sleep(for: .milliseconds(350))
                for _ in 0..<3 {
                    guard stick, focused, !Task.isCancelled else { return }
                    position.scrollTo(edge: .bottom)
                    try? await Task.sleep(for: .milliseconds(150))
                }
            }
        }
        // iMessage-style: the thread slides up over the chat, with the same message box as the chat (jxn #1040, #1094).
        .sheet(item: $thread) { t in
            NavigationStack { ThreadView(board: board, root: t.root, prefill: t.prefill, focus: t.focus, replyTo: t.replyTo, overChat: true, closes: true, carry: t.carries ? $draft : nil) }
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
                .accessibilityValue(anyUnreadThread ? Text("new replies") : Text(verbatim: ""))
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button(Vocab.tasks, systemImage: "checklist") { workPane = .tasks }
                    Button("Files", systemImage: "doc.on.doc") { workPane = .files }
                    if !board.isAgentChat {
                        Divider()
                        // Only messages people wrote (the web's Hide agents): for you, on this board.
                        Toggle(isOn: Binding(get: { peopleOnly }, set: { on in Haptics.play(.touch); setPeopleOnly(on) })) {
                            Label(Vocab.pick(String(localized: "Hide agents", bundle: .l10n), String(localized: "Hide assistants", bundle: .l10n)), systemImage: "person")
                        }
                        .accessibilityIdentifier("people-filter")
                    }
                } label: { ToolbarIcon("square.stack") }
                .accessibilityIdentifier("work-menu")
                .accessibilityLabel(Vocab.pick(String(localized: "Tasks and files", bundle: .l10n), String(localized: "To-dos and files", bundle: .l10n)))
            }
            // Voice chat with Atteo, like a call, at the top right (vedu #1783): the message box keeps the mic for dictation.
            if talkStatus.enabled == true {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { focused = false; Haptics.play(.touch); talking = true } label: { ToolbarIcon("phone") }
                        .accessibilityIdentifier("talk")
                        .accessibilityLabel("Voice chat with Atteo")
                        .accessibilityHint("Opens a live, hands-free voice chat.")
                }
            }
        }
        .task { await talkStatus.load() }
        .fullScreenCover(isPresented: $talking) { TalkSheet(board: board) }
        .sheet(isPresented: $invitingAgent) { InviteAgentSheet(board: board, path: $invitePage).presentationDetents([.large]).presentationBackground(Theme.bg) }
        // A "#123" in a message: go to it (or open its thread, if it's an answer).
        .environment(\.openURL, OpenURLAction { url in
            if let p = personLink(url) { profile = p; return .handled }
            if let g = groupLink(url) { group = g; return .handled }
            guard let n = entryLink(url) else { return .systemAction }
            jump(to: n)
            return .handled
        })
        .sheet(item: $group) { g in GroupSheet(board: board, agents: g.agents, all: g.all).presentationDetents([.medium, .large]).presentationBackground(Theme.bg) }
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
        let unseen = unseenCount(r)
        let pillShown = !stick && !atBottom && unseen > 0
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
                // Older history is lazy; the newest messages (30 to 50) are made up front. A lazy list near its end has
                // only guessed heights for rows it hasn't made, and when something changed size while it was being
                // scrolled there (opening at the first unread as tasks and members load, coming back from a thread,
                // a reply folding into its thread), the guesses flipped every frame: SwiftUI's layout never settled
                // and the chat froze, or came back blank (vedu #2449). Real heights at the end can't flip. The split
                // moves in steps of 20, so a new message doesn't move a row from one stack to the other each time.
                let tail = Self.tailStart(r.shown.count)
                VStack(alignment: .leading, spacing: 0) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(r.shown[..<tail].enumerated()), id: \.element.id) { i, e in
                            row(i, r)
                                .id(e.id)
                                .transition(.asymmetric(insertion: insertion(e), removal: .opacity))
                        }
                    }
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(r.shown[tail...].enumerated()), id: \.element.id) { j, e in
                            row(tail + j, r)
                                .id(e.id)
                                .transition(.asymmetric(insertion: insertion(e), removal: .opacity))
                        }
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
            // Nothing said yet: how agents get here, and "Invite an agent" (the web's empty board), in the middle.
            .overlay {
                if state.entries[board.id] != nil && r.shown.isEmpty && !peopleOnly && board.invitesAgents {
                    EmptyChatInvite(board: board) { focused = false; invitePage = []; invitingAgent = true }
                        .transition(.opacity)
                }
            }
            // At the latest: the visible part (which includes what's under the composer) reaches the end.
            .onScrollGeometryChange(for: Bool.self) { g in g.visibleRect.maxY >= g.contentSize.height - 80 } action: { _, bottom in
                // While it's being put at your first unread, nothing here changes the chat: a change drawn mid-scroll
                // (this flag, the pill's count, an animation) kept SwiftUI's lazy layout from settling when the first
                // unread was near the end, and the app froze on opening. It's applied once that's done.
                quiet.bottom = bottom
                guard !quiet.on else { return }
                if bottom != atBottom { atBottom = bottom }
                // Back at the latest: nothing's unseen.
                if bottom, unseenAfter != nil { unseenAfter = nil }
            }
            // Away from the latest and something new lands: count from what was newest before it (the pill). Set here,
            // not as you leave the latest: written from the scroll geometry, it re-drew the chat mid-layout each time the
            // list crossed the bottom line, and opening at the first unread near the end froze the app (SwiftUI's lazy
            // layout never settled).
            .onChange(of: newestSeq) { old, _ in
                if !atBottom, unseenAfter == nil, old > 0 { unseenAfter = old }
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
            // Scrolled up and something arrived: "3 new messages ↓" (the web's pill), which takes you down to them.
            .overlay(alignment: .bottom) {
                ZStack {
                    if pillShown {
                        let words = String(localized: "\(unseen) new messages", bundle: .l10n)
                        Button { toLatest() } label: {
                            HStack(spacing: Space.xs) {
                                Text(words).font(Typo.micro.weight(.semibold)).contentTransition(.numericText())
                                Image(systemName: "arrow.down").font(.system(size: 11, weight: .bold))
                            }
                            .foregroundStyle(Theme.text)
                            .padding(.horizontal, Space.m).frame(height: 32)
                            .background(Theme.raised, in: Capsule())
                            .shadow(color: .black.opacity(0.35), radius: 8, y: 2)
                            .frame(minHeight: 44).contentShape(Capsule())
                        }
                        .buttonStyle(PressStyle())
                        .padding(.bottom, Space.xs)
                        .transition(.scale(scale: 0.8).combined(with: .opacity))
                        .accessibilityLabel(words)
                        .accessibilityHint(String(localized: "Jump to latest", bundle: .l10n))
                        .accessibilityIdentifier("new-messages-pill")
                    }
                }
                .animation(.snappy, value: pillShown)
                .animation(.snappy, value: unseen)
            }
            .overlay(alignment: .bottomTrailing) {
                ZStack {
                    if !atBottom && !list.isEmpty && !pillShown {
                        Button { toLatest() } label: {
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
                .animation(.snappy, value: atBottom) // (animated here, not with withAnimation from the scroll geometry)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                // Everyday: Chat · To-dos · Files under the title (Everyday.swift); Developer mode: the work strip.
                if Vocab.everyday { EverydayChatTabs(tasks: state.tasks[board.id] ?? []) { workPane = $0 } }
                else { WorkStrip(tasks: state.tasks[board.id] ?? []) { showTasks = true } }
                // The People filter is on: says so, one tap shows everything again.
                if peopleOnly {
                    PeopleFilterStrip(empty: state.entries[board.id] != nil && r.shown.isEmpty) { Haptics.play(.touch); setPeopleOnly(false) }
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
        }
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
        let grouped = !newDay && prev != nil && prev!.senderKey == e.senderKey && e.ts - prev!.ts < 5 * 60_000 && e.type == "note" && e.replyTo == nil && e.seq != newAt
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
        let chips = live && r.openQuestions.contains(e.seq) ? state.quickChips[board.id]?[e.seq] : nil
        return EntryRow(e: e, grouped: grouped, mine: mine, board: board.id, tasks: state.tasks[board.id] ?? [], reactions: state.reactions[board.id]?[e.seq] ?? [],
                        parent: e.replyTo.flatMap { r.bySeq[$0] }, me: me, members: state.members[board.id] ?? [], progress: state.uploads[e.seq],
                        reply: live ? { startReply(to: e) } : nil,
                        unsent: unsent, replies: r.replies[e.seq] ?? [], threadUnread: threadUnread(e.seq, r), handling: state.handling[board.id]?[e.seq], lit: flash == e.seq,
                        receipt: showReceipt ? receipt(for: e) : nil,
                        openReceipt: mine && live ? { if let r = receipt(for: e) { seenBy = r } } : nil,
                        actions: actions(for: e, mine: mine, live: live, r),
                        decision: hd, decisionActions: DecisionActions.make(hd, seq: e.seq, board: board, state: state) { p in decisionNote = ""; decisionPrompt = p },
                        agentName: state.agentNames[board.id]?[e.author]?.name, quick: state.favouriteReactions, agentNames: state.agentNameMap(board.id),
                        replyChips: chips, pickChip: { text in Task { await state.send(text, to: board, replyTo: e.seq) } }) {
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
            if !board.isAgentChat { a.remember = { Task { await state.remember(e.seq, in: board.id) } } }
        }
        // A reply's quote bar: its thread, over the chat, on this reply (jxn #1040).
        if e.replyTo != nil, e.seq > 0 { let root = rootOf(e, in: r.bySeq); a.jumpToParent = { focused = false; thread = ThreadTarget(root: root, focus: e.seq) } }
        return a
    }

    /// Reply (swipe right, or long-press → Reply): the message's thread opens over the chat, its box answering that
    /// message and starting with who wrote it, like the web: "@theo ", "@theo's agent ", and your own agent's posts too
    /// ("@maya's agent ", #975); only your own messages start empty. What you'd typed comes along after it, and comes
    /// back here if you cancel the reply instead of sending it (vedu #1469).
    private func startReply(to e: Entry) {
        focused = false
        thread = ThreadTarget(root: rootOf(e, in: Dictionary(list.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })),
                              prefill: Self.replyHandle(e, me: me), replyTo: e.seq, carries: true)
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
        let arrived = list.filter { $0.seq > seen && $0.pending != true && $0.retracts == nil }
        // Read replies aloud (Voice.swift): a message for you blips and waits in the bar.
        for e in arrived where forMeToHear(e) { ReadAloud.shared.heard(e, from: e.byAgent ? agentLabel(e.author, e.agentName ?? state.agentNames[board.id]?[e.author]?.name) : e.author, in: board) }
        guard arrived.contains(where: { $0.type == "change" && $0.text.localizedCaseInsensitiveContains("shipped") }) else { return }
        Haptics.play(.shipped)
        confetti += 1
    }

    /// For you, to hear (the web's forMe): in "Your agent", anything your agent says; on a board, a mention of you or a
    /// reply to something you wrote. Never your own.
    private func forMeToHear(_ e: Entry) -> Bool {
        guard let me = me?.lowercased(), !isMine(e) else { return false }
        if board.isAgentChat { return e.byAgent }
        if (e.mentions ?? []).contains(where: { $0.user.lowercased() == me && !$0.agent }) { return true }
        if let p = e.replyTo, let parent = list.first(where: { $0.seq == p }) { return isMine(parent) }
        return false
    }

    /// Scrolls to a message and lights it for a moment, loading older messages first if it's before what's here.
    private func jump(to seq: Int, after delay: Double = 0) {
        Task {
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1e9)) }
            // An agent's post, with the People filter on: show everything again first (the web's "Showing agents' posts").
            if peopleOnly, list.first(where: { $0.seq == seq })?.byAgent == true { setPeopleOnly(false, follow: false) }
            // Further back than what's loaded: bring it in (pages of up to 500, until it's here).
            var tries = 0
            while !list.contains(where: { $0.seq == seq }), tries < 20, (state.firstLoaded(board) ?? 0) > seq {
                holdBottom = true
                guard await state.loadEarlier(board, through: seq) || list.contains(where: { $0.seq == seq }) else { break }
                tries += 1
            }
            if holdBottom { try? await Task.sleep(nanoseconds: 250_000_000); holdBottom = false }
            if peopleOnly, list.first(where: { $0.seq == seq })?.byAgent == true { setPeopleOnly(false, follow: false); try? await Task.sleep(nanoseconds: 250_000_000) }
            // (A reply is in the chat like any message now, jxn #1040: it scrolls there too.)
            guard let target = list.first(where: { $0.seq == seq && $0.retracts == nil }) else { Haptics.play(.warning); return }
            // Unless replies stay in their threads: then its thread opens at it.
            let bySeq = Dictionary(list.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })
            if folded(target, in: bySeq) { focused = false; thread = ThreadTarget(root: rootOf(target, in: bySeq), focus: seq); return }
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
    /// link sent you somewhere, nor once you've scrolled yourself or tapped into the message box (that's the latest).
    private func openAtFirstUnread() {
        guard !unreadResolved else { return }
        unreadResolved = true
        let bySeq = Dictionary(list.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })
        guard state.jumpRequest == nil, !userScrolled, !focused, let me, let seen = state.reads[board.id]?[me]?.personSeen, seen > 0,
              let first = list.first(where: { $0.seq > seen && $0.retracts == nil && !isMine($0) && !filteredOut($0) && !folded($0, in: bySeq) }) else { return }
        newAt = first.seq
        stick = false
        quiet.on = true
        // The lazy layout guesses row heights until rows are made: hold it there while it settles.
        Task {
            for _ in 0..<10 {
                guard !userScrolled, !focused, newAt == first.seq, !Task.isCancelled else { break }
                scrollRequest = ScrollRequest(id: first.seq, anchor: .top, animated: false)
                try? await Task.sleep(nanoseconds: 150_000_000)
            }
            // Tapped into the message box meanwhile (#842): to the latest instead, still quiet until it's there (these
            // passes would otherwise put it back at the first unread, and leave it pinned short of the end).
            if focused {
                for _ in 0..<4 {
                    position.scrollTo(edge: .bottom)
                    try? await Task.sleep(nanoseconds: 120_000_000)
                }
            }
            quiet.on = false
            atBottom = quiet.bottom
            // Everything unread fits, or you're typing: stay with the latest. (A tap into the box and back out meanwhile
            // leaves it at the first unread, not pinned.)
            stick = atBottom || focused
        }
    }

    /// Where the chat's eagerly made tail starts: the newest 30 to 50 rows, the boundary moving in steps of 20.
    static func tailStart(_ count: Int) -> Int { count <= 50 ? 0 : (count - 30) / 20 * 20 }

    /// The newest message here (sending ones aside).
    private var newestSeq: Int { list.lazy.map(\.seq).max().map { max($0, 0) } ?? 0 }

    /// Messages from others that landed since you scrolled up (the People filter's hidden ones don't count).
    private func unseenCount(_ r: Rows) -> Int {
        guard let base = unseenAfter else { return 0 }
        return r.shown.lazy.filter { $0.seq > base && !isMine($0) }.count
    }

    /// The pill and the chevron: down to the latest, pinned there again.
    private func toLatest() {
        stick = true
        unseenAfter = nil
        withAnimation(.smooth(duration: 0.35)) { position.scrollTo(edge: .bottom) }
    }

    /// How a message comes into the chat. One that lands while you're here rises in lightly (8pt, 0.2s, like the web's
    /// entryin, jxn #1366); with Reduce Motion it just appears. What was here when it opened, or older history loading
    /// above, doesn't move (a People filter toggle only fades rows back).
    private func insertion(_ e: Entry) -> AnyTransition {
        guard let seen = newestSeen, e.seq > seen || e.seq < 0 else { return .opacity }
        // Yours rose in as it was sent; the delivered copy takes the sending one's place without a second rise.
        if reduceMotion || (e.seq > 0 && isMine(e)) { return .identity }
        return AnyTransition.opacity.combined(with: .offset(y: 8)).animation(.easeOut(duration: 0.2))
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
        if seen.isEmpty { return Receipt(text: String(localized: "Delivered", bundle: .l10n), level: 0, readers: who) }
        if seen.count == who.count { return Receipt(text: String(localized: "Seen by everyone", bundle: .l10n), level: 2, readers: who) }
        let names = seen.map(\.label).joined(separator: ", ")
        return Receipt(text: String(localized: "Seen by \(names)", bundle: .l10n), level: 1, readers: who)
    }

    // MARK: - The message box

    /// The message box (ChatComposer.swift, the same one threads use).
    var composer: some View {
        VStack(spacing: 0) {
            ReadAloudBar(board: board.id) // a message for you, waiting to be read aloud (Voice.swift)
            ChatComposer(board: board, draft: $draft, focused: $focused, placeholder: placeholder,
                         toSession: board.isAgentChat ? $toSession : nil)
        }
        .background(Theme.bg)
        .animation(.snappy, value: ReadAloud.shared.queue.count)
        .onDisappear { ReadAloud.shared.leave(board.id) }
    }

    /// "Message theo", "Message Checkout bug", "Message your agent…" / "Message builder…".
    private var placeholder: String {
        if board.isAgentChat { return toSession.map { String(localized: "Message \($0)…", bundle: .l10n) } ?? String(localized: "Message your agent…", bundle: .l10n) }
        let name = board.kind == "direct" ? board.displayName(me: state.me?.owner) : board.title
        return String(localized: "Message \(name)", bundle: .l10n)
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
/// `carries`: its box takes the chat's text, and gives it back unless it's sent (a reply started in the chat, #1469).
struct ThreadTarget: Hashable, Identifiable { let root: Int; var prefill: String? = nil; var focus: Int? = nil; var replyTo: Int? = nil; var carries = false; var id: Int { root } }

/// Someone "@" can name: a member's agent, a member, or everyone's agents / everyone.
struct Mentionable: Hashable {
    let handle: String // what goes after the "@"
    let user: String? // nil: a group
    let agent: Bool
    var note: String? = nil // what it is, on the right ("vedu's agent" for "@Jarvis", "everyone and their agents")
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
                            Image(systemName: m.agent ? "sparkles" : m.handle == "all" ? "person.3.fill" : "person.2.fill").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted)
                                .frame(width: 24, height: 24).background(Theme.raised, in: Circle())
                        }
                        Text("@" + m.handle).font(Typo.secondary.weight(.medium)).foregroundStyle(Theme.text)
                        Spacer(minLength: Space.s)
                        (m.note.map { Text(verbatim: $0) } ?? (m.user == nil ? (m.agent ? Text("every agent here") : Text("everyone here")) : (m.agent ? Text("agent") : Text("person")))).font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1)
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
    var remember: (() -> Void)? = nil // add it to the board's MEMORY (people)
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
    var agentName: String? = nil // what its owner named this agent ("Jarvis"), if they did
    var quick: [String] = defaultReactions // your favourite reactions, the row on top of the long-press menu (#1163)
    var agentNames: [String: String] = [:] // named agents here, lowercased name → owner ("@Jarvis" in a message)
    var replyChips: QuickChips? = nil // an agent's open question to you: one-tap replies (QuickReplies.swift)
    var pickChip: (String) -> Void = { _ in }
    var retry: () -> Void = {}
    @State var drag: CGFloat = 0 // swipe right to reply
    @Environment(\.chatDensity) private var density
    @Environment(\.refTitle) private var refTitle
    /// Room above a message: tight under the one before when grouped, a little more otherwise (less when compact).
    private func gapAbove(_ comfortable: CGFloat) -> CGFloat {
        density == .compact ? (grouped ? Space.xxs : Space.gap(density)) : (grouped ? Space.xs : comfortable)
    }

    /// Like the web's author line (jxn #2589): a named agent reads "Jarvis · vedu's agent"; a named session
    /// "vedu/scout"; any other agent post "vedu's agent"; people their name.
    private var who: String {
        guard e.byAgent else { return e.author }
        if let n = agentName ?? e.agentName, !n.isEmpty { return agentLabel(e.author, n) }
        if let s = e.sessionName { return "\(e.author)/\(s)" }
        return agentLabel(e.author, nil)
    }
    /// What VoiceOver says for the sender: "vedu's agent, scout" for a session.
    private var whoSpoken: String {
        guard e.byAgent, let s = e.sessionName else { return who }
        return "\(agentLabel(e.author, agentName ?? e.agentName)), \(s)"
    }
    /// Someone else's message that @mentions you (the person, not your agent): tinted, like the web's.
    private var forYou: Bool {
        guard !mine, !unsent, let me = me?.lowercased(), e.author.lowercased() != me || e.byAgent else { return false }
        return (e.mentions ?? []).contains { !$0.agent && $0.user.lowercased() == me }
    }
    /// UI tests read the highlight's frame (it must stay inside its own message, jxn #2595); nobody else sees it.
    private static let markLit: Bool = {
        #if DEBUG
        return API.environment("STILL") != nil
        #else
        return false
        #endif
    }()
    private static let replyAt: CGFloat = 56
    private var replyAt: CGFloat { Self.replyAt }

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
    static func link(board: String, seq: Int) -> String { API.shared.publicBase.appendingPathComponent("b/\(board)").absoluteString + "#e\(seq)" }

    static func isAgent(_ u: String) -> Bool { u.hasSuffix("'s agent") || u.contains("/") }
    /// An agent's 🤔 (picked it up; 👀 on older messages) and ✅ (answered): read receipts, not reactions.
    static let receiptEmoji: Set<String> = ["🤔", "👀", "✅"]

    var body: some View {
        Group { if mine && e.type != "task" { myMessage } else { theirMessage } }
            // Just jumped to: a tint behind the message alone (jxn #2594/#2595). It reaches out sideways into the
            // list's margin, like the "names you" tint, but never up or down: the gap to the next message is outside
            // it, so it can't cover a neighbour.
            .background {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous).fill(Theme.accent.opacity(lit ? 0.14 : 0))
                    .padding(.horizontal, -Space.s)
            }
            .overlay {
                // The highlight's frame, for UI tests only (a background isn't in the accessibility tree).
                if lit, Self.markLit {
                    Rectangle().fill(Color.white.opacity(0.001)).padding(.horizontal, -Space.s).allowsHitTesting(false)
                        .accessibilityElement().accessibilityLabel("highlight").accessibilityIdentifier("lit-\(e.seq)")
                }
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
            .padding(.top, gapAbove(mine && e.type != "task" ? Space.m : Space.s + 2))
            .contextMenu {
                if let react = actions.react {
                    // A quick-reaction row, like any messenger (the palette holds six); every other emoji just under it.
                    // Your favourites (up to 8) and "+" for every other emoji.
                    ControlGroup {
                        ForEach(quick, id: \.self) { q in Button { react(q) } label: { Text(q) } }
                        if let more = actions.moreReactions { Button(action: more) { Image(systemName: "plus") }.accessibilityLabel("Any emoji") }
                    }
                    .controlGroupStyle(.palette)
                    .menuActionDismissBehavior(.enabled) // a palette stays open by default; picking one closes it
                }
                if let more = actions.moreReactions { Button("More reactions", systemImage: "face.smiling", action: more) }
                if let remember = actions.remember { Button("Remember this", systemImage: "bookmark", action: remember) }
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
            let name = parent.map { $0.byAgent ? Vocab.agentOf($0.author) : ($0.author == me && $0.via != "agent" ? String(localized: "You", bundle: .l10n) : $0.author) }
            let line = parent.map { ThreadPreview.line($0).plainRefs(refTitle.callAsFunction) } ?? ""
            Button { actions.jumpToParent?() } label: {
                HStack(spacing: 0) {
                    RoundedRectangle(cornerRadius: 1.5, style: .continuous).fill(Theme.faint.opacity(0.7)).frame(width: 3)
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Image(systemName: "arrow.turn.up.left").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.faint)
                        ((name.map { Text(verbatim: $0) } ?? Text("An earlier message")).fontWeight(.semibold).foregroundColor(Theme.text.opacity(0.9)) + Text(verbatim: name == nil ? "" : ": " + line))
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
            .accessibilityLabel(name.map { String(localized: "Reply to \($0): \(line)", bundle: .l10n) } ?? String(localized: "Reply to an earlier message", bundle: .l10n))
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("reply-quote")
            .accessibilityHint("Opens the thread")
        }
    }

    /// Who can see it, when not everyone (#1748): "🔒 Just mine · only you and your agents", or "🔒 People only".
    @ViewBuilder private var audienceNote: some View {
        if e.audience == "own" {
            Text(verbatim: "🔒 " + String(localized: "Just mine · only you and your agents", bundle: .l10n))
                .font(Typo.micro.weight(.medium)).foregroundStyle(Theme.accent)
                .accessibilityIdentifier("own-badge")
        } else if e.audience == "people" {
            let others = (e.toPeople ?? []).filter { $0 != me }
            Text(verbatim: "🔒 " + String(localized: "People only", bundle: .l10n) + (others.isEmpty ? "" : " · " + others.joined(separator: ", ")))
                .font(Typo.micro.weight(.medium)).foregroundStyle(Theme.warn).lineLimit(1)
                .accessibilityIdentifier("people-badge")
        }
    }

    /// A question, a claim, a decision: said in words, not as a type tag.
    private var kind: String? {
        switch e.type {
        case "note", "task", "artifact", "change": return nil // a file, a task, a change: each shows as itself
        case "question": return String(localized: "Question", bundle: .l10n)
        case "claim": return String(localized: "entry-type.claim", defaultValue: "Claim", bundle: .l10n, comment: "An entry type: a claim (a finding stated with evidence), not claiming a task")
        case "decision": return String(localized: "Decision", bundle: .l10n)
        case "approval": return String(localized: "Approval", bundle: .l10n)
        case "evidence": return String(localized: "Evidence", bundle: .l10n)
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

    /// Words of this message as Text: inline Markdown, "#123" chips, its mentions boxed (MessageBody draws the blocks).
    private func words(_ t: String) -> (text: Text, handles: [String]) {
        t.mentioned(e.mentions, members: members, me: me, agentNames: agentNames, refTitle: refTitle.callAsFunction)
    }

    /// Yours: a right-aligned bubble, like any messenger. Tap it to see who's seen it.
    private var myMessage: some View {
        VStack(alignment: .trailing, spacing: Space.xs) {
            if let k = kind { Text(k).font(Typo.micro.weight(.medium)).foregroundStyle(Theme.faint) }
            quote
            audienceNote
            attachment
            if unsent { unsentBody } else if e.type == "change" { if Vocab.everyday { ResultCard(e: e) } else { ChangeCardView(e: e, board: board) } } else if let caption {
                MessageBody(text: caption, render: words, ink: e.pending == true ? 0.55 : 1, lineSpacing: 0)
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
                            .accessibilityLabel(whoSpoken)
                            .accessibilityIdentifier("sender-\(who)")
                        if let k = kind { Text(k).font(Typo.micro.weight(.medium)).foregroundStyle(e.type == "question" ? Theme.warn : Theme.faint) }
                        if let to = e.to { Text("to \(to)").font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1) }
                        Spacer(minLength: Space.xs)
                        Text(e.ts.ago).font(Typo.micro).foregroundStyle(Theme.faint).monospacedDigit()
                    }
                }
                attachment.padding(.vertical, Space.xxs)
                quote
                audienceNote
                if unsent { unsentBody } else if e.type == "change" { Group { if Vocab.everyday { ResultCard(e: e) } else { ChangeCardView(e: e, board: board) } }.padding(.top, Space.xxs) } else if e.type == "task" { TaskCard(seq: e.seq, board: board, text: e.text, tasks: tasks).padding(.top, Space.xxs) } else if let caption {
                    MessageBody(text: caption, render: words)
                }
                if let decision, !unsent { HumanDecisionCard(hd: decision, me: me, actions: decisionActions).padding(.top, Space.xs) }
                if let replyChips, !unsent { QuickReplyRow(chips: replyChips, pick: pickChip).padding(.top, Space.xs) }
                footer
            }
        }
        // It names you (the web's .for-you): a soft tint, drawn inside the row so no edge cuts it (jxn #1311).
        // The text stays where every other message's is; only the tint reaches out into the margin (jxn #2594).
        .padding(.vertical, forYou ? Space.xs + 2 : 0)
        .background { RoundedRectangle(cornerRadius: 8, style: .continuous).fill(forYou ? Theme.warn.opacity(0.09) : .clear).padding(.horizontal, -Space.s) }
    }
}

/// Under the chat's title while the People filter is on: "Showing people only · Show all" (or, when nobody but agents
/// has written yet, that it's empty because of the filter). Show all turns it off.
struct PeopleFilterStrip: View {
    var empty = false
    var id = "people-filter" // its accessibility ids: "<id>-strip", "<id>-show-all" (a thread's: "thread-agents")
    let showAll: () -> Void
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.xs) {
            Image(systemName: "person.fill").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.muted).accessibilityHidden(true)
            Text(empty ? String(localized: "No messages from people here yet. Turn the filter off to see everything.", bundle: .l10n)
                 : String(localized: "Showing people only", bundle: .l10n))
                .font(Typo.micro.weight(.medium)).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: "·").font(Typo.micro).foregroundStyle(Theme.faint).accessibilityHidden(true)
            Button(action: showAll) {
                Text("Show all").font(Typo.micro.weight(.semibold)).foregroundStyle(Theme.accent)
                    .frame(minHeight: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("\(id)-show-all")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.l).padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("\(id)-strip")
    }
}

/// Whether the chat is at the latest while it's being put at the first unread (`on`): a reference, so noting it doesn't
/// draw the chat again.
final class QuietBox { var on = false; var bottom = true }

/// Where your unread messages start (jxn #1011): "NEW" and a thin line, in the web's red.
struct NewDivider: View {
    @ScaledMetric(relativeTo: .caption) private var capHeight = UIFont.preferredFont(forTextStyle: .caption1, compatibleWith: UITraitCollection(preferredContentSizeCategory: .large)).capHeight
    var body: some View {
        HStack(spacing: Space.s) {
            // Centred on the capitals (not the text's line box, whose descender room sits the line low; jxn #1311).
            Text("New").textCase(.uppercase).font(Typo.micro.weight(.semibold)).tracking(0.7).foregroundStyle(Theme.danger)
                .alignmentGuide(VerticalAlignment.center) { $0[.firstTextBaseline] - capHeight / 2 }
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
        let label = Calendar.current.isDateInToday(d) ? String(localized: "Today", bundle: .l10n) : Calendar.current.isDateInYesterday(d) ? String(localized: "Yesterday", bundle: .l10n) : d.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
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
                        (t.map { Text(verbatim: $0.caption) } ?? Text("Task")).font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1)
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
                    if let d = a.detail, !Vocab.everyday { Text(d).font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1) } // the tool and session: Developer mode
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

/// Under a minute ago (what `ago` calls "now").
private func justNow(_ ms: Double) -> Bool { Date().timeIntervalSince1970 - ms / 1000 < 60 }

func stateLine(_ state: String?, _ lastSeen: Double) -> String {
    switch state {
    case "live": return String(localized: "working now", bundle: .l10n)
    case "idle":
        return justNow(lastSeen) ? String(localized: "idle · last active just now", bundle: .l10n) : String(localized: "idle · last active \(lastSeen.ago) ago", bundle: .l10n)
    default:
        return justNow(lastSeen) ? String(localized: "gone · last seen just now", bundle: .l10n) : String(localized: "gone · last seen \(lastSeen.ago) ago", bundle: .l10n)
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
                .accessibilityLabel(receipt ? (r.emoji == "✅" ? String(localized: "Done: \(names(r.users))", bundle: .l10n) : String(localized: "Seen, working: \(names(r.users))", bundle: .l10n)) : "\(r.emoji) \(r.users.count)")
            }
        }
        .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
        .padding(.top, 2)
        .transition(.opacity)
    }
    private func names(_ users: [String]) -> String {
        // Everyday: "Theo's assistant" for the server's "theo's agent" (display only).
        let shown = users.map(Vocab.shown)
        return shown.count <= 2 ? shown.joined(separator: ", ") : String(localized: "\(shown[0]) and \(shown.count - 1) more", bundle: .l10n)
    }
}
