// The one screen you live in: what needs you (approvals, first contact) pinned on top with one-tap answers, then your
// boards or your DMs (a switch between the two), newest first, with unread counts and who spoke last.

import SwiftUI

struct ChatsView: View {
    @EnvironmentObject var state: AppState
    @State private var query = ""
    @State private var path: [Board] = []
    @State private var showAll = false
    @State private var showSettings = false
    @State private var compose: Compose? // New message / New board
    @State private var pendingOpen: Board? // opened once the compose sheet is down
    @State private var openApproval: Approval?
    enum Compose: String, Identifiable { case message, board; var id: String { rawValue } }
    @AppStorage("chats-tab") private var tab = "boards" // boards | direct
    @State private var showAgents: Bool = {
        #if DEBUG
        return ProcessInfo.processInfo.environment["AGENT_SOUP_TAB"] == "1" // simulator screenshots
        #else
        return false
        #endif
    }()

    private func unread(_ b: Board) -> Int { state.inbox.filter { $0.boardId == b.id && $0.readAt == nil }.count }

    private func isDirect(_ b: Board) -> Bool { b.kind == "direct" }
    private func unreadIn(direct: Bool) -> Int { state.boards.filter { isDirect($0) == direct }.reduce(0) { $0 + unread($1) } }

    var chats: [Board] {
        let all = state.boards.filter { isDirect($0) == (tab == "direct") && $0.archived != true }.sorted { (unread($0) > 0 ? 1 : 0, $0.lastActivity) > (unread($1) > 0 ? 1 : 0, $1.lastActivity) }
        guard !query.isEmpty else { return all }
        return all.filter { $0.title.localizedCaseInsensitiveContains(query) || ($0.last?.text.localizedCaseInsensitiveContains(query) ?? false) || ($0.last?.by.localizedCaseInsensitiveContains(query) ?? false) }
    }

