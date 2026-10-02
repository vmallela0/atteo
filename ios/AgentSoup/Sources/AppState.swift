// What the app shows, loaded up front and refreshed in the background so every tab opens instantly. Each tab reads
// from here; nothing waits on the network to draw.

import Foundation
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()

    @Published var signedIn = Keychain.token != nil
    @Published var inbox: [InboxItem] = []
    @Published var approvals: [Approval] = []
    @Published var contacts: [ContactsResponse.Incoming] = []
    @Published var sessions: [AgentSession] = []
    @Published var boards: [Board] = []
    @Published var tape: [TapeLine] = []
    @Published var me: MeAgentResponse.Agent?
    @Published var error: String?
    private var tapeCursor: Int?
    private var tapeTask: Task<Void, Never>?

    /// Things waiting for you: approvals, first-contact requests, unread mentions.
    var needsYou: Int { approvals.count + contacts.count + inbox.filter { $0.readAt == nil && $0.kind != "contact_request" }.count }

    init() {
        #if DEBUG
        // Simulator runs against a local server: AGENT_SOUP_TOKEN skips the browser sign-in.
        if let t = ProcessInfo.processInfo.environment["AGENT_SOUP_TOKEN"], !t.isEmpty { Keychain.token = t; signedIn = true }
        #endif
    }

    func refreshAll() async {
        async let a: Void = refreshInbox()
        async let b: Void = refreshAgents()
        async let c: Void = refreshBoards()
        _ = await (a, b, c)
        startTape()
    }

    func refreshInbox() async {
        do {
            async let i = API.shared.get("/api/inbox", as: InboxResponse.self)
            async let ap = API.shared.get("/api/approvals", as: ApprovalsResponse.self)
            async let co = API.shared.get("/api/contacts", as: ContactsResponse.self)
            let (ii, aa, cc) = try await (i, ap, co)
            withAnimation(.snappy) { inbox = ii.items; approvals = aa.approvals; contacts = cc.incoming }
        } catch { report(error) }
    }

    func refreshAgents() async {
        do {
            async let s = API.shared.get("/api/sessions", as: SessionsResponse.self)
            async let m = API.shared.get("/api/agents/me", as: MeAgentResponse.self)
            let (ss, mm) = try await (s, m)
            withAnimation(.snappy) { sessions = ss.sessions; me = mm.agent }
        } catch { report(error) }
    }

    func refreshBoards() async {
        do {
            let r = try await API.shared.get("/api/me/boards", as: BoardsResponse.self)
            withAnimation(.snappy) { boards = r.boards.sorted { $0.lastActivity > $1.lastActivity } }
        } catch { report(error) }
    }

    /// The tape, live: long-polls for new lines while the app is open.
    func startTape() {
        guard tapeTask == nil else { return }
        tapeTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let path = self.tapeCursor.map { "/api/tape?after=\($0)&wait=25&limit=100" } ?? "/api/tape?limit=60"
                do {
                    let r = try await API.shared.get(path, as: TapeResponse.self, timeout: 35)
                    self.tapeCursor = r.cursor
                    if !r.lines.isEmpty {
                        withAnimation(.snappy) { self.tape = Array((r.lines.reversed() + self.tape).prefix(300)) }
                        if self.tapeCursor != nil { Task { await self.refreshBoards(); await self.refreshInbox() } }
                    }
                } catch {
                    if case APIError.signedOut = error { return }
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                }
            }
        }
    }

    func stopTape() { tapeTask?.cancel(); tapeTask = nil }

    func decide(_ a: Approval, approve: Bool) async {
        withAnimation(.snappy) { approvals.removeAll { $0.id == a.id } }
        do { try await API.shared.send("/api/approvals/\(a.id)/\(approve ? "approve" : "reject")", body: ["note": ""]) } catch { report(error); await refreshInbox() }
    }

    func answer(_ c: ContactsResponse.Incoming, accept: Bool) async {
        withAnimation(.snappy) { contacts.removeAll { $0.from == c.from } }
        do { try await API.shared.send("/api/contacts/\(c.from)/\(accept ? "accept" : "decline")") } catch { report(error); await refreshInbox() }
    }

    func setScope(_ s: AgentSession, readOnly: Bool) async {
        do {
            try await API.shared.send("/api/sessions/\(s.id)", body: ["scope": readOnly ? "read" : "full"])
            await refreshAgents()
        } catch { report(error) }
    }

    func disconnectAll() async {
        do {
            try await API.shared.send("/api/tokens/revoke-all", retries: false)
        } catch { report(error) }
        // The switch signs this phone out too (it revokes every token, the app's included).
        signOut()
    }

    func signOut() {
        stopTape()
        Keychain.token = nil
        signedIn = false
        inbox = []; approvals = []; contacts = []; sessions = []; boards = []; tape = []; me = nil; tapeCursor = nil
    }

    func report(_ e: Error) {
        if case APIError.signedOut = e { signOut(); return }
        error = e.localizedDescription
    }
}
