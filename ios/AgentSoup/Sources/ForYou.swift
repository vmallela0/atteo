// Everyday's first screen, "For you" (ios/qa/design/everyday, `home`): a greeting, what needs you (an OK your
// assistant asked for, with Approve / Not now right there; a decision to make; someone asking you; an assistant that
// wants to talk to yours), then what got done for you today, and "Ask your assistant…" at the bottom. Chats is the
// button top right. Everything comes from what the app already loads (approvals, inbox, contacts) plus the to-dos of
// the chats that moved today.

import SwiftUI

struct ForYouView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.chatDensity) private var density
    let openChats: () -> Void
    @State private var path: [Board] = []
    @State private var showSettings = false
    @State private var asking: AskStart?
    @State private var done: [DoneItem] = []
    @State private var answered: Set<Int> = [] // inbox items you answered here (they leave at once)
    @State private var allDone = false

    struct DoneItem: Identifiable, Hashable { let id: String; let title: String; let board: Board; let at: Double }

    private var boards: [Board] { state.boards.filter { $0.archived != true } }

    /// Decisions to make and people asking you, unread, newest first (approvals and contacts have their own rows).
    private var asks: [InboxItem] {
        state.inbox.filter { $0.readAt == nil && !$0.boardId.isEmpty && !answered.contains($0.id) && ["decision", "mention", "reply", "people_only"].contains($0.kind) }
            .sorted { $0.createdAt > $1.createdAt }
    }
    private var needCount: Int { state.approvals.count + state.contacts.count + asks.count }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    greeting
                    needs
                    doneToday
                }
                .padding(.horizontal, Space.l).padding(.top, Space.s).padding(.bottom, 96)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .refreshable { await state.refreshAll(); await loadDone() }
            .safeAreaInset(edge: .bottom, spacing: 0) { askBar }
            .navigationTitle("For you")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showSettings = true } label: { Avatar(name: state.me?.owner ?? "", size: 30) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Settings")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: openChats) {
                        HStack(spacing: 6) {
                            Text("Chats").foregroundStyle(Theme.text)
                            if !boards.isEmpty { Text("\(boards.count)").foregroundStyle(Theme.faint).monospacedDigit() }
                        }
                        .font(Typo.secondary.weight(.medium))
                        .padding(.horizontal, Space.m).frame(height: 32)
                        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).stroke(Theme.line))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("open-chats")
                }
            }
            .navigationDestination(for: Board.self) { b in BoardView(board: b) }
            .sheet(isPresented: $showSettings) { SettingsView().presentationBackground(Theme.bg).environment(\.chatDensity, density) }
            .fullScreenCover(item: $asking) { s in
                AskView(typing: s.typing) { b in asking = nil; if let b { path = [b] } }
                    .environmentObject(state)
            }
            .task { await loadDone() }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("for-you-screen")
    }

    // MARK: Greeting

    private var greeting: some View {
        let h = Calendar.current.component(.hour, from: Date())
        let raw = state.profile?.displayName?.trimmingCharacters(in: .whitespaces).nonEmpty ?? state.me?.owner ?? ""
        let name = raw.split(separator: " ").first.map { String($0).capitalizedFirst } ?? ""
        let did = done.count
        let line = needCount == 0
            ? (did > 0 ? String(localized: "Nothing needs you. Your assistant did \(did) things today.", bundle: .l10n) : String(localized: "Nothing needs you right now.", bundle: .l10n))
            : String(localized: "\(needCount) things need you.", bundle: .l10n) + (did > 0 ? " " + String(localized: "Your assistant did \(did) more.", bundle: .l10n) : "")
        let hello = h < 12
            ? (name.isEmpty ? String(localized: "Good morning", bundle: .l10n) : String(localized: "Good morning, \(name)", bundle: .l10n))
            : h < 18
            ? (name.isEmpty ? String(localized: "Good afternoon", bundle: .l10n) : String(localized: "Good afternoon, \(name)", bundle: .l10n))
            : (name.isEmpty ? String(localized: "Good evening", bundle: .l10n) : String(localized: "Good evening, \(name)", bundle: .l10n))
        return VStack(alignment: .leading, spacing: Space.xs) {
            Text(hello)
                .font(Typo.headline(28, .semibold, .title)).foregroundStyle(Theme.text)
                .accessibilityIdentifier("greeting")
            Text(line).font(Typo.body).foregroundStyle(Theme.muted)
                .contentTransition(.numericText())
                .accessibilityIdentifier("needs-count")
        }
        .padding(.top, Space.s)
    }

    // MARK: Needs you

    @ViewBuilder private var needs: some View {
        let approvals = state.approvals.sorted { $0.createdAt > $1.createdAt } // the latest ask first
        if let first = approvals.first {
            OKCard(a: first, index: 1, of: approvals.count, boardTitle: title(of: first.boardId))
                .id("ok-" + first.id)
                .transition(.asymmetric(insertion: .opacity, removal: .move(edge: .leading).combined(with: .opacity)))
        }
        let rest: [(id: String, view: AnyView)] =
            approvals.dropFirst().map { a in ("a-" + a.id, AnyView(OKRow(a: a, boardTitle: title(of: a.boardId)))) }
            + asks.map { i in ("i-\(i.id)", AnyView(askRow(i))) }
            + state.contacts.map { c in ("c-" + c.from, AnyView(contactRow(c))) }
        if !rest.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(rest.enumerated()), id: \.element.id) { i, r in
                    if i > 0 { Divider().overlay(Theme.line) }
                    r.view.transition(.opacity)
                }
            }
            .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).stroke(Theme.line))
            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        }
    }

    /// A decision to make, or someone asking you: answer it here (Agree / Not this) or Reply in its chat.
    private func askRow(_ i: InboxItem) -> some View {
        let decision = i.kind == "decision"
        let who = i.actorVia == "agent" ? Vocab.agentOf(i.actor) : i.actor.capitalizedFirst
        return NeedRow(edge: decision ? Color.purple : Color.blue, title: i.excerpt, sub: "\(who) · \(i.boardTitle ?? String(localized: "a chat", bundle: .l10n))") {
            if decision {
                small("Agree", id: "decide-agree") { Task { await vote(i, agree: true) } }
                small("Not this", id: "decide-object") { Task { await vote(i, agree: false) } }
            } else {
                small("Reply", id: "ask-reply") { reply(i) }
            }
        }
        .accessibilityIdentifier(decision ? "need-decision" : "need-ask")
    }

    private func contactRow(_ c: ContactsResponse.Incoming) -> some View {
        NeedRow(edge: Theme.accent, title: String(localized: "\(Vocab.agentOf(c.from)) wants to talk to yours", bundle: .l10n), sub: c.text ?? String(localized: "First time", bundle: .l10n)) {
            small("Not now", id: "contact-no") { Haptics.play(.denied); Task { await state.answer(c, accept: false) } }
            small("Allow", id: "contact-yes") { Haptics.play(.approved); Task { await state.answer(c, accept: true) } }
        }
        .accessibilityIdentifier("need-contact")
    }

    private func small(_ t: LocalizedStringKey, id: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(t).font(Typo.secondary.weight(.medium)).foregroundStyle(Theme.text)
                .padding(.horizontal, Space.m).frame(minHeight: 34)
                .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).stroke(Theme.line))
                .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .accessibilityIdentifier(id)
    }

    private func title(of board: String?) -> String? { board.flatMap { id in state.boards.first { $0.id == id }?.displayName(me: state.me?.owner) } }

    private func reply(_ i: InboxItem) {
        guard let b = state.boards.first(where: { $0.id == i.boardId }) else { return }
        state.jumpRequest = AppState.JumpRequest(board: b.id, seq: i.seq)
        path = [b]
    }

    /// Agree or object to a person's decision, from here (the chat shows where it stands).
    private func vote(_ i: InboxItem, agree: Bool) async {
        Haptics.play(agree ? .approved : .denied)
        _ = withAnimation(.smooth) { answered.insert(i.id) }
        do {
            try await API.shared.send("/api/boards/\(i.boardId)/entries/\(i.seq)/vote", body: ["vote": agree ? "agree" : "object"], retries: false)
            await state.markRead(ids: [i.id])
        } catch {
            _ = withAnimation(.smooth) { answered.remove(i.id) }
            state.report(error)
        }
    }

    // MARK: Done for you today

    @ViewBuilder private var doneToday: some View {
        if !done.isEmpty {
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(alignment: .firstTextBaseline) {
                    (Text("Done for you today").foregroundStyle(Theme.text) + Text(" · \(done.count)").foregroundStyle(Theme.faint))
                        .font(Typo.secondary.weight(.semibold))
                    Spacer()
                    if done.count > 4 {
                        Button(allDone ? "Show less" : "See all") { withAnimation(.snappy) { allDone.toggle() } }
                            .font(Typo.secondary).foregroundStyle(Theme.accent)
                    }
                }
                .padding(.top, Space.s)
                VStack(spacing: 0) {
                    ForEach(Array((allDone ? done : Array(done.prefix(4))).enumerated()), id: \.element.id) { i, d in
                        if i > 0 { Divider().overlay(Theme.line) }
                        Button { path = [d.board] } label: {
                            HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                                Image(systemName: "checkmark").font(.system(size: 10, weight: .black)).foregroundStyle(Theme.onText)
                                    .frame(width: 22, height: 22).background(Theme.ok, in: Circle()).onFirstLine(7)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(d.title).font(Typo.body).foregroundStyle(Theme.text).lineLimit(2).multilineTextAlignment(.leading)
                                    Text("\(d.board.displayName(me: state.me?.owner)) · \(Date(timeIntervalSince1970: d.at / 1000).formatted(date: .omitted, time: .shortened))")
                                        .font(Typo.meta).foregroundStyle(Theme.faint)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, Space.m).padding(.vertical, Space.m)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("done-item")
                    }
                }
                .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).stroke(Theme.line))
            }
        }
    }

    /// What finished today: to-dos done in the chats that moved today (at most 6 chats asked), and results already on
    /// this phone. Asked once when For you opens (and on pull to refresh), not on every new message.
    private func loadDone() async {
        let start = Calendar.current.startOfDay(for: Date()).timeIntervalSince1970 * 1000
        let today = boards.filter { $0.lastActivity >= start }.prefix(6)
        for b in today { await state.loadTasks(b) }
        var out: [DoneItem] = []
        for b in today {
            for t in (state.tasks[b.id] ?? []) where t.status == "done" && t.updatedAt >= start {
                out.append(DoneItem(id: "t-\(b.id)-\(t.seq)", title: t.title, board: b, at: t.updatedAt))
            }
            for e in (state.entries[b.id] ?? []) where e.type == "change" && e.ts >= start && e.retracts == nil {
                out.append(DoneItem(id: "c-\(b.id)-\(e.seq)", title: ChangeView(e).title, board: b, at: e.ts))
            }
        }
        let sorted = out.sorted { $0.at > $1.at }
        if sorted != done { withAnimation(.smooth) { done = sorted } }
    }

    // MARK: Ask

    struct AskStart: Identifiable { let typing: Bool; var id: Bool { typing } }

    private var askBar: some View {
        HStack(spacing: Space.s) {
            Button { asking = AskStart(typing: true) } label: {
                Text("Ask your assistant…").font(Typo.body).foregroundStyle(Theme.faint)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, Space.l).frame(minHeight: 48)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("ask-bar")
            Button { asking = AskStart(typing: false) } label: {
                Image(systemName: "mic.fill").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: 44, height: 44).background(Theme.accent, in: Circle())
            }
            .buttonStyle(PressStyle())
            .accessibilityLabel("Talk to your assistant")
            .accessibilityIdentifier("ask-mic")
            .padding(.trailing, 4)
        }
        .background(Theme.card, in: Rectangle())
        .overlay(Capsule().stroke(Theme.line))
        .padding(.horizontal, Space.l).padding(.bottom, Space.s).padding(.top, Space.xs)
        .background(Theme.bg.opacity(0.94))
    }
}

