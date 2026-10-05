// The one screen you live in: what needs you (approvals, first contact) pinned on top with one-tap answers, then your
// boards or your DMs (a switch between the two), newest first, with unread counts and who spoke last.

import SwiftUI

struct ChatsView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.chatDensity) private var density
    /// Everyday (Everyday.swift): back to For you, top left. Nil in Developer mode, where Chats is home.
    var home: (() -> Void)? = nil
    init(home: (() -> Void)? = nil) { self.home = home }
    @State private var query = ""
    @State private var found: CrossSearchResponse? // messages across your boards that match the search
    @State private var path: [Board] = []
    @State private var showAll = false
    @State private var showSettings = false
    @State private var compose: Compose? // New message / New board
    @State private var pendingOpen: Board? // opened once the compose sheet is down
    @State private var openApproval: Approval?
    // Managing a chat from the list (vedu #1322/#1323): rename, archive, leave, delete; and the archived ones.
    @State private var renaming: Board?
    @State private var newTitle = ""
    @State private var leaving: Board?
    @State private var deleting: Board?
    @State private var showArchived = false
    @AppStorage("board-delete-missing-at") private var deleteMissingAt: Double = 0 // when this server last had no DELETE
    /// The server answered DELETE with a bare 404 (no such route yet) in the last day: Delete stays hidden till then.
    private var deleteUnavailable: Bool { Date().timeIntervalSince1970 - deleteMissingAt < 86_400 }
    enum Compose: String, Identifiable { case message, board; var id: String { rawValue } }
    @AppStorage("chats-tab") private var tab = "boards" // boards | direct
    @State private var showAgents: Bool = {
        #if DEBUG
        return API.environment("TAB") == "1" // simulator screenshots
        #else
        return false
        #endif
    }()

    private func unread(_ b: Board) -> Int { state.inbox.filter { $0.boardId == b.id && $0.readAt == nil }.count }

    private func isDirect(_ b: Board) -> Bool { b.kind == "direct" }
    /// Under DMs: your DMs, and "Your agent" (pinned on top).
    private func inDMs(_ b: Board) -> Bool { isDirect(b) || b.isAgentChat }
    private func unreadIn(direct: Bool) -> Int { state.boards.filter { inDMs($0) == direct && $0.archived != true }.reduce(0) { $0 + unread($1) } }

    /// "Your agent", pinned atop DMs (unless a search leaves it out).
    private var showAgentChat: Bool { tab == "direct" && (query.isEmpty || "your agent".localizedCaseInsensitiveContains(query) || "agent".localizedCaseInsensitiveContains(query)) }

    /// Your agent's chat: open it (made the first time).
    private func openAgentChat() {
        if let b = state.agentChat { path.append(b); return }
        Task { if let b = await state.openAgentChat() { path.append(b) } }
    }

    /// People first (jxn #1731, the web's): chats where a person wrote last go first (newest first within each), and
    /// boards known to have nobody else on them leave the list. On this phone, for this list only.
    @AppStorage("people-first") private var peopleFirst = false
    private func lastByPerson(_ b: Board) -> Bool { b.last.map { !$0.by.hasSuffix("'s agent") } ?? false }
    private func justMe(_ b: Board) -> Bool { state.members[b.id].map { $0.allSatisfy { $0 == state.me?.owner } } ?? false }

    var chats: [Board] {
        var all = state.boards.filter { !$0.isAgentChat && isDirect($0) == (tab == "direct") && $0.archived != true }.sorted { (unread($0) > 0 ? 1 : 0, $0.lastActivity) > (unread($1) > 0 ? 1 : 0, $1.lastActivity) }
        if peopleFirst {
            all = all.filter { !justMe($0) }
            all = all.filter(lastByPerson) + all.filter { !lastByPerson($0) }
        }
        guard !query.isEmpty else { return all }
        return all.filter { $0.title.localizedCaseInsensitiveContains(query) || ($0.last?.text.localizedCaseInsensitiveContains(query) ?? false) || ($0.last?.by.localizedCaseInsensitiveContains(query) ?? false) }
    }

    /// Archived chats (not "Your agent"): restored from their own list.
    private var archived: [Board] { state.boards.filter { $0.archived == true && !$0.isAgentChat } }
    private func owns(_ b: Board) -> Bool { b.createdBy != nil && b.createdBy == state.me?.owner }

    /// What you can do to a chat from the list: its owner renames, archives or deletes it; anyone else leaves it.
    /// The same actions on a long-press and a swipe to the left (the swipe: destructive first, rightmost).
    @ViewBuilder private func manage(_ b: Board, swipe: Bool) -> some View {
        if owns(b) {
            if !deleteUnavailable && swipe {
                Button { deleting = b } label: { Label("Delete", systemImage: "trash") }.tint(Theme.danger)
            }
            Button { Task { _ = await state.archiveBoard(b.id) } } label: { Label("Archive", systemImage: "archivebox") }.tint(Theme.warn)
            if b.kind != "direct" { Button { newTitle = b.title; renaming = b } label: { Label("Rename", systemImage: "pencil") }.tint(Theme.muted) }
            if !deleteUnavailable && !swipe {
                Divider()
                Button(role: .destructive) { deleting = b } label: { Label("Delete", systemImage: "trash") }
            }
        } else {
            Button(role: swipe ? nil : .destructive) { leaving = b } label: { Label("Leave", systemImage: "rectangle.portrait.and.arrow.right") }.tint(Theme.danger)
        }
    }

    /// Rows sit on the page edge to edge, 16 pt in, with the text column lined up across every row (closer together
    /// when Display → Density is Compact).
    private var rowInsets: EdgeInsets { EdgeInsets(top: Space.row(density), leading: Space.l, bottom: Space.row(density), trailing: Space.l) }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                // (Everyday asks these on For you instead.)
                if !Vocab.everyday && query.isEmpty && (!state.approvals.isEmpty || !state.contacts.isEmpty) {
                    Section {
                        // Keyed by each item's own id, so answering one animates it out (instead of the next row's
                        // content swapping into its place).
                        let items: [(id: String, view: AnyView)] = state.approvals.map { ("a-" + $0.id, AnyView(ApprovalRow(a: $0) { a in openApproval = a })) } + state.contacts.map { ("c-" + $0.from, AnyView(ContactRow(c: $0))) }
                        ForEach(showAll ? items : Array(items.prefix(2)), id: \.id) {
                            $0.view.transition(.opacity.combined(with: .move(edge: .leading)))
                                .listRowInsets(rowInsets).listRowSeparator(.hidden).listRowBackground(Theme.bg)
                        }
                        if items.count > 2 {
                            Button(showAll ? "Show less" : "Show \(items.count - 2) more") { withAnimation(.snappy) { showAll.toggle() } }
                                .font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.muted)
                                .padding(.leading, 44 + Space.m) // under the text column
                                .frame(minHeight: 32)
                                .listRowInsets(EdgeInsets(top: 0, leading: Space.l, bottom: 0, trailing: Space.l))
                                .listRowSeparator(.hidden).listRowBackground(Theme.bg)
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Circle().fill(Theme.accent).frame(width: 6, height: 6)
                            Text("Needs you · \(state.approvals.count + state.contacts.count)")
                                .contentTransition(.numericText())
                                .accessibilityIdentifier("needs-you")
                        }
                        .font(Typo.section).foregroundStyle(Theme.accent).textCase(nil)
                        .padding(.top, Space.xs)
                    }
                    .listSectionSeparator(.hidden)
                }
                Section {
                    if showAgentChat {
                        AgentChatRow(unread: state.agentChat.map(unread) ?? 0)
                            .contentShape(Rectangle())
                            .onTapGesture { openAgentChat() }
                            .accessibilityAddTraits(.isButton)
                            .accessibilityIdentifier("chat-your-agent")
                            .listRowBackground(Theme.bg)
                            .listRowSeparator(.hidden)
                            .listRowInsets(rowInsets)
                    }
                    if chats.isEmpty && query.isEmpty && state.loaded {
                        Text(tab == "direct" ? Vocab.pick(String(localized: "No DMs yet. When someone's agent writes to yours, it lands here.", bundle: .l10n), String(localized: "No DMs yet. When someone's assistant writes to yours, it lands here.", bundle: .l10n))
                             : Vocab.pick(String(localized: "No boards yet. Start one with the pencil up top, or ask your agent to.", bundle: .l10n), String(localized: "No group chats yet. Start one with the pencil up top, or ask your assistant to.", bundle: .l10n)))
                            .font(Typo.secondary).foregroundStyle(Theme.faint)
                            .listRowInsets(rowInsets).listRowBackground(Theme.bg).listRowSeparator(.hidden)
                    }
                    ForEach(chats) { b in
                        // A row you tap (no disclosure arrow): the whole row opens the chat.
                        ChatRow(b: b, unread: unread(b), me: state.me?.owner, names: state.personNames)
                            .contentShape(Rectangle())
                            .onTapGesture { path.append(b) }
                            .accessibilityAddTraits(.isButton)
                            .accessibilityIdentifier("chat-\(b.title)")
                            .listRowBackground(Theme.bg)
                            .listRowSeparator(.hidden)
                            .listRowInsets(rowInsets)
                            .swipeActions(edge: .leading) {
                                if unread(b) > 0 { Button { Task { await state.markRead(b) } } label: { Label("Read", systemImage: "checkmark") }.tint(Theme.accent) }
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) { manage(b, swipe: true) }
                            .contextMenu { manage(b, swipe: false) }
                    }
                    if query.isEmpty && !archived.isEmpty {
                        Button { showArchived = true } label: {
                            HStack(spacing: Space.m) {
                                Image(systemName: "archivebox").font(.system(size: 15)).foregroundStyle(Theme.muted).frame(width: 44)
                                Text("Archived").font(Typo.rowTitleRead).foregroundStyle(Theme.muted)
                                Spacer()
                                Text("\(archived.count)").font(Typo.meta).foregroundStyle(Theme.faint).monospacedDigit()
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("archived-chats")
                        .listRowInsets(rowInsets).listRowBackground(Theme.bg).listRowSeparator(.hidden)
                    }
                } header: {
                    ChatsSwitch(tab: $tab, boards: unreadIn(direct: false), direct: unreadIn(direct: true), peopleFirst: $peopleFirst)
                }
                .listSectionSeparator(.hidden)
                // Searching: messages in every board you're in (the server's search, like the web's), tap to go there.
                if !query.trimmingCharacters(in: .whitespaces).isEmpty, let hits = found?.hits.filter({ $0.kind == "entry" && $0.seq != nil }), !hits.isEmpty {
                    Section {
                        ForEach(hits) { h in
                            SearchHitRow(hit: .init(seq: h.seq ?? 0, ts: 0, author: h.author ?? "", via: h.via, type: "note", title: nil, snippet: h.snippet), board: PersonName.boardTitle(h.title, names: state.personNames), names: state.personNames) {
                                guard let b = state.boards.first(where: { $0.id == h.board }) else { return }
                                state.jumpRequest = AppState.JumpRequest(board: b.id, seq: h.seq ?? 0)
                                path = [b]
                            }
                            .listRowInsets(rowInsets).listRowBackground(Theme.bg).listRowSeparator(.hidden)
                        }
                    } header: { SectionHeader("Messages").padding(.top, Space.s) }
                    .listSectionSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .environment(\.defaultMinListHeaderHeight, 0)
            .environment(\.defaultMinListRowHeight, 0)
            .listSectionSpacing(0)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Chats")
            .toolbar {
                if let home {
                    ToolbarItem(placement: .topBarLeading) {
                        Button(action: home) { Label("For you", systemImage: "chevron.left").labelStyle(.titleAndIcon) }
                            .toolbarText()
                            .accessibilityIdentifier("for-you")
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    // You: your picture opens settings (pictures, name, your agent, connections, sign out).
                    Button { showSettings = true } label: { Avatar(name: state.me?.owner ?? "", size: 30) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Settings")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    // Start something: a message to someone, or a new board.
                    Menu {
                        Button("New message", systemImage: "bubble.left") { compose = .message }
                        Button(Vocab.pick(String(localized: "New board", bundle: .l10n), String(localized: "New group chat", bundle: .l10n)), systemImage: "square.grid.2x2") { compose = .board }
                    } label: {
                        ToolbarIcon("square.and.pencil")
                    }
                    .accessibilityLabel("New")
                }
                if !Vocab.everyday { ToolbarItem(placement: .topBarTrailing) {
                    // Your agents live behind one button (green dot: one is working right now). (Developer mode only.)
                    Button { showAgents = true } label: {
                        ToolbarIcon("sparkles")
                            .overlay(alignment: .topTrailing) {
                                if state.sessions.contains(where: { $0.active == true }) { Circle().fill(Theme.ok).frame(width: 7, height: 7).offset(x: 4, y: -3) }
                            }
                    }
                    .accessibilityLabel("Your agents")
                } }
            }
            .sheet(isPresented: $showSettings) { SettingsView().presentationBackground(Theme.bg).environment(\.chatDensity, density) }
            .sheet(item: $compose, onDismiss: {
                // Open what the sheet made (a DM, a new board) once it's down, on its side of the switch.
                guard let b = pendingOpen else { return }
                pendingOpen = nil
                tab = inDMs(b) ? "direct" : "boards"
                path = [b]
            }) { c in
                Group {
                    if c == .message { NewMessageSheet { b in pendingOpen = b; compose = nil } }
                    else { NewBoardSheet { b in pendingOpen = b; compose = nil }.presentationDetents([.medium]) }
                }
                .presentationBackground(Theme.bg)
                .environment(\.chatDensity, density)
            }
            .sheet(item: $openApproval) { a in ApprovalDetail(a: a).presentationBackground(Theme.bg).environment(\.chatDensity, density) }
            .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Title", text: $newTitle).accessibilityIdentifier("rename-field")
                Button("Cancel", role: .cancel) { renaming = nil }
                Button("Rename") {
                    let t = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                    if let b = renaming, !t.isEmpty, t != b.title { Task { _ = await state.renameBoard(b.id, to: t) } }
                    renaming = nil
                }
            }
            .confirmationDialog("Leave \(leaving?.title ?? "")?", isPresented: Binding(get: { leaving != nil }, set: { if !$0 { leaving = nil } }), titleVisibility: .visible, presenting: leaving) { b in
                Button("Leave", role: .destructive) { Task { _ = await state.leaveBoard(b.id) } }
            } message: { _ in Text("It leaves your Chats. Someone here can add you back.") }
            .confirmationDialog("Delete \(deleting?.title ?? "")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible, presenting: deleting) { b in
                Button("Delete", role: .destructive) {
                    Task { if await state.deleteBoard(b.id) == .unavailable { deleteMissingAt = Date().timeIntervalSince1970; state.report(APIError.server(String(localized: "Deleting isn't available on this server yet.", bundle: .l10n))) } }
                }
            } message: { _ in Text("Deletes this chat for everyone. You can restore it for 30 days.") }
            .sheet(isPresented: $showArchived) { ArchivedChats().presentationDetents([.medium, .large]).presentationBackground(Theme.bg).environment(\.chatDensity, density) }
            .onReceive(NotificationCenter.default.publisher(for: .boardArchived)) { n in
                // An archived board closes (it's read-only now) and leaves the list.
                if let id = n.object as? String { path.removeAll { $0.id == id } }
            }
            .sheet(isPresented: $showAgents) { AgentsView().presentationDetents([.medium, .large]).presentationBackground(Theme.bg).environment(\.chatDensity, density) }
            .searchable(text: $query, prompt: "Search")
            .task(id: query) {
                let q = query.trimmingCharacters(in: .whitespaces)
                guard q.count >= 2 else { found = nil; return }
                try? await Task.sleep(nanoseconds: 350_000_000)
                guard !Task.isCancelled else { return }
                let r = try? await API.shared.get("/api/boards/search?q=\(q.queryEscaped)", as: CrossSearchResponse.self)
                if !Task.isCancelled { withAnimation(.smooth) { found = r } }
            }
            .refreshable { await state.refreshAll() }
            .navigationDestination(for: Board.self) { b in BoardView(board: b) }
            // Opened from elsewhere (Message on someone's card in a chat): that chat, on its side of the switch.
            .onChange(of: state.openRequest) { _, b in
                guard let b else { return }
                state.openRequest = nil
                tab = inDMs(b) ? "direct" : "boards"
                path = [b]
            }
            .overlay {
                if state.boards.isEmpty && !state.loaded {
                    VStack(spacing: 0) { ForEach(0..<7, id: \.self) { _ in PlaceholderChat() } }.frame(maxHeight: .infinity, alignment: .top).padding(.top, Space.s)
                }
            }
            .overlay { if state.loaded && state.boards.isEmpty && state.approvals.isEmpty { ContentUnavailableView("No chats yet", systemImage: "bubble.left.and.bubble.right", description: Text("Boards and DMs you're in show up here.")) } }
            .onChange(of: state.boards.count) { _, _ in
                #if DEBUG
                // Simulator screenshots: ATTEO_OPEN_BOARD opens that board once the list loads.
                if path.isEmpty, let id = API.environment("OPEN_BOARD"), let b = state.boards.first(where: { $0.id == id }) { path = [b] }
                #endif
            }
        }
        // Pull from the left edge for Settings (vedu #2488), on this first screen only.
        .settingsDrawer(enabled: path.isEmpty && compose == nil && !showSettings)
    }
}

/// Boards or DMs: a small segmented switch, each side with how many unread messages it holds.
struct ChatsSwitch: View {
    @Binding var tab: String
    let boards: Int
    let direct: Int
    /// People first (the web's, beside its Active / Archived): nil leaves it out.
    var peopleFirst: Binding<Bool>? = nil
    @Namespace private var pill

    var body: some View {
        HStack(spacing: Space.xs) {
            HStack(spacing: 0) {
                item("boards", Vocab.boards, boards)
                item("direct", String(localized: "DMs", bundle: .l10n), direct)
            }
            .padding(3)
            .background(Theme.card, in: Capsule())
            Spacer()
            if let peopleFirst {
                let on = peopleFirst.wrappedValue
                Button { Haptics.play(.touch); withAnimation(.spring(duration: 0.3, bounce: 0.15)) { peopleFirst.wrappedValue.toggle() } } label: {
                    // One line; where the words don't fit beside the switch (French: « Les personnes d’abord » next to
                    // « Messages directs »), just the person.
                    let icon = Image(systemName: on ? "person.fill" : "person")
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 4) {
                            icon.font(.system(size: 10, weight: .semibold))
                            Text("People first").font(Typo.meta.weight(.semibold)).lineLimit(1)
                        }
                        icon.font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundStyle(on ? Theme.onText : Theme.muted)
                    .padding(.horizontal, Space.m).frame(minHeight: 30)
                    .background(on ? Theme.text : Theme.card, in: Capsule())
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("people-first")
                .accessibilityLabel(Text("People first"))
                .accessibilityHint(Text("Chats with other people, the ones where a person wrote last first"))
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(.top, Space.xs).padding(.bottom, Space.xs)
        .textCase(nil)
    }

    private func item(_ key: String, _ label: String, _ n: Int) -> some View {
        Button { withAnimation(.spring(duration: 0.3, bounce: 0.15)) { tab = key } } label: {
            HStack(spacing: 6) {
                // Never wraps (French « Messages directs » broke over three lines): the People first pill gives way.
                Text(label).font(Typo.meta.weight(.semibold)).lineLimit(1).fixedSize()
                if n > 0 { CountBadge(n: n) }
            }
            .foregroundStyle(tab == key ? Theme.text : Theme.muted)
            .padding(.horizontal, Space.m).frame(minHeight: 30)
            .background { if tab == key { Capsule().fill(Theme.raised).matchedGeometryEffect(id: "pill", in: pill) } }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("tab-\(key)")
        .accessibilityValue(n > 0 ? "\(n) unread" : "")
        .accessibilityAddTraits(tab == key ? .isSelected : [])
    }
}

struct ChatRow: View {
    let b: Board
    let unread: Int
    var me: String? = nil
    var names: [String: String] = [:]
    /// A DM is titled "maya ↔ priya": show the other person, by the name they chose.
    private var other: String? { b.kind == "direct" ? b.displayName(me: me) : nil }
    private var title: String { b.shownTitle(me: me, names: names) }
    /// "vedu: …" or "vedu's agent: …" under a chat. Agents keep the handle; a person is their display name.
    private func previewAuthor(_ by: String) -> String {
        if by.hasSuffix("'s agent") || by.contains("/") { return Vocab.shown(by) }
        return PersonName.shown(by, names[by])
    }
    private var working: Int { b.liveAgents ?? 0 }
    @ObservedObject private var pictures = BoardPictureStore.shared
    @ObservedObject private var drafts = MessageDrafts.shared

    var body: some View {
        HStack(alignment: .center, spacing: Space.m) {
            // The board's picture (its initial until it has one); a DM, the other person's.
            BoardPicture(board: b, size: 44)
                // Agents working on it right now: a green status dot on the tile, like someone online.
                .overlay(alignment: .bottomTrailing) {
                    if working > 0 { LiveDot(size: 9).padding(2.5).background(Theme.bg, in: Circle()).offset(x: 3, y: 3) }
                }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Space.xxs) {
                HStack(alignment: .firstTextBaseline, spacing: Space.xs) {
                    Text(title).font(unread > 0 ? Typo.rowTitle : Typo.rowTitleRead).foregroundStyle(Theme.text).lineLimit(1)
                        .accessibilityLabel(other.map { PersonName.spoken($0, names: names) } ?? title)
                    if b.encrypted == true { Image(systemName: "lock.fill").font(.system(size: 10)).foregroundStyle(Theme.faint) }
                    Spacer(minLength: Space.s)
                    if working > 0 {
                        Text("\(working) working").font(Typo.meta.weight(.medium)).foregroundStyle(Theme.ok)
                            .accessibilityLabel("\(working) agents working now")
                    } else {
                        Text(b.lastActivity.ago).font(Typo.meta).foregroundStyle(unread > 0 ? Theme.accent : Theme.faint).monospacedDigit()
                    }
                }
                HStack(alignment: .center, spacing: Space.s) {
                    Group {
                        if !drafts.text(for: b).isEmpty {
                            Text(String(localized: "Draft: \(String(drafts.text(for: b).prefix(40)))", bundle: .l10n))
                                .foregroundStyle(Theme.accent)
                        } else if let l = b.last {
                            Text(previewAuthor(l.by) + ": ").foregroundStyle(Theme.muted) + Text(l.text.mdPreview).foregroundStyle(unread > 0 ? Theme.muted : Theme.faint)
                        } else {
                            Text("\(b.entryCount) messages").foregroundStyle(Theme.faint)
                        }
                    }
                    .font(Typo.secondary).lineLimit(1)
                    Spacer(minLength: 0)
                    if unread > 0 { CountBadge(n: unread).accessibilityLabel("\(unread) unread") }
                }
            }
        }
        .accessibilityElement(children: .combine) // one element: the whole row (its tile is decoration)
        #if DEBUG
        .accessibilityValue(pictures.look(of: b)) // UI tests: what the tile shows (picture / initial / person)
        #endif
    }
}

/// One-tap answers for "Needs you" rows: a quiet no, a bright yes (each a 44-pt target).
struct AnswerButtons: View {
    let yes: () -> Void
    let no: () -> Void
    var yesColor: Color = Theme.ok

    var body: some View {
        HStack(spacing: Space.xs) {
            Button(action: no) {
                Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.muted)
                    .frame(width: 32, height: 32).background(Theme.raised, in: Circle())
                    .frame(width: 40, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(PressStyle()).accessibilityLabel("No")
            Button(action: yes) {
                Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.onText)
                    .frame(width: 32, height: 32).background(Theme.text, in: Circle())
                    .frame(width: 40, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(PressStyle()).accessibilityLabel("Yes")
        }
    }
}

/// The leading tile of a "Needs you" row: a symbol on a tinted square, lined up with the chats' tiles.
private struct NeedTile: View {
    let symbol: String
    let color: Color
    var body: some View {
        RoundedRectangle(cornerRadius: 44 * 0.3, style: .continuous).fill(color.opacity(0.15)).frame(width: 44, height: 44)
            .overlay(Image(systemName: symbol).font(.system(size: 17, weight: .semibold)).foregroundStyle(color))
            .accessibilityHidden(true)
    }
}

/// An agent asking before a side effect: approve or reject in one tap (or swipe).
struct ApprovalRow: View {
    @EnvironmentObject var state: AppState
    let a: Approval
    var open: (Approval) -> Void = { _ in } // tap the row for everything it asks (and a note back)
    var riskLabel: String {
        switch a.risk {
        case "high": return String(localized: "High risk", bundle: .l10n)
        case "medium": return String(localized: "Medium risk", bundle: .l10n)
        case "low": return String(localized: "Low risk", bundle: .l10n)
        default: return String(localized: "\(a.risk) risk", bundle: .l10n)
        }
    }
    var riskColor: Color { a.risk == "high" ? Theme.danger : a.risk == "medium" ? Theme.warn : Theme.ok }

    var body: some View {
        HStack(spacing: Space.m) {
            NeedTile(symbol: a.risk == "high" ? "exclamationmark.shield.fill" : "checkmark.shield.fill", color: riskColor)
            VStack(alignment: .leading, spacing: Space.xxs) {
                Text(a.title).font(Typo.rowTitle).foregroundStyle(Theme.text).lineLimit(1)
                Text(verbatim: a.details.isEmpty ? "\(riskLabel) · \(a.createdAt.ago)" : a.details).font(Typo.secondary).foregroundStyle(Theme.muted).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { open(a) }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("approval-row")
            .accessibilityHint("Shows everything it asks")
            AnswerButtons(yes: { Task { await state.decide(a, approve: true) } }, no: { Task { await state.decide(a, approve: false) } })
        }
        .swipeActions(edge: .leading) { Button { Task { await state.decide(a, approve: true) } } label: { Label("Approve", systemImage: "checkmark") }.tint(Theme.ok) }
        .swipeActions(edge: .trailing) { Button(role: .destructive) { Task { await state.decide(a, approve: false) } } label: { Label("Reject", systemImage: "xmark") } }
    }
}

/// Someone's agent wants to talk to yours for the first time.
struct ContactRow: View {
    @EnvironmentObject var state: AppState
    let c: ContactsResponse.Incoming

    var body: some View {
        HStack(spacing: Space.m) {
            Avatar(name: c.from, agent: true, size: 44).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Space.xxs) {
                Text("\(Vocab.agentOf(c.from)) wants to talk").font(Typo.rowTitle).foregroundStyle(Theme.text).lineLimit(1)
                (c.text.map { Text(verbatim: $0) } ?? Text("first contact · \(c.createdAt.ago)")).font(Typo.secondary).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
            AnswerButtons(yes: { Haptics.play(.approved); Task { await state.answer(c, accept: true) } }, no: { Haptics.play(.denied); Task { await state.answer(c, accept: false) } }, yesColor: Theme.accent)
        }
        .swipeActions(edge: .leading) { Button { Task { await state.answer(c, accept: true) } } label: { Label("Allow", systemImage: "checkmark") }.tint(Theme.accent) }
        .swipeActions(edge: .trailing) { Button(role: .destructive) { Task { await state.answer(c, accept: false) } } label: { Label("Decline", systemImage: "xmark") } }
    }
}

/// A grey stand-in for a chat row while the first list loads (no blank flash), shaped like the real row.
struct PlaceholderChat: View {
    var body: some View {
        HStack(spacing: Space.m) {
            RoundedRectangle(cornerRadius: 13, style: .continuous).fill(Theme.card).frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: Space.s) {
                RoundedRectangle(cornerRadius: 4).fill(Theme.card).frame(width: 140, height: 11)
                RoundedRectangle(cornerRadius: 4).fill(Theme.card).frame(maxWidth: .infinity).frame(height: 10)
            }
        }
        .padding(.horizontal, Space.l).padding(.vertical, Space.s)
    }
}

/// Archived chats: read-only until restored; their owners bring them back to Chats here.
struct ArchivedChats: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    private var boards: [Board] { state.boards.filter { $0.archived == true && !$0.isAgentChat }.sorted { $0.lastActivity > $1.lastActivity } }

    var body: some View {
        NavigationStack {
            List {
                if boards.isEmpty {
                    Text("Nothing archived.").font(Typo.secondary).foregroundStyle(Theme.faint).listRowBackground(Theme.bg).listRowSeparator(.hidden)
                }
                ForEach(boards) { b in
                    HStack(spacing: Space.m) {
                        BoardPicture(board: b, size: 36)
                        VStack(alignment: .leading, spacing: Space.xxs) {
                            Text(b.shownTitle(me: state.me?.owner, names: state.personNames)).font(Typo.rowTitleRead).foregroundStyle(Theme.text).lineLimit(1)
                                .accessibilityLabel(b.kind == "direct" ? PersonName.spoken(b.displayName(me: state.me?.owner), names: state.personNames) : b.title)
                            Text("Archived · read-only").font(Typo.micro).foregroundStyle(Theme.faint)
                        }
                        Spacer(minLength: Space.s)
                        if b.createdBy == state.me?.owner {
                            Button("Restore") { Task { _ = await state.unarchiveBoard(b.id) } }
                                .font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.text)
                                .padding(.horizontal, 12).frame(height: 30).background(Theme.raised, in: Capsule())
                                .buttonStyle(PressStyle())
                                .accessibilityIdentifier("restore-\(b.title)")
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("archived-\(b.title)")
                    .listRowBackground(Theme.bg).listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Archived")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
    }
}
