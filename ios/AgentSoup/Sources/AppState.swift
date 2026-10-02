// Everything the app shows, kept here and on disk: the app opens on what you saw last (instantly), then refreshes in
// the background. Messages you send appear at once and are confirmed (or retried) behind the scenes.

import Foundation
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()

    @Published var signedIn = Keychain.token != nil
    @Published var loaded = false // the first refresh has come back (before that, the cache or placeholders show)
    @Published var inbox: [InboxItem] = []
    @Published var approvals: [Approval] = []
    @Published var contacts: [ContactsResponse.Incoming] = []
    @Published var sessions: [AgentSession] = []
    @Published var boards: [Board] = []
    @Published var entries: [String: [Entry]] = [:] // per board, newest last
    @Published var me: MeAgentResponse.Agent?
    @Published var error: String?
    /// Bumped whenever something new lands anywhere (the live feed), with the board it landed on.
    @Published var pulse: Pulse?
    struct Pulse: Equatable { let board: String; let at: Date }
    private var feedCursor: Int?
    private var feedTask: Task<Void, Never>?

    /// Things waiting for you: approvals, first-contact requests, unread messages for you.
    var needsYou: Int { approvals.count + contacts.count + inbox.filter { $0.readAt == nil && !$0.boardId.isEmpty }.count }

    init() {
        #if DEBUG
        // Simulator runs against a local server: AGENT_SOUP_TOKEN skips the browser sign-in.
        if let t = ProcessInfo.processInfo.environment["AGENT_SOUP_TOKEN"], !t.isEmpty { Keychain.token = t; signedIn = true }
        if ProcessInfo.processInfo.environment["AGENT_SOUP_FRESH"] != nil { try? FileManager.default.removeItem(at: Self.cacheURL) }
        #endif
        if signedIn { restore() }
    }

    // MARK: - Cache (the last thing you saw, so launch is instant)

    private struct Snapshot: Codable {
        var inbox: [InboxItem]; var approvals: [Approval]; var contacts: [ContactsResponse.Incoming]
        var sessions: [AgentSession]; var boards: [Board]; var entries: [String: [Entry]]; var me: MeAgentResponse.Agent?
    }
    private static let cacheURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("agent-soup-v1.json")
    private var saveTask: Task<Void, Never>?

    private func restore() {
        guard let d = try? Data(contentsOf: Self.cacheURL), let s = try? JSONDecoder().decode(Snapshot.self, from: d) else { return }
        inbox = s.inbox; approvals = s.approvals; contacts = s.contacts; sessions = s.sessions; boards = s.boards; entries = s.entries; me = s.me
    }

    private func save() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard let self, !Task.isCancelled else { return }
            let trimmed = self.entries.mapValues { Array($0.filter { $0.pending != true }.suffix(60)) }
            let snap = Snapshot(inbox: self.inbox, approvals: self.approvals, contacts: self.contacts, sessions: self.sessions, boards: self.boards, entries: trimmed, me: self.me)
            if let d = try? JSONEncoder().encode(snap) { try? d.write(to: Self.cacheURL, options: .atomic) }
        }
    }

    // MARK: - Refresh

    func refreshAll() async {
        async let a: Void = refreshInbox()
        async let b: Void = refreshAgents()
        async let c: Void = refreshBoards()
        _ = await (a, b, c)
        withAnimation(.smooth) { loaded = true }
        startFeed()
    }

    func refreshInbox() async {
        do {
            async let i = API.shared.get("/api/inbox", as: InboxResponse.self)
            async let ap = API.shared.get("/api/approvals", as: ApprovalsResponse.self)
            async let co = API.shared.get("/api/contacts", as: ContactsResponse.self)
            let (ii, aa, cc) = try await (i, ap, co)
            withAnimation(.smooth) { inbox = ii.items; approvals = aa.approvals; contacts = cc.incoming }
            save()
        } catch { report(error, quiet: true) }
    }

    func refreshAgents() async {
        do {
            async let s = API.shared.get("/api/sessions", as: SessionsResponse.self)
            async let m = API.shared.get("/api/agents/me", as: MeAgentResponse.self)
            let (ss, mm) = try await (s, m)
            withAnimation(.smooth) { sessions = ss.sessions; me = mm.agent }
            save()
        } catch { report(error, quiet: true) }
    }

    func refreshBoards() async {
        do {
            let r = try await API.shared.get("/api/me/boards", as: BoardsResponse.self)
            withAnimation(.smooth) { boards = r.boards.sorted { $0.lastActivity > $1.lastActivity } }
            save()
        } catch { report(error, quiet: true) }
    }

    /// A board's latest messages (keeps any of yours still sending at the end).
    func loadEntries(_ b: Board) async {
        let count = boards.first(where: { $0.id == b.id })?.entryCount ?? b.entryCount
        do {
            let r = try await API.shared.get("/api/boards/\(b.id)/entries?after=\(max(0, count - 80))&limit=200", as: EntriesResponse.self)
            let mine = (entries[b.id] ?? []).filter { $0.pending == true || $0.failed == true }
            let fresh = r.entries + mine.filter { m in !r.entries.contains { $0.author == m.author && $0.text == m.text && $0.ts >= m.ts - 60_000 } }
            if fresh != entries[b.id] { withAnimation(.smooth) { entries[b.id] = fresh } }
            save()
        } catch { report(error, quiet: true) }
    }

    /// Live: a long poll on everything you're in; anything new refreshes what it touches.
    func startFeed() {
        guard feedTask == nil else { return }
        feedTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let path = self.feedCursor.map { "/api/tape?after=\($0)&wait=25&limit=100" } ?? "/api/tape?limit=1"
                do {
                    let first = self.feedCursor == nil
                    let r = try await API.shared.get(path, as: TapeResponse.self, timeout: 35)
                    self.feedCursor = r.cursor
                    if !first, let last = r.lines.last {
                        self.pulse = Pulse(board: last.boardId, at: Date())
                        async let b: Void = self.refreshBoards()
                        async let i: Void = self.refreshInbox()
                        _ = await (b, i)
                    }
                } catch {
                    if case APIError.signedOut = error { return }
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                }
            }
        }
    }

    func stopFeed() { feedTask?.cancel(); feedTask = nil }

    // MARK: - Actions (optimistic: the screen changes first)

    /// Sends a message: it shows at once (sending…), then becomes the real entry, or "not sent, tap to retry".
    func send(_ text: String, to b: Board, retrying old: Entry? = nil) async {
        let mine = self.me?.owner ?? ""
        let temp = old ?? Entry(seq: -Int(Date().timeIntervalSince1970 * 1000), ts: Date().timeIntervalSince1970 * 1000, author: mine, type: "note", text: text, title: nil, to: nil, via: "person", artifactName: nil, pending: true)
        withAnimation(.smooth) {
            var list = entries[b.id] ?? []
            list.removeAll { $0.seq == temp.seq }
            var t = temp; t.pending = true; t.failed = nil
            list.append(t)
            entries[b.id] = list
        }
        do {
            let data = try await API.shared.send("/api/boards/\(b.id)/entries", body: ["type": "note", "text": text])
            let real = try JSONDecoder.soup.decode(PostResponse.self, from: data).entry
            withAnimation(.smooth) { entries[b.id] = (entries[b.id] ?? []).map { $0.seq == temp.seq ? real : $0 } }
            Haptic.done()
            save()
            Task { await refreshBoards() }
        } catch {
            withAnimation(.smooth) {
                entries[b.id] = (entries[b.id] ?? []).map { e in
                    guard e.seq == temp.seq else { return e }
                    var f = e; f.pending = nil; f.failed = true; return f
                }
            }
            Haptic.warn()
        }
    }

    func markRead(_ b: Board) async {
        guard inbox.contains(where: { $0.boardId == b.id && $0.readAt == nil }) else { return }
        let now = Date().timeIntervalSince1970 * 1000
        withAnimation(.smooth) { inbox = inbox.map { $0.boardId == b.id && $0.readAt == nil ? $0.read(at: now) : $0 } }
        save()
        do { try await API.shared.send("/api/inbox/read", body: ["board": b.id]) } catch { report(error, quiet: true) }
    }

    func decide(_ a: Approval, approve: Bool) async {
        withAnimation(.smooth) { approvals.removeAll { $0.id == a.id } }
        save()
        do { try await API.shared.send("/api/approvals/\(a.id)/\(approve ? "approve" : "reject")", body: ["note": ""]) } catch { report(error); await refreshInbox() }
    }

    func answer(_ c: ContactsResponse.Incoming, accept: Bool) async {
        withAnimation(.smooth) { contacts.removeAll { $0.from == c.from } }
        save()
        do {
            try await API.shared.send("/api/contacts/\(c.from)/\(accept ? "accept" : "decline")")
            if accept { await refreshBoards() }
        } catch { report(error); await refreshInbox() }
    }

    func setScope(_ s: AgentSession, readOnly: Bool) async {
        withAnimation(.smooth) { sessions = sessions.map { $0.id == s.id ? AgentSession(id: s.id, name: s.name, client: s.client, scope: readOnly ? "read" : "full", status: s.status, lastSeen: s.lastSeen, active: s.active) : $0 } }
        do { try await API.shared.send("/api/sessions/\(s.id)", body: ["scope": readOnly ? "read" : "full"]) } catch { report(error); await refreshAgents() }
    }

    func disconnectAll() async {
        do { try await API.shared.send("/api/tokens/revoke-all", retries: false) } catch { report(error) }
        signOut() // the switch revokes every token, this phone's included
    }

    func signOut() {
        stopFeed()
        Keychain.token = nil
        try? FileManager.default.removeItem(at: Self.cacheURL)
        withAnimation(.smooth) {
            signedIn = false; loaded = false
            inbox = []; approvals = []; contacts = []; sessions = []; boards = []; entries = [:]; me = nil; feedCursor = nil
        }
    }

    /// Background refreshes fail quietly (the cache stays on screen); things you did say what went wrong.
    func report(_ e: Error, quiet: Bool = false) {
        if case APIError.signedOut = e { signOut(); return }
        if quiet, case APIError.offline = e { return }
        error = e.localizedDescription
    }
}
