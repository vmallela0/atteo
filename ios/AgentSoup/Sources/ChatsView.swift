// The one screen you live in: what needs you (approvals, first contact) pinned on top with one-tap answers, then
// every board and DM, newest first, with unread counts and who spoke last. Open one to read and reply.

import SwiftUI

struct ChatsView: View {
    @EnvironmentObject var state: AppState
    @State private var query = ""
    @State private var path: [Board] = []
    @State private var showAll = false
    @State private var showSettings = false
    @State private var showAgents: Bool = {
        #if DEBUG
        return ProcessInfo.processInfo.environment["AGENT_SOUP_TAB"] == "1" // simulator screenshots
        #else
        return false
        #endif
    }()

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
                        // Keyed by each item's own id, so answering one animates it out (instead of the next row's
                        // content swapping into its place).
                        let items: [(id: String, view: AnyView)] = state.approvals.map { ("a-" + $0.id, AnyView(ApprovalRow(a: $0))) } + state.contacts.map { ("c-" + $0.from, AnyView(ContactRow(c: $0))) }
                        ForEach(showAll ? items : Array(items.prefix(2)), id: \.id) { $0.view.transition(.opacity.combined(with: .move(edge: .leading))) }
                        if items.count > 2 {
                            Button(showAll ? "Show less" : "Show \(items.count - 2) more") { withAnimation(.snappy) { showAll.toggle() } }
                                .font(.footnote.weight(.semibold)).foregroundStyle(Theme.accent).listRowBackground(Theme.bg)
                        }
                    } header: { Text("Needs you · \(state.approvals.count + state.contacts.count)").font(.footnote.weight(.semibold)).foregroundStyle(Theme.accent).contentTransition(.numericText()).accessibilityIdentifier("needs-you") }
                }
                Section {
                    ForEach(chats) { b in
                        // A row you tap (no disclosure arrow): the whole row opens the chat.
                        ChatRow(b: b, unread: unread(b))
                            .contentShape(Rectangle())
                            .onTapGesture { Haptic.tap(); path.append(b) }
                            .accessibilityAddTraits(.isButton)
                            .accessibilityIdentifier("chat-\(b.title)")
                            .listRowBackground(Theme.bg)
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 16))
                            .swipeActions(edge: .leading) {
                                if unread(b) > 0 { Button { Task { await state.markRead(b) } } label: { Label("Read", systemImage: "checkmark") }.tint(Theme.accent) }
                            }
                    }
                }
            }
            .listStyle(.plain)
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
            .sheet(isPresented: $showAgents) { AgentsView().presentationDetents([.medium, .large]).presentationBackground(Theme.bg) }
            .searchable(text: $query, prompt: "Search")
            .refreshable { await state.refreshAll() }
            .navigationDestination(for: Board.self) { b in BoardView(board: b) }
            .overlay {
                if state.boards.isEmpty && !state.loaded {
                    VStack(spacing: 0) { ForEach(0..<7, id: \.self) { _ in PlaceholderChat() } }.frame(maxHeight: .infinity, alignment: .top).padding(.top, 8)
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

struct ChatRow: View {
    let b: Board
    let unread: Int

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(unread > 0 ? Theme.accent : .clear).frame(width: 7, height: 7).padding(.top, 7)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(b.title).font(.body.weight(unread > 0 ? .semibold : .regular)).foregroundStyle(Theme.text).lineLimit(1)
                    if b.kind == "direct" { Image(systemName: "person.2").font(.caption2).foregroundStyle(Theme.faint) }
                    if b.encrypted == true { Image(systemName: "lock").font(.caption2).foregroundStyle(Theme.faint) }
                    Spacer(minLength: 8)
                    if let n = b.liveAgents, n > 0 {
                        // Agents working on it right now: the one signal that matters at a glance.
                        HStack(spacing: 5) { LiveDot(size: 6); Text("\(n) working").font(.footnote).foregroundStyle(Theme.ok) }
                            .accessibilityLabel("\(n) agent\(n == 1 ? "" : "s") working now")
                    } else {
                        Text(b.lastActivity.ago).font(.footnote).foregroundStyle(Theme.faint).monospacedDigit()
                    }
                }
                Group {
                    if let l = b.last {
                        Text(l.by).foregroundStyle(Theme.muted) + Text(": ").foregroundStyle(Theme.faint) + Text(l.text.md).foregroundStyle(Theme.faint)
                    } else {
                        Text(b.entryCount == 1 ? "1 message" : "\(b.entryCount) messages").foregroundStyle(Theme.faint)
                    }
                }
                .font(.subheadline).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
    }
}

/// Round one-tap answer buttons for "Needs you" rows.
struct AnswerButtons: View {
    let yes: () -> Void
    let no: () -> Void
    var yesColor: Color = Theme.ok

    var body: some View {
        HStack(spacing: 8) {
            Button(action: no) { Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).frame(width: 34, height: 34).overlay(Circle().stroke(Theme.line, lineWidth: 1)).foregroundStyle(Theme.muted) }
                .buttonStyle(.plain).accessibilityLabel("No")
            Button(action: yes) { Image(systemName: "checkmark").font(.system(size: 13, weight: .bold)).frame(width: 34, height: 34).background(Theme.text, in: Circle()).foregroundStyle(.black) }
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
            Circle().fill(riskColor).frame(width: 7, height: 7).frame(width: 14)
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
            Image(systemName: "sparkle").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.accent).frame(width: 14)
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

/// A grey stand-in for a chat row while the first list loads (no blank flash).
struct PlaceholderChat: View {
    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Theme.card).frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 7) {
                RoundedRectangle(cornerRadius: 4).fill(Theme.card).frame(width: 140, height: 12)
                RoundedRectangle(cornerRadius: 4).fill(Theme.card).frame(maxWidth: .infinity).frame(height: 11)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
    }
}
