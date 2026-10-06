import SwiftUI

/// Present with `.sheet(isPresented:) { MenuSheet() }` or `.menuSheet(isPresented:)`.
/// Inherits AppState. Board selections use ChatsView's openRequest; a host with its own
/// navigation path can supply onOpen instead. The opening button belongs to the frame.
struct MenuSheet: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var destination: MenuDestination?
    @State private var pendingBoard: Board?
    @State private var openingAgent = false
    @AppStorage("chats-tab") private var chatsTab = "boards"
    var onOpen: ((Board) -> Void)? = nil

    private var search: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }
    private func matches(_ title: String) -> Bool {
        search.isEmpty || title.localizedStandardContains(search)
    }
    private var boards: [Board] {
        state.boards.filter { $0.archived != true && !$0.isAgentChat && $0.kind != "direct" }
            .filter { matches(state.displayName(for: $0)) }
            .sorted { $0.lastActivity > $1.lastActivity }
    }
    private var direct: [Board] {
        state.boards.filter { $0.archived != true && $0.kind == "direct" }
            .filter { matches(state.displayName(for: $0)) }
            .sorted { $0.lastActivity > $1.lastActivity }
    }
    private var agentTitle: String { String(localized: "Your agent", bundle: .l10n) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.m) {
                searchField
                destinations
                Divider().overlay(Theme.line)
                boardHeading
                VStack(spacing: .zero) {
                    ForEach(boards) { board in
                        boardRow(board)
                        Divider().overlay(Theme.line)
                    }
                }
                Text(String(localized: "DMs", bundle: .l10n))
                    .font(Typo.meta).foregroundStyle(Theme.muted)
                    .accessibilityAddTraits(.isHeader)
                VStack(spacing: .zero) {
                    if matches(agentTitle) {
                        agentRow
                        Divider().overlay(Theme.line)
                    }
                    ForEach(direct) { board in
                        boardRow(board)
                        Divider().overlay(Theme.line)
                    }
                }
                account
            }
            .padding(.horizontal, Space.l)
            .padding(.top, Space.xl)
            .padding(.bottom, Space.m)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.bg)
        .tint(Theme.text)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Theme.bg)
        .accessibilityIdentifier("menu-sheet")
        .task(id: openingAgent) {
            guard openingAgent else { return }
            defer { openingAgent = false }
            if let board = await state.openAgentChat(), !Task.isCancelled { open(board) }
        }
        .sheet(item: $destination, onDismiss: {
            // Creation and People finish their own sheet before opening the resulting chat.
            if let board = pendingBoard {
                pendingBoard = nil
                open(board)
            }
        }) { target in
            screen(target)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                .presentationBackground(Theme.bg)
        }
    }

    private var searchField: some View {
        HStack(spacing: Space.m) {
            Image(systemName: "magnifyingglass").foregroundStyle(Theme.muted).accessibilityHidden(true)
            TextField(String(localized: "Search or jump to...", bundle: .l10n), text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel(String(localized: "Search or jump to...", bundle: .l10n))
                .accessibilityIdentifier("menu-search")
        }
        .font(Typo.secondary)
        .padding(.horizontal, Space.m)
        .frame(minHeight: Metrics.rowHeight(.comfortable))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).stroke(Theme.lineStrong))
    }

    private var destinations: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Space.m), count: 4), spacing: Space.m) {
            ForEach(MenuDestination.main.filter { matches($0.title) }) { target in
                Button { present(target) } label: {
                    VStack(spacing: Space.s) {
                        Image(systemName: target.symbol).font(Typo.body)
                        Text(target.title).font(Typo.micro).multilineTextAlignment(.center)
                    }
                    .foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Space.m)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.card))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(target.title)
                .accessibilityIdentifier("menu-\(target.rawValue)")
            }
        }
    }

    private var boardHeading: some View {
        HStack {
            Text(String(localized: "Your boards", bundle: .l10n))
                .font(Typo.meta).foregroundStyle(Theme.muted)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            Button { present(.newBoard) } label: {
                Image(systemName: "plus").font(Typo.secondary).foregroundStyle(Theme.muted)
                    .frame(minWidth: Metrics.rowHeight(.comfortable), minHeight: Metrics.rowHeight(.comfortable))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(String(localized: "New board", bundle: .l10n))
            .accessibilityIdentifier("menu-new-board")
        }
    }

    private func status(_ board: Board) -> MenuBoardStatus {
        MenuBoardStatus(board: board, agents: state.boardAgents[board.id], approvals: state.approvals)
    }

    private func boardRow(_ board: Board) -> some View {
        let activity = status(board)
        let name = state.displayName(for: board)
        return Button { open(board) } label: {
            HStack(spacing: Space.m) {
                BoardPicture(board: board, size: Space.xl).accessibilityHidden(true)
                Text(name).font(Typo.rowTitleRead).foregroundStyle(Theme.text)
                Spacer(minLength: Space.s)
                Text(activity.label).font(Typo.meta).foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.trailing)
                if board.kind != "direct" {
                    Capsule().fill(activity.color).frame(width: Space.xs, height: Space.xl)
                        .accessibilityHidden(true)
                }
            }
            .frame(minHeight: Metrics.rowHeight(.comfortable))
            .padding(.vertical, Space.xxs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name)
        .accessibilityValue(activity.label)
        .accessibilityIdentifier("menu-board-\(board.id)")
    }

    private var agentRow: some View {
        Button {
            if let board = state.agentChat { open(board) }
            else { openingAgent = true }
        } label: {
            HStack(spacing: Space.m) {
                Avatar(name: state.me?.owner ?? "", agent: true, size: Space.xl).accessibilityHidden(true)
                Text(agentTitle).font(Typo.rowTitleRead).foregroundStyle(Theme.text)
                Spacer(minLength: Space.s)
                if openingAgent { ProgressView() }
                else { Text(agentStatus).font(Typo.meta).foregroundStyle(Theme.muted) }
            }
            .frame(minHeight: Metrics.rowHeight(.comfortable))
            .padding(.vertical, Space.xxs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(openingAgent)
        .accessibilityLabel(agentTitle)
        .accessibilityValue(agentStatus)
        .accessibilityIdentifier("menu-your-agent")
    }

    private var agentStatus: String {
        if let board = state.agentChat { return status(board).label }
        let count = state.sessions.filter { $0.state == "live" }.count
        return String(localized: "\(count) working", bundle: .l10n)
    }

    private var account: some View {
        HStack(spacing: Space.s) {
            Button { present(.settings) } label: {
                HStack(spacing: Space.m) {
                    Avatar(name: state.me?.owner ?? "", size: Space.xl).accessibilityHidden(true)
                    Text(accountName).font(Typo.rowTitleRead).foregroundStyle(Theme.text)
                    Spacer(minLength: Space.s)
                }
                .frame(minHeight: Metrics.rowHeight(.comfortable))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(accountName)
            .accessibilityHint(String(localized: "Settings", bundle: .l10n))
            .accessibilityIdentifier("menu-account")
            footerButton(.feedback, symbol: "bubble.left")
            footerButton(.reportBug, symbol: "exclamationmark.triangle")
        }
    }

    private var accountName: String {
        state.me.map { state.displayName(for: $0.owner) } ?? String(localized: "You", bundle: .l10n)
    }

    private func footerButton(_ target: MenuDestination, symbol: String) -> some View {
        Button { present(target) } label: {
            Image(systemName: symbol).font(Typo.secondary).foregroundStyle(Theme.muted)
                .frame(minWidth: Metrics.rowHeight(.comfortable), minHeight: Metrics.rowHeight(.comfortable))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(target.title)
        .accessibilityIdentifier("menu-\(target.rawValue)")
    }

    private func present(_ target: MenuDestination) {
        if target == .boards { chatsTab = "boards" }
        destination = target
    }

    private func open(_ board: Board) {
        if let onOpen { onOpen(board) } else { state.openRequest = board }
        dismiss()
    }

    private func finish(_ board: Board) {
        pendingBoard = board
        destination = nil
    }

    @ViewBuilder private func screen(_ target: MenuDestination) -> some View {
        switch target {
        case .forYou: ForYouView(openChats: { present(.boards) })
        case .boards: ChatsView()
        case .people: NewMessageSheet(open: finish)
        case .guide: SafariView(url: GuideRow.url).ignoresSafeArea()
        // These destinations already exist on the server; there are no native equivalents.
        // Safari uses its own signed-in browser session, as it does for GuideRow.
        case .inbox, .approvals, .ops:
            SafariView(url: API.shared.publicBase.appendingPathComponent(target == .ops ? "_ops" : target.rawValue))
                .ignoresSafeArea()
        case .newBoard: NewBoardSheet(open: finish)
        case .settings: SettingsView()
        case .feedback: FeedbackView()
        case .reportBug: ReportBugView()
        }
    }
}

extension View {
    func menuSheet(isPresented: Binding<Bool>, onOpen: ((Board) -> Void)? = nil) -> some View {
        sheet(isPresented: isPresented) { MenuSheet(onOpen: onOpen) }
    }
}

private enum MenuDestination: String, Identifiable {
    case forYou = "for-you", inbox, approvals, boards, people, guide, ops
    case newBoard = "new-board", settings, feedback, reportBug = "report-bug"
    var id: String { rawValue }
    static let main: [Self] = [.forYou, .inbox, .approvals, .boards, .people, .guide, .ops]

    var title: String {
        switch self {
        case .forYou: String(localized: "For you", bundle: .l10n)
        case .inbox: String(localized: "Inbox", bundle: .l10n)
        case .approvals: String(localized: "Approvals", bundle: .l10n)
        case .boards: String(localized: "Boards", bundle: .l10n)
        case .people: String(localized: "People", bundle: .l10n)
        case .guide: String(localized: "Guide", bundle: .l10n)
        case .ops: String(localized: "Ops", bundle: .l10n)
        case .newBoard: String(localized: "New board", bundle: .l10n)
        case .settings: String(localized: "Settings", bundle: .l10n)
        case .feedback: String(localized: "Send feedback", bundle: .l10n)
        case .reportBug: String(localized: "Report a bug", bundle: .l10n)
        }
    }

    var symbol: String {
        switch self {
        case .forYou: "house"
        case .inbox: "tray"
        case .approvals: "checkmark.shield"
        case .boards: "square.grid.2x2"
        case .people: "person"
        case .guide: "book"
        case .ops: "shield"
        case .newBoard: "plus"
        case .settings: "person.crop.circle"
        case .feedback: "bubble.left"
        case .reportBug: "exclamationmark.triangle"
        }
    }
}

/// Only pending approvals for this board count. Approval state takes precedence over working.
struct MenuBoardStatus {
    enum Activity { case approval, working, quiet }
    let working: Int
    let approvals: Int

    init(board: Board, agents: [BoardAgent]?, approvals: [Approval]) {
        working = max(0, agents.map { $0.filter { $0.state == "live" }.count } ?? board.liveAgents ?? 0)
        self.approvals = approvals.filter { $0.boardId == board.id && $0.status == "pending" }.count
    }

    var activity: Activity { approvals > 0 ? .approval : working > 0 ? .working : .quiet }
    var color: Color {
        switch activity {
        case .approval: Theme.warn
        case .working: Theme.ok
        case .quiet: Theme.lineStrong
        }
    }
    var label: String {
        let workers = String(localized: "\(working) working", bundle: .l10n)
        guard approvals > 0 else { return workers }
        let waiting = String(localized: "\(approvals) approvals", bundle: .l10n)
        return String(localized: "\(workers) · \(waiting)", bundle: .l10n)
    }
}
