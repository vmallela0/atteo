// The one screen you live in: what needs you (approvals, first contact) pinned on top with one-tap answers, then
// every board and DM, newest first, with unread counts and who spoke last. Open one to read and reply.

import SwiftUI

struct ChatsView: View {
    @EnvironmentObject var state: AppState
    @State private var query = ""
    @State private var path: [Board] = []
    @State private var showAll = false

    private func unread(_ b: Board) -> Int { state.inbox.filter { $0.boardId == b.id && $0.readAt == nil }.count }

    var chats: [Board] {
        let all = state.boards.sorted { (unread($0) > 0 ? 1 : 0, $0.lastActivity) > (unread($1) > 0 ? 1 : 0, $1.lastActivity) }
        guard !query.isEmpty else { return all }
        return all.filter { $0.title.localizedCaseInsensitiveContains(query) || ($0.last?.text.localizedCaseInsensitiveContains(query) ?? false) || ($0.last?.by.localizedCaseInsensitiveContains(query) ?? false) }
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if query.isEmpty && (!state.approvals.isEmpty || !state.contacts.isEmpty) {
                    Section {
                        let items: [AnyView] = state.approvals.map { AnyView(ApprovalRow(a: $0)) } + state.contacts.map { AnyView(ContactRow(c: $0)) }
                        ForEach(Array((showAll ? items : Array(items.prefix(2))).enumerated()), id: \.offset) { $0.element }
                        if items.count > 2 {
                            Button(showAll ? "Show less" : "Show \(items.count - 2) more") { withAnimation(.snappy) { showAll.toggle() } }
                                .font(.footnote.weight(.semibold)).foregroundStyle(Theme.accent).listRowBackground(Theme.bg)
                        }
                    } header: { Text("Needs you · \(state.approvals.count + state.contacts.count)").font(.footnote.weight(.semibold)).foregroundStyle(Theme.warn) }
                }
                Section {
                    ForEach(chats) { b in
                        NavigationLink(value: b) { ChatRow(b: b, unread: unread(b)) }
                            .listRowBackground(Theme.bg)
                            .listRowSeparatorTint(Theme.line)
                            .swipeActions(edge: .leading) {
                                if unread(b) > 0 { Button { Task { await state.markRead(b) } } label: { Label("Read", systemImage: "checkmark") }.tint(Theme.accent) }
                            }
                    }
                } header: { if query.isEmpty && (!state.approvals.isEmpty || !state.contacts.isEmpty) { Text("Chats").font(.footnote.weight(.semibold)).foregroundStyle(Theme.faint) } }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Chats")
            .searchable(text: $query, prompt: "Search")
            .refreshable { await state.refreshAll() }
            .navigationDestination(for: Board.self) { b in BoardView(board: b) }
            .overlay { if state.boards.isEmpty && state.approvals.isEmpty { ContentUnavailableView("No chats yet", systemImage: "bubble.left.and.bubble.right", description: Text("Boards and DMs you're in show up here.")) } }
            .onChange(of: state.boards.count) { _, _ in
                #if DEBUG
                // Simulator screenshots: AGENT_SOUP_OPEN_BOARD opens that board once the list loads.
                if path.isEmpty, let id = ProcessInfo.processInfo.environment["AGENT_SOUP_OPEN_BOARD"], let b = state.boards.first(where: { $0.id == id }) { path = [b] }
                #endif
            }
        }
    }
}

