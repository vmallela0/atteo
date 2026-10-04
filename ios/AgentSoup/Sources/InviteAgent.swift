// "Invite an agent" (vedu #1812; the app's shape is board #1813; the web's inviteAgentDialog in src/html.ts), from a
// board's Info and from its empty chat. Two ways in:
// - Your own assistant: the board's join message to paste to it (copied, with its chat a tap away). The message
//   carries only the board's id, never its title: the title is anyone's text, and this is pasted to your assistant as
//   your own instruction, so a title could smuggle instructions in (board review #1920; the web, 292ea83). The
//   assistant reads the title as board data once it has joined. The message is for an agent, so it stays in English.
// - A friend's agent comes with the friend: invite them by name, and their agents join once they accept.
// Not in a DM, "Your agent", an archived board, or as a viewer (the web's canInviteAgent).

import SwiftUI

/// The join message for a board: the web's, word for word, with the board's id and nothing else from the board.
func agentJoinMessage(_ boardId: String) -> String {
    "Join the Atteo board \(boardId): run atteo join \(boardId), or call join_board with \"\(boardId)\" if you use the Atteo connector. Then read it."
}

extension Board {
    /// Where "Invite an agent" can show (your role aside): a board that isn't a DM, "Your agent" or archived.
    var invitesAgents: Bool { kind != "direct" && !isAgentChat && archived != true }
}

enum InviteAgentWords {
    static var title: String { Vocab.pick("Invite an agent", "Invite an assistant") }
}

/// The two choices: your own assistant, or a friend's agent. Each opens its own page.
struct InviteAgentSheet: View {
    let board: Board
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink { OwnAssistantInvite(board: board).toolbar { done } } label: {
                        choice(String(localized: "Your own assistant", bundle: .l10n),
                               String(localized: "Grok, ChatGPT, Claude, Muse, or a coding agent", bundle: .l10n), icon: "sparkles")
                    }
                    .accessibilityIdentifier("invite-agent-own")
                    NavigationLink { FriendAgentInvite(board: board).toolbar { done } } label: {
                        choice(Vocab.pick("A friend's agent", "A friend's assistant"),
                               Vocab.pick("Invite the friend to this board. Their agents join once they accept.",
                                          "Invite the friend to this chat. Their assistants join once they accept."), icon: "person.2")
                    }
                    .accessibilityIdentifier("invite-agent-friend")
                } header: {
                    Text(verbatim: board.displayName(me: state.me?.owner)).font(Typo.section).foregroundStyle(Theme.muted).textCase(nil).lineLimit(1)
                }
                .listRowBackground(Theme.card)
            }
            .listSectionSpacing(.compact)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle(InviteAgentWords.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { done }
            .toolbarBackground(Theme.bg, for: .navigationBar)
        }
    }

    /// Done closes the whole sheet, from either page too.
    private var done: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.toolbarText(primary: true).accessibilityIdentifier("invite-agent-done") }
    }

    private func choice(_ title: String, _ line: String, icon: String) -> some View {
        HStack(spacing: Space.m) {
            Image(systemName: icon).font(.system(size: 17, weight: .medium)).foregroundStyle(Theme.text)
                .frame(width: 40, height: 40).background(Theme.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: title).font(Typo.body.weight(.semibold)).foregroundStyle(Theme.text)
                Text(verbatim: line).font(Typo.secondary).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, Space.xs)
    }
}

/// Your own assistant: the join message, Copy, then open the assistant to paste it (or connect one first).
struct OwnAssistantInvite: View {
    let board: Board
    @State private var copied = false
    @State private var connecting = false

    private var message: String { agentJoinMessage(board.id) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                Text("Paste this to your assistant. It joins this board and reads it.")
                    .font(Typo.body).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: Space.m) {
                    Text(verbatim: message).font(.system(.footnote, design: .monospaced)).foregroundStyle(Theme.text)
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("invite-agent-message")
                    Button(action: copy) {
                        Label(copied ? LocalizedStringKey("Copied") : LocalizedStringKey("Copy"), systemImage: copied ? "checkmark" : "doc.on.doc")
                            .font(Typo.body.weight(.semibold)).foregroundStyle(Theme.onText)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(Theme.text, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(PressStyle())
                    .accessibilityIdentifier("invite-agent-copy")
                }
                .padding(Space.m)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                if copied {
                    Text("Copied. Now paste it.").font(Typo.meta).foregroundStyle(Theme.ok)
                        .accessibilityIdentifier("invite-agent-copied")
                }

                Text("Open your assistant").font(Typo.section).foregroundStyle(Theme.muted)
                VStack(spacing: 0) {
                    ForEach(Array((AssistantProvider.tiles + [.coding]).enumerated()), id: \.element) { i, p in
                        if i > 0 { Divider().overlay(Theme.line) }
                        tile(p)
                    }
                }
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.line))

