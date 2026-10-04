// "Your agent" (#720): your private chat with your own agents. POST /api/me/agent-chat makes it the first time (and
// just returns it after that), with the sessions you can address one by one. It's pinned at the top of DMs with your
// agent's picture, never listed under Boards; inside, there's nobody to invite, and a "To" picker above the message box
// sends to any of your agents (the mailbox: whichever picks it up) or one live / idle session (`to_session`).

import SwiftUI

/// One of your agent sessions you can send to.
struct AgentChatSession: Decodable, Hashable, Identifiable {
    let id: String
    let name: String
    let client: String?
    let state: String? // live | idle
    let status: String?
    /// "builder · Claude Code", "scout · Codex (idle)".
    var label: String {
        let c = client.map { " · " + ($0.components(separatedBy: " (").first ?? $0) } ?? ""
        return name + c + (state == "live" ? "" : " (idle)")
    }
}

struct AgentChatResponse: Decodable {
    let board: String
    let title: String
    var created: Bool? = nil
    var sessions: [AgentChatSession] = []
}

extension Board {
    /// "Your agent": your private chat with your own agents.
    var isAgentChat: Bool { kind == "agent" }
}

extension AppState {
    /// Your agent's chat (made the first time), ready to open; its sessions come with it.
    func openAgentChat() async -> Board? {
        do {
            let d = try await API.shared.send("/api/me/agent-chat", retries: false)
            let r = try JSONDecoder.soup.decode(AgentChatResponse.self, from: d)
            withAnimation(.smooth) { agentSessions = r.sessions }
            if !boards.contains(where: { $0.id == r.board }) { await refreshBoards() }
            return boards.first { $0.id == r.board }
                ?? Board(id: r.board, title: r.title, kind: "agent", entryCount: 0, lastActivity: Date().timeIntervalSince1970 * 1000, encrypted: false, last: nil, createdBy: me?.owner)
        } catch { report(error); return nil }
    }

    /// Your agent's chat, if this phone has seen it in your list.
    var agentChat: Board? { boards.first { $0.isAgentChat && $0.archived != true } }
}

/// The pinned row at the top of DMs: your agent's picture, "Your agent", and its last line (or what it's for).
struct AgentChatRow: View {
    @EnvironmentObject var state: AppState
    let unread: Int

    var body: some View {
        let b = state.agentChat
        HStack(alignment: .center, spacing: Space.m) {
            Avatar(name: state.me?.owner ?? "", agent: true, size: 44)
                .overlay(alignment: .bottomTrailing) {
                    if state.sessions.contains(where: { $0.active == true }) { LiveDot(size: 9).padding(2.5).background(Theme.bg, in: Circle()).offset(x: 3, y: 3) }
                }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Space.xxs) {
                HStack(alignment: .firstTextBaseline, spacing: Space.xs) {
                    Text(Vocab.yourAgent).font(unread > 0 ? Typo.rowTitle : Typo.rowTitleRead).foregroundStyle(Theme.text).lineLimit(1)
                    Image(systemName: "pin.fill").font(.system(size: 9)).foregroundStyle(Theme.faint).accessibilityHidden(true)
                    Spacer(minLength: Space.s)
                    if let b { Text(b.lastActivity.ago).font(Typo.meta).foregroundStyle(unread > 0 ? Theme.accent : Theme.faint).monospacedDigit() }
                }
                HStack(alignment: .center, spacing: Space.s) {
                    Group {
                        if let l = b?.last { Text(Vocab.shown(l.by) + ": ").foregroundStyle(Theme.muted) + Text(l.text.md).foregroundStyle(unread > 0 ? Theme.muted : Theme.faint) }
                        else { Text(Vocab.pick("Ask any of your agents, or one session", "Ask your assistant anything")).foregroundStyle(Theme.faint) }
                    }
                    .font(Typo.secondary).lineLimit(1)
                    Spacer(minLength: 0)
                    if unread > 0 { CountBadge(n: unread).accessibilityLabel("\(unread) unread") }
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Above the message box in "Your agent": who gets it. Any of my agents, or one live / idle session.
struct AgentToPicker: View {
    @EnvironmentObject var state: AppState
    @Binding var to: String? // a session's name; nil: any of my agents

    var body: some View {
        let sessions = state.agentSessions
        Menu {
            Picker("Send to", selection: $to) {
                Text("Any of my agents").tag(String?.none)
                ForEach(sessions) { s in Text(s.label).tag(Optional(s.name)) }
            }
        } label: {
            HStack(spacing: 6) {
                Text("To").foregroundStyle(Theme.faint)
                Avatar(name: state.me?.owner ?? "", agent: true, size: 18)
                Text(to.map { n in sessions.first { $0.name == n }?.label ?? n } ?? "Any of my agents").foregroundStyle(Theme.text).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.faint)
            }
            .font(Typo.micro.weight(.medium))
            .padding(.horizontal, Space.s).frame(minHeight: 28)
            .background(Theme.card, in: Capsule())
            .contentShape(Capsule())
        }
        .menuOrder(.fixed)
        .accessibilityIdentifier("agent-to")
        .accessibilityLabel("Send to")
        .accessibilityValue(to ?? "Any of my agents")
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Space.l)
        .padding(.bottom, Space.xs)
        // A session that went away while picked: back to any of them.
        .onChange(of: sessions) { _, list in if let t = to, !list.contains(where: { $0.name == t }) { to = nil } }
    }
}