struct ChatRow: View {
    let b: Board
    let unread: Int
    var dm: Bool { b.kind == "direct" }

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Theme.hue(b.id).opacity(0.2)).frame(width: 44, height: 44)
                Image(systemName: dm ? "person.2.fill" : b.encrypted == true ? "lock.fill" : "number").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.hue(b.id))
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(b.title).font(.body.weight(unread > 0 ? .bold : .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    Spacer(minLength: 6)
                    Text(b.lastActivity.ago).font(.caption).foregroundStyle(unread > 0 ? Theme.accent : Theme.faint)
                }
                HStack(alignment: .center) {
                    Group {
                        if let l = b.last {
                            Text(l.by).fontWeight(.medium).foregroundStyle(Theme.muted) + Text(": ").foregroundStyle(Theme.faint) + Text(l.text.md).foregroundStyle(Theme.faint)
                        } else {
                            Text(b.entryCount == 1 ? "1 message" : "\(b.entryCount) messages").foregroundStyle(Theme.faint)
                        }
                    }
                    .font(.subheadline).lineLimit(1)
                    Spacer(minLength: 6)
                    if unread > 0 {
                        Text("\(unread)").font(.caption2.weight(.bold)).foregroundStyle(.black)
                            .padding(.horizontal, 6).frame(minWidth: 20, minHeight: 20).background(Theme.accent, in: Capsule())
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}

/// Round one-tap answer buttons for "Needs you" rows.
struct AnswerButtons: View {
    let yes: () -> Void
    let no: () -> Void
    var yesColor: Color = Theme.ok

    var body: some View {
        HStack(spacing: 8) {
            Button(action: no) { Image(systemName: "xmark").font(.system(size: 14, weight: .bold)).frame(width: 34, height: 34).background(Theme.line, in: Circle()).foregroundStyle(Theme.text) }
                .buttonStyle(.plain).accessibilityLabel("No")
            Button(action: yes) { Image(systemName: "checkmark").font(.system(size: 14, weight: .bold)).frame(width: 34, height: 34).background(yesColor, in: Circle()).foregroundStyle(.black) }
                .buttonStyle(.plain).accessibilityLabel("Yes")
        }
    }
}

/// An agent asking before a side effect: approve or reject in one tap (or swipe).
struct ApprovalRow: View {
    @EnvironmentObject var state: AppState
    let a: Approval
    var riskColor: Color { a.risk == "high" ? Theme.danger : a.risk == "medium" ? Theme.warn : Theme.ok }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "hand.raised.fill").font(.system(size: 15)).foregroundStyle(riskColor).frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(a.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text).lineLimit(1)
                Text(a.details.isEmpty ? "\(a.risk) risk · \(a.createdAt.ago)" : a.details).font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: 6)
            AnswerButtons(yes: { Haptic.done(); Task { await state.decide(a, approve: true) } }, no: { Haptic.warn(); Task { await state.decide(a, approve: false) } })
        }
        .padding(.vertical, 2)
        .listRowBackground(Theme.bg)
        .swipeActions(edge: .leading) { Button { Haptic.done(); Task { await state.decide(a, approve: true) } } label: { Label("Approve", systemImage: "checkmark") }.tint(Theme.ok) }
        .swipeActions(edge: .trailing) { Button(role: .destructive) { Haptic.warn(); Task { await state.decide(a, approve: false) } } label: { Label("Reject", systemImage: "xmark") } }
    }
}

/// Someone's agent wants to talk to yours for the first time.
struct ContactRow: View {
    @EnvironmentObject var state: AppState
    let c: ContactsResponse.Incoming

    var body: some View {
        HStack(spacing: 10) {
            Avatar(name: c.from, agent: true, size: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(c.from)'s agent wants to talk").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text).lineLimit(1)
                Text(c.text ?? "first contact · \(c.createdAt.ago)").font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: 6)
            AnswerButtons(yes: { Haptic.done(); Task { await state.answer(c, accept: true) } }, no: { Haptic.warn(); Task { await state.answer(c, accept: false) } }, yesColor: Theme.accent)
        }
        .padding(.vertical, 2)
        .listRowBackground(Theme.bg)
        .swipeActions(edge: .leading) { Button { Task { await state.answer(c, accept: true) } } label: { Label("Allow", systemImage: "checkmark") }.tint(Theme.accent) }
        .swipeActions(edge: .trailing) { Button(role: .destructive) { Task { await state.answer(c, accept: false) } } label: { Label("Decline", systemImage: "xmark") } }
    }
}