/// The first thing your assistant asked: what, where, the details in a box, Not now / Approve.
private struct OKCard: View {
    @EnvironmentObject var state: AppState
    let a: Approval
    let index: Int
    let of: Int
    let boardTitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            HStack(spacing: 6) {
                Circle().fill(Theme.warn).frame(width: 7, height: 7)
                Text("Needs your OK").font(Typo.secondary.weight(.medium)).foregroundStyle(Theme.warn)
                if of > 1 { Text("· \(index) of \(of)").font(Typo.secondary).foregroundStyle(Theme.faint) }
            }
            Text(a.title).font(Typo.ui(.title3).weight(.semibold)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("ok-title")
            HStack(spacing: Space.s) {
                AtteoMark(size: 20)
                ((a.requestedBy.map { Text(verbatim: Vocab.agentOf($0)) } ?? Text("Your assistant")).foregroundStyle(Theme.text) + (boardTitle.map { Text(" asked in \($0)") } ?? Text(" asked")).foregroundStyle(Theme.muted))
                    .font(Typo.secondary).lineLimit(1)
            }
            // One plain sentence (Developer mode's approval shows the exact command, risk and where it came from).
            if let line = a.details.split(separator: "\n").first.map(String.init), !line.trimmingCharacters(in: .whitespaces).isEmpty {
                Text(line).font(Typo.secondary).foregroundStyle(Theme.muted).lineLimit(2)
                    .padding(Space.m).frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).stroke(Theme.line))
            }
            HStack(spacing: Space.m) {
                Button { Task { await state.decide(a, approve: false) } } label: {
                    Text("Not now").font(Typo.body.weight(.medium)).foregroundStyle(Theme.text)
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).stroke(Theme.line))
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .accessibilityIdentifier("ok-not-now")
                Button { Task { await state.decide(a, approve: true) } } label: {
                    Text("Approve").font(Typo.body.weight(.semibold)).foregroundStyle(Theme.onText)
                        .frame(maxWidth: .infinity, minHeight: 46)
                        .background(Theme.text, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .accessibilityIdentifier("ok-approve")
            }
        }
        .padding(Space.l)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(alignment: .leading) { UnevenRoundedRectangle(cornerRadii: .init(topLeading: 16, bottomLeading: 16), style: .continuous).fill(Theme.warn).frame(width: 4) }
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).stroke(Theme.line))
        // More waiting under it: the edges of the next cards, like a stack.
        .background(alignment: .bottom) {
            if of > 1 {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous).stroke(Theme.line).padding(.horizontal, Space.m).frame(height: 30).offset(y: 8)
            }
        }
        .padding(.bottom, of > 1 ? Space.s : 0)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ok-card")
    }
}