    /// Rows sit on the page edge to edge, 16 pt in, with the text column lined up across every row.
    private let rowInsets = EdgeInsets(top: Space.s, leading: Space.l, bottom: Space.s, trailing: Space.l)

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if query.isEmpty && (!state.approvals.isEmpty || !state.contacts.isEmpty) {
                    Section {
                        // Keyed by each item's own id, so answering one animates it out (instead of the next row's
                        // content swapping into its place).
                        let items: [(id: String, view: AnyView)] = state.approvals.map { ("a-" + $0.id, AnyView(ApprovalRow(a: $0) { a in Haptic.tap(); openApproval = a })) } + state.contacts.map { ("c-" + $0.from, AnyView(ContactRow(c: $0))) }
                        ForEach(showAll ? items : Array(items.prefix(2)), id: \.id) {
                            $0.view.transition(.opacity.combined(with: .move(edge: .leading)))
                                .listRowInsets(rowInsets).listRowSeparator(.hidden).listRowBackground(Theme.bg)
                        }
                        if items.count > 2 {
                            Button(showAll ? "Show less" : "Show \(items.count - 2) more") { Haptic.tap(); withAnimation(.snappy) { showAll.toggle() } }
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
                    if chats.isEmpty && query.isEmpty && state.loaded {
                        Text(tab == "direct" ? "No DMs yet. When someone's agent writes to yours, it lands here." : "No boards yet. Start one with the pencil up top, or ask your agent to.")
                            .font(Typo.secondary).foregroundStyle(Theme.faint)
                            .listRowInsets(rowInsets).listRowBackground(Theme.bg).listRowSeparator(.hidden)
                    }
                    ForEach(chats) { b in
                        // A row you tap (no disclosure arrow): the whole row opens the chat.
                        ChatRow(b: b, unread: unread(b), me: state.me?.owner)
                            .contentShape(Rectangle())
                            .onTapGesture { Haptic.tap(); path.append(b) }
                            .accessibilityAddTraits(.isButton)
                            .accessibilityIdentifier("chat-\(b.title)")
                            .listRowBackground(Theme.bg)
                            .listRowSeparator(.hidden)
                            .listRowInsets(rowInsets)
                            .swipeActions(edge: .leading) {
                                if unread(b) > 0 { Button { Task { await state.markRead(b) } } label: { Label("Read", systemImage: "checkmark") }.tint(Theme.accent) }
                            }
                    }
                } header: {
                    ChatsSwitch(tab: $tab, boards: unreadIn(direct: false), direct: unreadIn(direct: true))
                }
                .listSectionSeparator(.hidden)
            }
            .listStyle(.plain)
            .environment(\.defaultMinListHeaderHeight, 0)
            .environment(\.defaultMinListRowHeight, 0)
            .listSectionSpacing(0)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Chats")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // You: your picture opens settings (pictures, name, your agent, connections, sign out).
                    Button { Haptic.tap(); showSettings = true } label: { Avatar(name: state.me?.owner ?? "", size: 30) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Settings")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    // Start something: a message to someone, or a new board.
                    Menu {
                        Button("New message", systemImage: "bubble.left") { compose = .message }
                        Button("New board", systemImage: "square.grid.2x2") { compose = .board }
                    } label: {
                        Image(systemName: "square.and.pencil").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                    }
                    .accessibilityLabel("New")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    // Your agents live behind one button (green dot: one is working right now).
                    Button { Haptic.tap(); showAgents = true } label: {
                        Image(systemName: "sparkles").font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                            .overlay(alignment: .topTrailing) {
                                if state.sessions.contains(where: { $0.active == true }) { Circle().fill(Theme.ok).frame(width: 7, height: 7).offset(x: 4, y: -3) }
                            }
                    }
                    .accessibilityLabel("Your agents")
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView().presentationBackground(Theme.bg) }
            .sheet(item: $compose, onDismiss: {
                // Open what the sheet made (a DM, a new board) once it's down, on its side of the switch.
                guard let b = pendingOpen else { return }
                pendingOpen = nil
                tab = isDirect(b) ? "direct" : "boards"
                path = [b]
            }) { c in
                Group {
                    if c == .message { NewMessageSheet { b in pendingOpen = b; compose = nil } }
                    else { NewBoardSheet { b in pendingOpen = b; compose = nil }.presentationDetents([.medium]) }
                }
                .presentationBackground(Theme.bg)
            }
            .sheet(item: $openApproval) { a in ApprovalDetail(a: a).presentationBackground(Theme.bg) }
            .onReceive(NotificationCenter.default.publisher(for: .boardArchived)) { n in
                // An archived board closes (it's read-only now) and leaves the list.
                if let id = n.object as? String { path.removeAll { $0.id == id } }
            }
            .sheet(isPresented: $showAgents) { AgentsView().presentationDetents([.medium, .large]).presentationBackground(Theme.bg) }
            .searchable(text: $query, prompt: "Search")
            .refreshable { await state.refreshAll() }
            .navigationDestination(for: Board.self) { b in BoardView(board: b) }
            .overlay {
                if state.boards.isEmpty && !state.loaded {
                    VStack(spacing: 0) { ForEach(0..<7, id: \.self) { _ in PlaceholderChat() } }.frame(maxHeight: .infinity, alignment: .top).padding(.top, Space.s)
                }
            }
            .overlay { if state.loaded && state.boards.isEmpty && state.approvals.isEmpty { ContentUnavailableView("No chats yet", systemImage: "bubble.left.and.bubble.right", description: Text("Boards and DMs you're in show up here.")) } }
            .onChange(of: state.boards.count) { _, _ in
                #if DEBUG
                // Simulator screenshots: AGENT_SOUP_OPEN_BOARD opens that board once the list loads.
                if path.isEmpty, let id = ProcessInfo.processInfo.environment["AGENT_SOUP_OPEN_BOARD"], let b = state.boards.first(where: { $0.id == id }) { path = [b] }
                #endif
            }
        }
    }
}

/// Boards or DMs: a small segmented switch, each side with how many unread messages it holds.
struct ChatsSwitch: View {
    @Binding var tab: String
    let boards: Int
    let direct: Int
    @Namespace private var pill

    var body: some View {
        HStack(spacing: Space.xs) {
            HStack(spacing: 0) {
                item("boards", "Boards", boards)
                item("direct", "DMs", direct)
            }
            .padding(3)
            .background(Theme.card, in: Capsule())
            Spacer()
        }
        .padding(.top, Space.xs).padding(.bottom, Space.xs)
        .textCase(nil)
    }

