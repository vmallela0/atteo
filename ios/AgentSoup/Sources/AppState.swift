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
    @Published var members: [String: [String]] = [:] // per board: who's in it (for @-mentions)
    @Published var agentNames: [String: [String: AgentName]] = [:] // per board, per member: what they named their agent
    var displayNames: [String: [String: String]] = [:] // per board, per member: their display name (dictation's hints)
    struct AgentName: Equatable { let name: String; let ambiguous: Bool }
    // Chat parity, wave 2: read receipts, who took what, and how far back each chat is loaded.
    @Published var reads: [String: [String: SeenMark]] = [:] // per board, per member: how far they've seen
    @Published var handling: [String: [Int: Handling]] = [:] // per board, per message: who's on it ("On it")
    @Published var loadingEarlier: Set<String> = [] // boards loading older messages right now
    private var seenSent: [String: Int] = [:] // per board: the last "seen up to" this phone reported
    // Who's typing (Typing.swift).
    @Published var typing: [String: [String: Double]] = [:] // per board, per person: typing until (ms epoch)
    var typingSent: [String: Date] = [:] // per board: when this phone last said you're typing
    @Published var agentSessions: [AgentChatSession] = [] // "Your agent": the sessions you can send to (AgentChat.swift)
    @Published var decisions: [String: [Int: HumanDecision]] = [:] // per board, per message: human decisions (HumanDecisions.swift)
    @Published var jumpRequest: JumpRequest? // a message to show once its chat opens (a search hit in Chats)
    @Published var openRequest: Board? // a chat to open from anywhere (Message on someone's card)
    struct JumpRequest: Equatable { let board: String; let seq: Int }
    @Published var me: MeAgentResponse.Agent?
    @Published var profile: Profile?
    /// Text size, density, theme and language (Settings → Display). Cached on the phone so launch is instant; saved per
    /// person on the server so the web follows them too (and the app follows the web).
    @Published private(set) var display: DisplayPrefs = AppState.cachedDisplay {
        didSet { if display.lang != oldValue.lang { L10n.apply(display.lang) } } // the app's words (Language.swift)
    }
    private var displaySave: Task<Void, Never>?
    @Published var connections: [Connection] = []
    @Published var error: String?
    /// A short line that something worked ("Remembered"), shown for a moment at the top (BoardContext.swift).
    @Published var toast: String?
    /// Bumped whenever something new lands anywhere (the live feed), with the board it landed on.
    @Published var pulse: Pulse?
    struct Pulse: Equatable { let board: String; let at: Date }
    private var feedCursor: Int?
    private var feedTask: Task<Void, Never>?

    /// Things waiting for you: approvals, first-contact requests, unread messages for you.
    var needsYou: Int { approvals.count + contacts.count + inbox.filter { $0.readAt == nil && !$0.boardId.isEmpty }.count }

    init() {
        L10n.apply(display.lang) // before the first screen draws: its words in your language
        #if DEBUG
        // Simulator runs against a local server: ATTEO_TOKEN skips the browser sign-in.
        if let t = API.environment("TOKEN"), !t.isEmpty { Keychain.token = t; signedIn = true }
        if API.environment("FRESH") != nil { try? FileManager.default.removeItem(at: Self.cacheURL) }
        // Simulator screenshots of the sign-in screen (the token stays where it is).
        if API.environment("SIGNED_OUT") != nil { signedIn = false }
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
        AppMode.shared.note(sessions: s.sessions, fromServer: false) // Everyday or Developer (Everyday.swift)
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
            async let i = API.shared.get(Notifier.inboxPath, as: InboxResponse.self)
            async let ap = API.shared.get("/api/approvals", as: ApprovalsResponse.self)
            async let co = API.shared.get("/api/contacts", as: ContactsResponse.self)
            let (ii, aa, cc) = try await (i, ap, co)
            withAnimation(.smooth) { inbox = ii.items; approvals = aa.approvals; contacts = cc.incoming }
            save()
            // On screen: note what's here (no notifications), and keep the app icon's number right.
            await Notifier.shared.check(inbox: ii.items, approvals: aa.approvals, notify: false, summary: ii.notify)
            await Notifier.shared.badge(needsYou)
        } catch { report(error, quiet: true) }
    }

    func refreshAgents() async {
        do {
            async let s = API.shared.get("/api/sessions", as: SessionsResponse.self)
            async let m = API.shared.get("/api/agents/me", as: MeAgentResponse.self)
            async let p = try? API.shared.get("/api/me/profile", as: ProfileResponse.self)
            let (ss, mm) = try await (s, m)
            withAnimation(.smooth) { sessions = ss.sessions; me = mm.agent }
            AppMode.shared.note(sessions: ss.sessions, fromServer: true) // a coding agent turns Developer mode on (Everyday.swift)
            if let pp = await p { profile = pp.profile; adoptDisplay(pp.profile.display) }
            save()
        } catch { report(error, quiet: true) }
    }

    // MARK: - Display settings

    private static let displayKey = "display-prefs", displayDirtyKey = "display-prefs-unsaved"

    private static var cachedDisplay: DisplayPrefs {
        #if DEBUG
        // Simulator screenshots: ATTEO_DISPLAY=l,compact,light pins the settings for the run.
        if let s = API.environment("DISPLAY"), let d = DisplayPrefs(spec: s) { return d }
        #endif
        guard let d = UserDefaults.standard.data(forKey: displayKey), let p = try? JSONDecoder().decode(DisplayPrefs.self, from: d) else { return .default }
        return p
    }

    private var displayPinned: Bool {
        #if DEBUG
        return API.environment("DISPLAY") != nil
        #else
        return false
        #endif
    }

    private func cacheDisplay(_ d: DisplayPrefs, unsaved: Bool) {
        if let data = try? JSONEncoder().encode(d) { UserDefaults.standard.set(data, forKey: Self.displayKey) }
        UserDefaults.standard.set(unsaved, forKey: Self.displayDirtyKey)
    }

    /// A change from Settings: applies at once, is cached, and is saved to your profile a moment later (taps in a
    /// row make one save). Until the server has it, a refresh doesn't undo it.
    func setDisplay(_ d: DisplayPrefs) {
        guard d != display else { return }
        withAnimation(.smooth) { display = d }
        guard !displayPinned else { return }
        cacheDisplay(d, unsaved: true)
        displaySave?.cancel()
        displaySave = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            await self?.saveDisplay()
        }
    }

    /// Sends the cached display settings to your client prefs (POST /api/app/prefs, a partial `display`; the web reads
    /// the same ones).
    private func saveDisplay() async {
        let d = display
        do {
            do {
                try await API.shared.send("/api/app/prefs", body: ["display": d.body(replies: !repliesRefused, turns: !turnsRefused)])
            } catch APIError.server(let m) where (!repliesRefused && m.contains("\"replies\"")) || (!turnsRefused && m.contains("\"voice_turns\"")) {
                // A server from before replies could stay in their threads (vedu #2360), or before When Atteo answers
                // (#2460): the rest saves, and that one stays on this phone.
                if m.contains("\"replies\"") { repliesRefused = true } else { turnsRefused = true }
                try await API.shared.send("/api/app/prefs", body: ["display": d.body(replies: !repliesRefused, turns: !turnsRefused)])
            }
            profile?.display = d
            if display == d { cacheDisplay(d, unsaved: false) }
        } catch { report(error, quiet: true) } // stays cached and unsaved: the next refresh sends it again
    }
    /// The server said no to `replies` (it's older than the setting): saves leave it out until it sends one back.
    private var repliesRefused = false
    /// The same for `voice_turns` (vedu #2460).
    private var turnsRefused = false

    /// What the server has (set here or on the web). A change made on this phone that hasn't reached the server yet
    /// wins and is sent again instead.
    private func adoptDisplay(_ server: DisplayPrefs?) {
        guard !displayPinned, var server else { return }
        if server.repliesKnown { repliesRefused = false } else { server.replies = display.replies } // not kept there yet: the phone's choice stands
        if server.voiceTurnsKnown { turnsRefused = false } else { server.voiceTurns = display.voiceTurns; turnsRefused = true }
        if UserDefaults.standard.bool(forKey: Self.displayDirtyKey) {
            if server == display { cacheDisplay(display, unsaved: false) } else {
                displaySave?.cancel()
                displaySave = Task { [weak self] in await self?.saveDisplay() }
            }
            return
        }
        if server != display { withAnimation(.smooth) { display = server } }
        cacheDisplay(server, unsaved: false)
    }

    func refreshBoards() async {
        do {
            let r = try await API.shared.get("/api/me/boards", as: BoardsResponse.self)
            // A picture changing right now keeps showing what it's changing to (BoardPicture.swift).
            let list = r.boards.map(BoardPictureStore.shared.applyPending)
            withAnimation(.smooth) { boards = list.sorted { $0.lastActivity > $1.lastActivity } }
            save()
        } catch { report(error, quiet: true) }
    }

    /// A board's latest messages (keeps any of yours still sending at the end).
    func loadEntries(_ b: Board) async {
        let count = boards.first(where: { $0.id == b.id })?.entryCount ?? b.entryCount
        do {
            let after = max(0, count - 80)
            let r = try await API.shared.get("/api/boards/\(b.id)/entries?after=\(after)&limit=200", as: EntriesResponse.self)
            let got = await decrypted(r.entries, board: b, after: after)
            // Older messages already loaded ("load earlier", a jump to a reply's parent) stay; their reactions too.
            let older = (entries[b.id] ?? []).filter { $0.seq > 0 && $0.seq <= after && $0.pending != true && $0.failed != true }
            var rx = (reactions[b.id] ?? [:]).filter { $0.key <= after }
            for (k, v) in r.reactions ?? [:] { if let n = Int(k) { rx[n] = v } }
            if rx != reactions[b.id] { withAnimation(.smooth) { reactions[b.id] = rx } }
            if let rd = r.reads, rd != reads[b.id] { withAnimation(.smooth) { reads[b.id] = rd } }
            adoptDecisions(b.id, entries: r.entries, map: r.decisions)
            let mine = (entries[b.id] ?? []).filter { $0.pending == true || $0.failed == true }
            let fresh = older + got + mine.filter { m in !r.entries.contains { $0.author == m.author && $0.text == m.text && $0.ts >= m.ts - 60_000 } }
            if fresh != entries[b.id] {
                // A chat's first load (nothing on this phone yet) goes in at once: animating 80 messages sliding in is a
                // lot of work at once and fights the chat's pin to its newest message. New messages after that
                // still slide in.
                if (entries[b.id] ?? []).isEmpty { entries[b.id] = fresh } else { withAnimation(.smooth) { entries[b.id] = fresh } }
            }
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

    /// Who's in a board (what @ suggests in the message box).
    func loadMembers(_ b: Board) async {
        do {
            let r = try await API.shared.get("/api/boards/\(b.id)/members", as: MembersResponse.self)
            let names = r.members.map(\.user)
            if names != members[b.id] { members[b.id] = names }
            // What members named their agents (#1125): "Jarvis · vedu's agent", and "@Jarvis" in the @ menu.
            var named: [String: AgentName] = [:]
            for m in r.members { if let n = m.agentName, !n.isEmpty { named[m.user] = AgentName(name: n, ambiguous: m.agentNameAmbiguous == true) } }
            if named != agentNames[b.id] { agentNames[b.id] = named }
            displayNames[b.id] = Dictionary(r.members.compactMap { m in m.displayName.flatMap { $0.isEmpty ? nil : (m.user, $0) } }, uniquingKeysWith: { a, _ in a })
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
            adoptDisplay(pp.profile.display)
            withAnimation(.smooth) { profile = pp.profile; connections = cc.tokens.filter { $0.revokedAt == nil && ($0.expiresAt ?? .infinity) > Date().timeIntervalSince1970 * 1000 } }
        } catch { report(error, quiet: true) }
    }

    func saveProfile(_ p: Profile) async {
        let old = profile
        profile = p
        let rules: [String: Any] = ["auto_accept_invites": p.rules.autoAcceptInvites ?? NSNull(), "auto_accept_friends": p.rules.autoAcceptFriends ?? NSNull(), "auto_accept_agents": p.rules.autoAcceptAgents ?? NSNull()]
        var body: [String: Any] = ["display_name": p.displayName ?? "", "bio": p.bio ?? "", "listed": p.listed, "rules": rules]
        // Always the phone's current display settings (replies too, once the server has shown it keeps them).
        if !displayPinned { body["display"] = display.body(replies: old?.display?.repliesKnown == true && !repliesRefused, turns: old?.display?.voiceTurnsKnown == true && !turnsRefused) }
        do {
            let d = try await API.shared.send("/api/me/profile", body: body)
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
            Haptics.play(.completed)
        } catch { report(error) }
    }

    func revoke(_ c: Connection) async {
        withAnimation(.smooth) { connections.removeAll { $0.id == c.id } }
        do { try await API.shared.send("/api/tokens/\(c.id)/revoke", retries: false) } catch { report(error); await loadSettings() }
    }

    /// While a chat is open: its live socket, so checklists tick and messages land the moment they change.
    /// Runs until the chat closes (the caller's task is cancelled); reconnects after a dropped connection.
    func watch(_ b: Board) async {
        struct Event: Decodable {
            let type: String; var user: String?; var personSeen: Int?; var agentSeen: Int?; var seq: Int?; var by: String?; var done: Bool?
            var who: String?; var until: Double?; var author: String?; var via: String? // typing; an entry's author
            var humanDecision: HumanDecision? // a human decision's new state
        }
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
                    guard case .string(let s) = msg, let e = try? JSONDecoder.soup.decode(Event.self, from: Data(s.utf8)) else { continue }
                    // Read receipts and "on it" markers carry everything they change: no refetch.
                    if e.type == "read", let u = e.user, let p = e.personSeen, let a = e.agentSeen {
                        withAnimation(.smooth) { reads[b.id, default: [:]][u] = SeenMark(personSeen: p, agentSeen: a) }
                        continue
                    }
                    if e.type == "handling", let n = e.seq {
                        withAnimation(.smooth) { handling[b.id, default: [:]][n] = e.by.map { Handling(by: $0, user: nil, done: e.done) } }
                        continue
                    }
                    // "jxn is typing…" (people only; never you), until their message lands or it runs out.
                    if e.type == "typing", let who = e.who, let until = e.until {
                        if who != me?.owner { heardTyping(who, until: until, on: b.id) }
                        continue
                    }
                    // A member renamed their agent (#1125): how their agent shows here, and "@Jarvis" in the @ menu.
                    if e.type == "profile" {
                        Task { [weak self] in await self?.loadMembers(b); await self?.loadAgents(b); await self?.loadEntries(b) }
                        continue
                    }
                    if e.type == "decision", let n = e.seq, let hd = e.humanDecision {
                        withAnimation(.smooth) { decisions[b.id, default: [:]][n] = hd }
                        continue
                    }
                    if e.type == "entry", let a = e.author, e.via != "agent", typing[b.id]?[a] != nil {
                        withAnimation(.smooth(duration: 0.25)) { typing[b.id]?[a] = nil } // sent: no longer typing
                    }
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
    /// `toSession`: on "Your agent", one of your sessions by name (nil: any of your agents).
    /// `type`: what a slash command makes it (SlashCommands.swift): note, task, decision or question.
    /// `audience` (the composer's lock, #1748/#1749): "own" (Just mine: you and your agents) or "people" (People only:
    /// `toPeople` and you, no agent). Kept on the message as it shows, so a retry sends it the same way.
    func send(_ text: String, to b: Board, replyTo: Int? = nil, retrying old: Entry? = nil, toSession: String? = nil, type: String = "note",
              audience: String? = nil, toPeople: [String]? = nil) async {
        let mine = self.me?.owner ?? ""
        let temp = old ?? Entry(seq: -Int(Date().timeIntervalSince1970 * 1000), ts: Date().timeIntervalSince1970 * 1000, author: mine, type: type, text: text, title: nil, to: nil, via: "person", artifactName: nil, pending: true, replyTo: replyTo,
                                audience: audience, toPeople: audience == "people" ? toPeople ?? [] : nil)
        var reply: [String: Any] = temp.replyTo.map { ["reply_to": $0] } ?? [:]
        if let toSession { reply["to_session"] = toSession }
        if temp.audience == "own" { reply["own"] = true }
        else if temp.audience == "people" { reply["people_only"] = true; reply["to"] = temp.toPeople ?? [] }
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
                let data = try await API.shared.send("/api/boards/\(b.id)/sealed", body: (["type": temp.type, "payload": payload] as [String: Any]).merging(reply) { a, _ in a })
                real = try JSONDecoder.soup.decode(PostResponse.self, from: data).entry
                real.text = text
            } else {
                let data = try await API.shared.send("/api/boards/\(b.id)/entries", body: (["type": temp.type, "text": text] as [String: Any]).merging(reply) { a, _ in a })
                real = try JSONDecoder.soup.decode(PostResponse.self, from: data).entry
            }
            withAnimation(.smooth) { entries[b.id] = (entries[b.id] ?? []).map { $0.seq == temp.seq ? real : $0 } }
            Notifier.shared.askIfSensible() // your first message: you'll want to hear when it's answered
            save()
            Task { await refreshBoards() }
        } catch {
            withAnimation(.smooth) {
                entries[b.id] = (entries[b.id] ?? []).map { e in
                    guard e.seq == temp.seq else { return e }
                    var f = e; f.pending = nil; f.failed = true; return f
                }
            }
            Haptics.play(.failed)
        }
    }

    /// How far each picture or file you're sending has gone up (by its stand-in's seq), 0…1.
    @Published var uploads: [Int: Double] = [:]
    private static let outbox = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("outbox", isDirectory: true)

    /// Sends pictures and files the way the web composer does: one upload each, in order, what you typed going with
    /// the first. Each shows at once (its own preview, a ring as it goes up), then becomes the real entry, or
    /// "not sent, tap to retry" if the connection dropped. What the server won't take (too large, a secret) says why.
    func send(files: [Attachment], caption: String, to b: Board, replyTo: Int? = nil) async {
        let mine = self.me?.owner ?? ""
        let now = Date().timeIntervalSince1970 * 1000
        var queue: [(Entry, Data)] = []
        for (i, f) in files.enumerated() {
            // The bytes wait on disk (a retry after a relaunch still has them).
            let dir = Self.outbox.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let file = dir.appendingPathComponent(f.name.replacingOccurrences(of: "/", with: "_"))
            try? f.data.write(to: file)
            let text = i == 0 && !caption.isEmpty ? caption : "Shared \(f.name)"
            let e = Entry(seq: -Int(now) - i, ts: now + Double(i), author: mine, type: "artifact", text: text, title: nil, to: nil, via: "person",
                          artifactName: f.name, pending: true, replyTo: replyTo,
                          media: Media(mime: f.mime, w: f.width, h: f.height, size: f.data.count), artifactSize: f.data.count, local: file.path)
            queue.append((e, f.data))
        }
        // Several: ONE message (the web's multipart upload), its pictures in a grid.
        if queue.count > 1 {
            let first = queue[0].0
            var e = first
            e.text = caption.isEmpty ? Self.sharedLabel(files.map(\.mime)) : caption
            e.attachments = queue.map { q in FileRef(name: q.0.artifactName ?? "file", mime: q.0.media?.mime ?? "application/octet-stream", size: q.1.count, w: q.0.media?.w, h: q.0.media?.h, local: q.0.local) }
            withAnimation(.smooth) { entries[b.id] = (entries[b.id] ?? []) + [e] }
            await uploadMany(e, datas: queue.map(\.1), to: b)
            return
        }
        withAnimation(.smooth) { entries[b.id] = (entries[b.id] ?? []) + queue.map(\.0) }
        for (e, d) in queue { await upload(e, data: d, to: b) }
    }

    /// The server's caption for files sent without words: "Shared 3 images" / "Shared 3 files".
    static func sharedLabel(_ mimes: [String]) -> String { "Shared \(mimes.count) \(mimes.allSatisfy { $0.hasPrefix("image/") } ? "images" : "files")" }

    /// Several files as one message: POST /upload, multipart (a `file` part each, with its w / h / name after it,
    /// in order, so the server pairs them up), plus the words and what it answers.
    private func uploadMany(_ temp: Entry, datas: [Data], to b: Board) async {
        let files = temp.attachments ?? []
        var form = Multipart()
        if temp.text != Self.sharedLabel(files.map(\.mime)) { form.field("text", temp.text) }
        if let r = temp.replyTo { form.field("reply_to", String(r)) }
        for (f, d) in zip(files, datas) {
            form.file("file", filename: f.name, mime: f.mime, data: d)
            form.field("w", f.w.map(String.init) ?? "")
            form.field("h", f.h.map(String.init) ?? "")
            form.field("name", f.name)
        }
        let body = form.finish()
        uploads[temp.seq] = 0
        defer { uploads[temp.seq] = nil }
        do {
            let d = try await API.shared.upload("/api/boards/\(b.id)/upload", data: body, contentType: form.contentType) { p in
                Task { @MainActor in if AppState.shared.uploads[temp.seq] != nil { AppState.shared.uploads[temp.seq] = p } }
            }
            let real = try JSONDecoder.soup.decode(PostResponse.self, from: d).entry
            // Already here: each kept under its real name and version, so none downloads again.
            for (i, a) in (real.attachments ?? []).enumerated() where i < datas.count {
                MediaStore.shared.adopt(datas[i], board: b.id, name: a.name, version: a.version, image: a.isImage)
            }
            for f in files { if let path = f.local { try? FileManager.default.removeItem(at: URL(fileURLWithPath: path).deletingLastPathComponent()) } }
            withAnimation(.smooth) { entries[b.id] = (entries[b.id] ?? []).map { $0.seq == temp.seq ? real : $0 } }
            save()
            Task { await refreshBoards() }
        } catch APIError.offline {
            withAnimation(.smooth) {
                entries[b.id] = (entries[b.id] ?? []).map { e in
                    guard e.seq == temp.seq else { return e }
                    var f = e; f.pending = nil; f.failed = true; return f
                }
            }
            Haptics.play(.failed)
        } catch {
            withAnimation(.smooth) { entries[b.id]?.removeAll { $0.seq == temp.seq } }
            for f in files { if let path = f.local { try? FileManager.default.removeItem(at: URL(fileURLWithPath: path).deletingLastPathComponent()) } }
            Haptics.play(.failed)
            report(error)
        }
    }

    /// Tries a picture or file that didn't go up again.
    func retryUpload(_ e: Entry, in b: Board) async {
        if e.isMultiFile {
            let datas = (e.attachments ?? []).compactMap { $0.local.flatMap { try? Data(contentsOf: URL(fileURLWithPath: $0)) } }
            guard datas.count == e.attachments?.count else { withAnimation(.smooth) { entries[b.id]?.removeAll { $0.seq == e.seq } }; return }
            withAnimation(.smooth) { entries[b.id] = (entries[b.id] ?? []).map { $0.seq == e.seq ? { var x = $0; x.pending = true; x.failed = nil; return x }($0) : $0 } }
            await uploadMany(e, datas: datas, to: b)
            return
        }
        guard let path = e.local, let d = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
            withAnimation(.smooth) { entries[b.id]?.removeAll { $0.seq == e.seq } }
            return
        }
        withAnimation(.smooth) { entries[b.id] = (entries[b.id] ?? []).map { $0.seq == e.seq ? { var x = $0; x.pending = true; x.failed = nil; return x }($0) : $0 } }
        await upload(e, data: d, to: b)
    }

    private func upload(_ temp: Entry, data: Data, to b: Board) async {
        guard let name = temp.artifactName else { return }
        let mime = temp.media?.mime ?? "application/octet-stream"
        var q = "name=\(name.queryEscaped)"
        if let w = temp.media?.w, let h = temp.media?.h { q += "&w=\(w)&h=\(h)" }
        if let r = temp.replyTo { q += "&reply_to=\(r)" }
        if temp.text != "Shared \(name)" { q += "&text=\(temp.text.queryEscaped)" }
        uploads[temp.seq] = 0
        defer { uploads[temp.seq] = nil }
        do {
            let d = try await API.shared.upload("/api/boards/\(b.id)/upload?\(q)", data: data, contentType: mime) { p in
                Task { @MainActor in if AppState.shared.uploads[temp.seq] != nil { AppState.shared.uploads[temp.seq] = p } }
            }
            let real = try JSONDecoder.soup.decode(PostResponse.self, from: d).entry
            // Already here: keep it under its real name and version so it doesn't download again.
            MediaStore.shared.adopt(data, board: b.id, name: real.artifactName ?? name, version: real.artifactVersion, image: real.isImage)
            if let path = temp.local { try? FileManager.default.removeItem(at: URL(fileURLWithPath: path).deletingLastPathComponent()) }
            withAnimation(.smooth) { entries[b.id] = (entries[b.id] ?? []).map { $0.seq == temp.seq ? real : $0 } }
            save()
            Task { await refreshBoards() }
        } catch APIError.offline {
            withAnimation(.smooth) {
                entries[b.id] = (entries[b.id] ?? []).map { e in
                    guard e.seq == temp.seq else { return e }
                    var f = e; f.pending = nil; f.failed = true; return f
                }
            }
            Haptics.play(.failed)
        } catch {
            // The server said no (too large, a secret in it, a read-only board): trying again won't help, so say why.
            withAnimation(.smooth) { entries[b.id]?.removeAll { $0.seq == temp.seq } }
            if let path = temp.local { try? FileManager.default.removeItem(at: URL(fileURLWithPath: path).deletingLastPathComponent()) }
            Haptics.play(.failed)
            report(error)
        }
    }

    // MARK: - Chat parity, wave 2: older messages, reactions, unsend, receipts, "on it"

    /// What this phone can read of an encrypted board's messages (others pass through).
    private func decrypted(_ list: [Entry], board b: Board, after: Int) async -> [Entry] {
        guard b.encrypted == true else { return list }
        // End-to-end encrypted: the server only has ciphertext; this phone decrypts what it holds the key for.
        let plain = await BoardCrypto.shared.decrypt(b.id, after: after)
        return list.map { e in
            var e = e
            if let t = plain[e.seq] { e.text = t } else if e.text.hasPrefix("🔒 Encrypted message") { e.text = String(localized: "🔒 Encrypted. This phone can't read it yet.", bundle: .l10n) }
            return e
        }
    }

    /// The oldest message loaded for a board (nil: none yet).
    func firstLoaded(_ b: Board) -> Int? { (entries[b.id] ?? []).lazy.filter { $0.seq > 0 }.map(\.seq).min() }

    /// Older messages, put in front of what's loaded: a page of 60, or back to `through` (a reply's parent, a search
    /// hit) in one go (at most 500). Returns false when there's nothing older.
    @discardableResult
    func loadEarlier(_ b: Board, through target: Int? = nil) async -> Bool {
        guard let first = firstLoaded(b), first > 1, !loadingEarlier.contains(b.id) else { return false }
        loadingEarlier.insert(b.id)
        defer { loadingEarlier.remove(b.id) }
        var after = max(0, first - 1 - 60)
        if let target { after = max(0, min(after, target - 6), first - 1 - 500) }
        do {
            let r = try await API.shared.get("/api/boards/\(b.id)/entries?after=\(after)&limit=\(first - 1 - after)", as: EntriesResponse.self)
            let got = await decrypted(r.entries.filter { $0.seq < first }, board: b, after: after)
            var rx = reactions[b.id] ?? [:]
            for (k, v) in r.reactions ?? [:] { if let n = Int(k), n < first { rx[n] = v } }
            reactions[b.id] = rx
            adoptDecisions(b.id, entries: r.entries, map: nil)
            let have = Set((entries[b.id] ?? []).map(\.seq))
            entries[b.id] = got.filter { !have.contains($0.seq) } + (entries[b.id] ?? [])
            return after > 0
        } catch { report(error, quiet: true); return false }
    }

    /// Who's on what ("On it"), and everyone's read marks: the board's live view, asked for nothing new.
    func loadHandling(_ b: Board) async {
        let last = max(entries[b.id]?.map(\.seq).max() ?? 0, boards.first(where: { $0.id == b.id })?.entryCount ?? b.entryCount)
        do {
            let r = try await API.shared.get("/api/boards/\(b.id)/updates?after=\(last)", as: UpdatesResponse.self)
            let h = Dictionary(uniqueKeysWithValues: (r.handling ?? [:]).compactMap { k, v in Int(k).map { ($0, v) } })
            if h != handling[b.id] { withAnimation(.smooth) { handling[b.id] = h } }
            if let rd = r.reads, rd != reads[b.id] { withAnimation(.smooth) { reads[b.id] = rd } }
        } catch { report(error, quiet: true) }
    }

    /// Tells the board how far you've read here (others see "Seen by …" under their messages).
    func markSeen(_ b: Board) async {
        guard let last = entries[b.id]?.lazy.filter({ $0.seq > 0 }).map(\.seq).max(), last > (seenSent[b.id] ?? 0) else { return }
        seenSent[b.id] = last
        do { try await API.shared.send("/api/boards/\(b.id)/seen", body: ["seq": last], retries: false) } catch { report(error, quiet: true) }
    }

    /// Adds your reaction, or takes it back if it's there (shows at once; the server's answer settles it).
    func react(_ emoji: String, to seq: Int, in b: Board) async {
        guard let me = me?.owner else { return }
        let old = reactions[b.id]?[seq] ?? []
        var next = old
        if let i = next.firstIndex(where: { $0.emoji == emoji }) {
            var users = next[i].users
            if users.contains(me) { users.removeAll { $0 == me } } else { users.append(me) }
            if users.isEmpty { next.remove(at: i) } else { next[i] = Reaction(emoji: emoji, users: users) }
        } else { next.append(Reaction(emoji: emoji, users: [me])) }
        Haptics.play(.reacted)
        withAnimation(.spring(duration: 0.3, bounce: 0.3)) { reactions[b.id, default: [:]][seq] = next }
        do {
            let d = try await API.shared.send("/api/boards/\(b.id)/entries/\(seq)/react", body: ["emoji": emoji], retries: false)
            let r = try JSONDecoder.soup.decode(ReactResponse.self, from: d)
            withAnimation(.smooth) { reactions[b.id, default: [:]][seq] = r.reactions }
        } catch {
            withAnimation(.smooth) { reactions[b.id, default: [:]][seq] = old }
            report(error)
        }
    }

    /// Unsends one of your messages: it stays in the log, marked "Unsent" (like the web).
    func retract(_ seq: Int, in b: Board) async {
        do {
            let d = try await API.shared.send("/api/boards/\(b.id)/entries/\(seq)/retract", body: [String: Any](), retries: false)
            let r = try JSONDecoder.soup.decode(PostResponse.self, from: d).entry
            withAnimation(.smooth) { if !(entries[b.id] ?? []).contains(where: { $0.seq == r.seq }) { entries[b.id, default: []].append(r) } }
            Haptics.play(.completed)
            save()
        } catch { Haptics.play(.failed); report(error) }
    }

    /// "On it": you take a message addressed to you (people and agents see who has it).
    func takeOn(_ seq: Int, in b: Board) async {
        let me = me?.owner ?? ""
        Haptics.play(.touch)
        withAnimation(.smooth) { handling[b.id, default: [:]][seq] = Handling(by: me, user: me, done: false) }
        do {
            let d = try await API.shared.send("/api/boards/\(b.id)/handle/\(seq)", body: ["action": "take"], retries: false)
            if let r = try? JSONDecoder.soup.decode(HandleResponse.self, from: d), let by = r.by {
                withAnimation(.smooth) { handling[b.id, default: [:]][seq] = Handling(by: by, user: nil, done: r.done) }
            }
        } catch APIError.server {
            await loadHandling(b) // someone else has it (409): their marker shows instead, which says who
        } catch {
            withAnimation(.smooth) { handling[b.id]?[seq] = nil }
            report(error)
        }
    }

    func markRead(_ b: Board) async {
        guard inbox.contains(where: { $0.boardId == b.id && $0.readAt == nil }) else { return }
        let now = Date().timeIntervalSince1970 * 1000
        withAnimation(.smooth) { inbox = inbox.map { $0.boardId == b.id && $0.readAt == nil ? $0.read(at: now) : $0 } }
        save()
        Task { await Notifier.shared.badge(needsYou) }
        do { try await API.shared.send("/api/inbox/read", body: ["board": b.id]) } catch { report(error, quiet: true) }
    }

    func decide(_ a: Approval, approve: Bool) async {
        Haptics.play(approve ? .approved : .denied)
        Notifier.shared.askIfSensible() // you'll want to hear about the next one
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
        // Display settings are the person's: the next one to sign in starts from the defaults (then their own).
        displaySave?.cancel()
        UserDefaults.standard.removeObject(forKey: Self.displayKey)
        UserDefaults.standard.removeObject(forKey: Self.displayDirtyKey)
        if !displayPinned { display = .default }
        // Everyday or Developer, and the first run, are the person's too (Everyday.swift).
        AppMode.shared.forget()
        UserDefaults.standard.removeObject(forKey: BringAssistantView.doneKey)
        profile = nil
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