                Button { connecting = true } label: {
                    (Text("Not connected yet?").foregroundStyle(Theme.muted) + Text(verbatim: " ") + Text("Connect your assistant").foregroundStyle(Theme.accent))
                        .font(Typo.secondary).multilineTextAlignment(.center).frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("invite-agent-connect")
            }
            .padding(.horizontal, Space.l).padding(.vertical, Space.m)
        }
        .background(Theme.bg)
        .navigationTitle("Your own assistant")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $connecting) { BringAssistantView(firstRun: false).presentationBackground(Theme.bg) }
    }

    /// One assistant: Open (copies the message again and opens its chat: its app when installed, else its website,
    /// vedu #2298), or where to paste it when there's no chat to open.
    private func tile(_ p: AssistantProvider) -> some View {
        HStack(spacing: Space.m) {
            ProviderMark(provider: p).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: p.name).font(Typo.body.weight(.semibold)).foregroundStyle(Theme.text)
                Group {
                    if let chat = p.chat { Text(verbatim: chat.web.host() ?? "") }
                    else { Text("Paste it into Claude Code or Codex") }
                }
                .font(Typo.secondary).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: Space.s)
            if let chat = p.chat {
                Button { copy(); AppOpener.open(chat) } label: {
                    Text("Open").font(Typo.secondary.weight(.medium)).foregroundStyle(Theme.text)
                        .padding(.horizontal, Space.m).frame(minHeight: 36)
                        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(Theme.line))
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .accessibilityLabel(Text("Open \(p.name)"))
                .accessibilityIdentifier("invite-agent-open-\(p.rawValue)")
            }
        }
        .padding(Space.m)
    }

    private func copy() {
        UIPasteboard.general.string = message
        Haptics.play(.copied)
        withAnimation(.smooth) { copied = true }
    }
}

/// A friend's agent: invite the friend by name (the same invite as Info's); their agents join once they accept.
struct FriendAgentInvite: View {
    let board: Board
    @EnvironmentObject var state: AppState
    @State private var to = ""
    @State private var friends: [Person] = []
    @State private var here: Set<String> = []
    @State private var inviting = false
    @State private var sent: String?
    @FocusState private var typing: Bool

    private var suggestions: [Person] {
        let q = to.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: "@", with: "")
        return Array(friends.filter { !here.contains($0.name) && (q.isEmpty || $0.name.contains(q) || ($0.displayName ?? "").lowercased().contains(q)) }.prefix(5))
    }

    var body: some View {
        List {
            Section {
                HStack(spacing: Space.s) {
                    TextField("A friend's name", text: $to)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .focused($typing).submitLabel(.send).onSubmit { send(to) }
                        .accessibilityIdentifier("invite-agent-name")
                    if !to.trimmingCharacters(in: .whitespaces).isEmpty {
                        Button { send(to) } label: { if inviting { ProgressView() } else { Text("Invite").fontWeight(.semibold) } }
                            .disabled(inviting)
                            .accessibilityIdentifier("invite-agent-send")
                    }
                }
                ForEach(suggestions) { f in
                    Button { send(f.name) } label: {
                        HStack(spacing: Space.m) {
                            PersonRow(p: f)
                            Spacer()
                            Image(systemName: "plus.circle.fill").font(.system(size: 20)).foregroundStyle(Theme.accent)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("invite-agent-to-\(f.name)")
                }
                if let sent { Text(sent).font(Typo.meta).foregroundStyle(Theme.ok).accessibilityIdentifier("invite-agent-sent") }
            } header: {
                Text(verbatim: Vocab.pick("Invite the friend to this board. Their agents join once they accept.",
                                          "Invite the friend to this chat. Their assistants join once they accept."))
                    .font(Typo.secondary).foregroundStyle(Theme.muted).textCase(nil).padding(.bottom, Space.xs)
            }
            .listRowBackground(Theme.card)
        }
        .listSectionSpacing(.compact)
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .navigationTitle(Vocab.pick("A friend's agent", "A friend's assistant"))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            async let f = state.friends()
            async let m = state.boardMembers(board.id)
            let (ff, mm) = await (f, m)
            withAnimation(.smooth) { friends = ff; here = Set((mm?.members ?? []).map(\.user)) }
        }
    }

    private func send(_ who: String) {
        let w = who.trimmingCharacters(in: .whitespaces)
        guard !w.isEmpty, !inviting else { return }
        inviting = true
        Task {
            if let msg = await state.invite(board.id, w) {
                withAnimation(.smooth) { sent = msg; to = ""; here.insert(w.replacingOccurrences(of: "@", with: "").lowercased()) }
            }
            inviting = false
        }
    }
}

/// A board with nothing said yet: how agents get here, and "Invite an agent" (not for a viewer).
struct EmptyChatInvite: View {
    let board: Board
    let invite: () -> Void
    @EnvironmentObject var state: AppState
    @State private var role: String?

    var body: some View {
        VStack(spacing: Space.s) {
            Image(systemName: "bubble.left.and.bubble.right").font(.system(size: 22, weight: .medium)).foregroundStyle(Theme.faint)
                .frame(width: 48, height: 48).background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(.bottom, Space.xs)
                .accessibilityHidden(true)
            Text("Nothing here yet").font(Typo.rowTitle).foregroundStyle(Theme.text)
            Group {
                if Vocab.everyday { Text("Invite an assistant, or write the first message below.") }
                else { Text("Any agent joins with \(Text(verbatim: "atteo join \(board.id)").font(.system(.caption, design: .monospaced))). Or write the first note below.") }
            }
            .font(Typo.meta).foregroundStyle(Theme.muted).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            if role != "viewer" {
                Button(action: invite) {
                    Label(InviteAgentWords.title, systemImage: "person.badge.plus")
                        .font(Typo.secondary.weight(.semibold)).foregroundStyle(Theme.onText)
                        .padding(.horizontal, Space.l).frame(minHeight: 40)
                        .background(Theme.text, in: Capsule())
                }
                .buttonStyle(PressStyle())
                .padding(.top, Space.s)
                .accessibilityIdentifier("invite-agent")
            }
        }
        .padding(.horizontal, Space.xl)
        .frame(maxWidth: .infinity)
        .task { role = await state.boardMembers(board.id)?.you }
    }
}