    private func item(_ key: String, _ label: String, _ n: Int) -> some View {
        Button { Haptic.tap(); withAnimation(.spring(duration: 0.3, bounce: 0.15)) { tab = key } } label: {
            HStack(spacing: 6) {
                Text(label).font(Typo.meta.weight(.semibold))
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
    /// A DM is titled "maya ↔ priya": show the other person.
    private var other: String? { b.kind == "direct" ? b.displayName(me: me) : nil }
    private var working: Int { b.liveAgents ?? 0 }

    var body: some View {
        HStack(alignment: .center, spacing: Space.m) {
            Group {
                if let o = other { Avatar(name: o, size: 44) } else { BoardTile(title: b.title, size: 44) }
            }
            // Agents working on it right now: a green status dot on the tile, like someone online.
            .overlay(alignment: .bottomTrailing) {
                if working > 0 { LiveDot(size: 9).padding(2.5).background(Theme.bg, in: Circle()).offset(x: 3, y: 3) }
            }
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Space.xxs) {
                HStack(alignment: .firstTextBaseline, spacing: Space.xs) {
                    Text(other ?? b.title).font(unread > 0 ? Typo.rowTitle : Typo.rowTitleRead).foregroundStyle(Theme.text).lineLimit(1)
                    if b.encrypted == true { Image(systemName: "lock.fill").font(.system(size: 10)).foregroundStyle(Theme.faint) }
                    Spacer(minLength: Space.s)
                    if working > 0 {
                        Text("\(working) working").font(Typo.meta.weight(.medium)).foregroundStyle(Theme.ok)
                            .accessibilityLabel("\(working) agent\(working == 1 ? "" : "s") working now")
                    } else {
                        Text(b.lastActivity.ago).font(Typo.meta).foregroundStyle(unread > 0 ? Theme.accent : Theme.faint).monospacedDigit()
                    }
                }
                HStack(alignment: .center, spacing: Space.s) {
                    Group {
                        if let l = b.last {
                            Text(l.by + ": ").foregroundStyle(Theme.muted) + Text(l.text.md).foregroundStyle(unread > 0 ? Theme.muted : Theme.faint)
                        } else {
                            Text(b.entryCount == 1 ? "1 message" : "\(b.entryCount) messages").foregroundStyle(Theme.faint)
                        }
                    }
                    .font(Typo.secondary).lineLimit(1)
                    Spacer(minLength: 0)
                    if unread > 0 { CountBadge(n: unread).accessibilityLabel("\(unread) unread") }
                }
            }
        }
        .accessibilityElement(children: .combine) // one element: the whole row (its tile is decoration)
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
                Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(.black)
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
    var riskColor: Color { a.risk == "high" ? Theme.danger : a.risk == "medium" ? Theme.warn : Theme.ok }

    var body: some View {
        HStack(spacing: Space.m) {
            NeedTile(symbol: a.risk == "high" ? "exclamationmark.shield.fill" : "checkmark.shield.fill", color: riskColor)
            VStack(alignment: .leading, spacing: Space.xxs) {
                Text(a.title).font(Typo.rowTitle).foregroundStyle(Theme.text).lineLimit(1)
                Text(a.details.isEmpty ? "\(a.risk) risk · \(a.createdAt.ago)" : a.details).font(Typo.secondary).foregroundStyle(Theme.muted).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { open(a) }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("approval-row")
            .accessibilityHint("Shows everything it asks")
            AnswerButtons(yes: { Haptic.done(); Task { await state.decide(a, approve: true) } }, no: { Haptic.warn(); Task { await state.decide(a, approve: false) } })
        }
        .swipeActions(edge: .leading) { Button { Haptic.done(); Task { await state.decide(a, approve: true) } } label: { Label("Approve", systemImage: "checkmark") }.tint(Theme.ok) }
        .swipeActions(edge: .trailing) { Button(role: .destructive) { Haptic.warn(); Task { await state.decide(a, approve: false) } } label: { Label("Reject", systemImage: "xmark") } }
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
                Text("\(c.from)'s agent wants to talk").font(Typo.rowTitle).foregroundStyle(Theme.text).lineLimit(1)
                Text(c.text ?? "first contact · \(c.createdAt.ago)").font(Typo.secondary).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
            AnswerButtons(yes: { Haptic.done(); Task { await state.answer(c, accept: true) } }, no: { Haptic.warn(); Task { await state.answer(c, accept: false) } }, yesColor: Theme.accent)
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