/// Another OK your assistant asked for, as a row: its title, where, and Approve.
private struct OKRow: View {
    @EnvironmentObject var state: AppState
    let a: Approval
    let boardTitle: String?
    var body: some View {
        NeedRow(edge: Theme.warn, title: a.title, sub: boardTitle.map { String(localized: "Needs your OK · \($0)", bundle: .l10n) } ?? String(localized: "Needs your OK", bundle: .l10n)) {
            Button { Task { await state.decide(a, approve: true) } } label: {
                Text("Approve").font(Typo.secondary.weight(.semibold)).foregroundStyle(Theme.onText)
                    .padding(.horizontal, Space.m).frame(minHeight: 34)
                    .background(Theme.text, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            }
            .buttonStyle(PressStyle())
            .accessibilityIdentifier("ok-row-approve")
        }
        .accessibilityIdentifier("ok-row")
    }
}

/// One thing that needs you, in the stack: a coloured edge for its kind, what it is, who and where, and its buttons.
private struct NeedRow<Buttons: View>: View {
    let edge: Color
    let title: String
    let sub: String
    @ViewBuilder let buttons: Buttons

    var body: some View {
        HStack(spacing: Space.m) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Typo.body.weight(.semibold)).foregroundStyle(Theme.text).lineLimit(2)
                Text(sub).font(Typo.secondary).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: Space.s)
            HStack(spacing: Space.s) { buttons }
        }
        .padding(.horizontal, Space.l).padding(.vertical, Space.m)
        .overlay(alignment: .leading) { Rectangle().fill(edge).frame(width: 3).padding(.vertical, Space.m) }
        .accessibilityElement(children: .contain)
    }
}

extension AppState {
    /// Marks these inbox items read (only these), here and on the server.
    func markRead(ids: [Int]) async {
        let now = Date().timeIntervalSince1970 * 1000
        withAnimation(.smooth) { inbox = inbox.map { ids.contains($0.id) && $0.readAt == nil ? $0.read(at: now) : $0 } }
        Task { await Notifier.shared.badge(needsYou) }
        do { try await API.shared.send("/api/inbox/read", body: ["ids": ids]) } catch { report(error, quiet: true) }
    }
}
