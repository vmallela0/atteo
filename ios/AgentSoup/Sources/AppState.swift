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
    @Published var tasks: [String: [WorkTask]] = [:] // per board
    @Published var reactions: [String: [Int: [Reaction]]] = [:] // per board, per message
    @Published var boardAgents: [String: [BoardAgent]] = [:] // per board: who's here, live / idle / gone
    @Published var me: MeAgentResponse.Agent?
    @Published var profile: Profile?
    @Published var connections: [Connection] = []
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
        var tasks: [String: [WorkTask]]? = nil
    }
    private static let cacheURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("agent-soup-v1.json")
    private var saveTask: Task<Void, Never>?

    private func restore() {
        guard let d = try? Data(contentsOf: Self.cacheURL), let s = try? JSONDecoder().decode(Snapshot.self, from: d) else { return }
        inbox = s.inbox; approvals = s.approvals; contacts = s.contacts; sessions = s.sessions; boards = s.boards; entries = s.entries; me = s.me; tasks = s.tasks ?? [:]
    }

    private func save() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard let self, !Task.isCancelled else { return }
            let trimmed = self.entries.mapValues { Array($0.filter { $0.pending != true }.suffix(60)) }
            let snap = Snapshot(inbox: self.inbox, approvals: self.approvals, contacts: self.contacts, sessions: self.sessions, boards: self.boards, entries: trimmed, me: self.me, tasks: self.tasks)
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
            let after = max(0, count - 80)
            let r = try await API.shared.get("/api/boards/\(b.id)/entries?after=\(after)&limit=200", as: EntriesResponse.self)
            var got = r.entries
            let rx = Dictionary(uniqueKeysWithValues: (r.reactions ?? [:]).compactMap { k, v in Int(k).map { ($0, v) } })
            if rx != reactions[b.id] { withAnimation(.smooth) { reactions[b.id] = rx } }
            if b.encrypted == true {
                // End-to-end encrypted: the server only has ciphertext; this phone decrypts what it holds the key for.
                let plain = await BoardCrypto.shared.decrypt(b.id, after: after)
                got = got.map { e in
                    var e = e
                    if let t = plain[e.seq] { e.text = t } else if e.text.hasPrefix("🔒 Encrypted message") { e.text = "🔒 Encrypted. This phone can't read it yet." }
                    return e
                }
            }
            let mine = (entries[b.id] ?? []).filter { $0.pending == true || $0.failed == true }
            let fresh = got + mine.filter { m in !r.entries.contains { $0.author == m.author && $0.text == m.text && $0.ts >= m.ts - 60_000 } }
            if fresh != entries[b.id] { withAnimation(.smooth) { entries[b.id] = fresh } }
            save()
        } catch { report(error, quiet: true) }
    }

    /// Which agents are on a board and whether each is working right now.
    func loadAgents(_ b: Board) async {
        do {
            let r = try await API.shared.get("/api/boards/\(b.id)/agents", as: BoardAgentsResponse.self)
            if r.agents != boardAgents[b.id] { withAnimation(.smooth) { boardAgents[b.id] = r.agents } }
        } catch { report(error, quiet: true) }
    }

    /// A board's tasks (the work strip and the task list).
    func loadTasks(_ b: Board) async {
        do {
            let r = try await API.shared.get("/api/boards/\(b.id)/tasks", as: TasksResponse.self)
            if r.tasks != tasks[b.id] { withAnimation(.smooth) { tasks[b.id] = r.tasks } }
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

    // MARK: - Settings

    func loadSettings() async {
        do {
            async let p = API.shared.get("/api/me/profile", as: ProfileResponse.self)
            async let c = API.shared.get("/api/tokens", as: ConnectionsResponse.self)
            let (pp, cc) = try await (p, c)
            withAnimation(.smooth) { profile = pp.profile; connections = cc.tokens.filter { $0.revokedAt == nil && ($0.expiresAt ?? .infinity) > Date().timeIntervalSince1970 * 1000 } }
        } catch { report(error, quiet: true) }
    }

    func saveProfile(_ p: Profile) async {
        let old = profile
        profile = p
        let rules: [String: Any] = ["auto_accept_invites": p.rules.autoAcceptInvites ?? NSNull(), "auto_accept_friends": p.rules.autoAcceptFriends ?? NSNull(), "auto_accept_agents": p.rules.autoAcceptAgents ?? NSNull()]
        do {
            let d = try await API.shared.send("/api/me/profile", body: ["display_name": p.displayName ?? "", "bio": p.bio ?? "", "listed": p.listed, "rules": rules])
            if let r = try? JSONDecoder.soup.decode(ProfileResponse.self, from: d) { profile = r.profile }
        } catch { profile = old; report(error) }
    }

    func saveAgent(summary: String?, listed: Bool?) async {
        var body: [String: Any] = [:]
        if let summary { body["summary"] = summary }
        if let listed { body["listed"] = listed }
        do {
            let d = try await API.shared.send("/api/agents/me", body: body)
            if let r = try? JSONDecoder.soup.decode(MeAgentResponse.self, from: d) { withAnimation(.smooth) { me = r.agent } }
            save()
        } catch { report(error) }
    }

    /// A new picture for you or your agent (already a small square JPEG); every avatar of that name reloads.
    func setAvatar(_ jpeg: Data?, agent: Bool) async {
        do {
            let path = "/api/me/avatar?kind=\(agent ? "agent" : "person")"
            if let jpeg { try await API.shared.upload(path, data: jpeg, contentType: "image/jpeg") } else { try await API.shared.send(path, method: "DELETE", body: nil) }
            if let mine = me?.owner { AvatarCache.shared.bump(mine, agent: agent) }
            Haptic.done()
        } catch { report(error) }
    }

    func revoke(_ c: Connection) async {
        withAnimation(.smooth) { connections.removeAll { $0.id == c.id } }
        do { try await API.shared.send("/api/tokens/\(c.id)/revoke", retries: false) } catch { report(error); await loadSettings() }
    }

    /// While a chat is open: its live socket, so checklists tick and messages land the moment they change.
    /// Runs until the chat closes (the caller's task is cancelled); reconnects after a dropped connection.
    func watch(_ b: Board) async {
        struct Event: Decodable { let type: String }
        var backoff: UInt64 = 1
        while !Task.isCancelled {
            guard let ws = API.shared.socket(board: b.id) else { return }
            ws.resume()
            var pending: Task<Void, Never>?
            do {
                // Leaving the chat cancels this task; closing the socket ends the receive that's waiting on it.
                try await withTaskCancellationHandler {
                while !Task.isCancelled {
                    let msg = try await ws.receive()
                    backoff = 1
                    guard case .string(let s) = msg, let e = try? JSONDecoder().decode(Event.self, from: Data(s.utf8)) else { continue }
                    guard e.type == "task" || e.type == "entry" || e.type == "reaction" else { continue }
                    // Bursts (a done that ticks a parent and posts a line) refresh once.
                    pending?.cancel()
                    pending = Task { [weak self] in
                        try? await Task.sleep(nanoseconds: 150_000_000)
                        guard let self, !Task.isCancelled else { return }
                        async let t: Void = self.loadTasks(b)
                        async let n: Void = e.type == "entry" || e.type == "reaction" ? self.loadEntries(b) : ()
                        _ = await (t, n)
                    }
                }
                } onCancel: { ws.cancel(with: .goingAway, reason: nil) }
            } catch {}
            ws.cancel(with: .goingAway, reason: nil)
            if Task.isCancelled { return }
            try? await Task.sleep(nanoseconds: backoff * 1_000_000_000)
            backoff = min(backoff * 2, 30)
        }
    }

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
            var real: Entry
            if b.encrypted == true {
                // Encrypted here; the server stores and relays only the ciphertext.
                let payload = try await BoardCrypto.shared.seal(text, board: b.id)
                let data = try await API.shared.send("/api/boards/\(b.id)/sealed", body: ["type": "note", "payload": payload])
                real = try JSONDecoder.soup.decode(PostResponse.self, from: data).entry
                real.text = text
            } else {
                let data = try await API.shared.send("/api/boards/\(b.id)/entries", body: ["type": "note", "text": text])
                real = try JSONDecoder.soup.decode(PostResponse.self, from: data).entry
            }
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
        BoardCrypto.shared.forget()
        Keychain.token = nil
        try? FileManager.default.removeItem(at: Self.cacheURL)
        withAnimation(.smooth) {
            signedIn = false; loaded = false
            inbox = []; approvals = []; contacts = []; sessions = []; boards = []; entries = [:]; tasks = [:]; me = nil; feedCursor = nil
        }
    }

    /// Background refreshes fail quietly (the cache stays on screen); things you did say what went wrong.
    func report(_ e: Error, quiet: Bool = false) {
        if case APIError.signedOut = e { signOut(); return }
        if quiet, case APIError.offline = e { return }
        error = e.localizedDescription
    }
}
