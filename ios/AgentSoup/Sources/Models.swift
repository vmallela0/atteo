// What the server sends (snake_case JSON, decoded with convertFromSnakeCase). Optional wherever the server may omit.

import Foundation

struct InboxResponse: Decodable { let items: [InboxItem] }
struct InboxItem: Codable, Identifiable, Hashable {
    let id: Int
    let boardId: String
    let boardTitle: String?
    let seq: Int
    let kind: String
    let actor: String
    let actorVia: String?
    let excerpt: String
    let createdAt: Double
    let readAt: Double?

    func read(at t: Double) -> InboxItem {
        InboxItem(id: id, boardId: boardId, boardTitle: boardTitle, seq: seq, kind: kind, actor: actor, actorVia: actorVia, excerpt: excerpt, createdAt: createdAt, readAt: t)
    }
}

struct ApprovalsResponse: Decodable { let approvals: [Approval] }
struct Approval: Codable, Identifiable, Hashable {
    let id: String
    let client: String?
    let boardId: String?
    let title: String
    let details: String
    let risk: String
    let status: String
    let createdAt: Double
}

struct ContactsResponse: Codable {
    struct Incoming: Codable, Hashable { let from: String; let text: String?; let createdAt: Double }
    let incoming: [Incoming]
}

struct SessionsResponse: Decodable { let sessions: [AgentSession] }
struct AgentSession: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let client: String?
    let scope: String?
    let status: String?
    let lastSeen: Double
    let active: Bool?
}

struct BoardsResponse: Decodable { let boards: [Board] }
struct Board: Codable, Identifiable, Hashable {
    struct Last: Codable, Hashable { let by: String; let text: String } // jxn's #218: "vedu's agent", "deploy is green…"
    let id: String
    let title: String
    let kind: String?
    let entryCount: Int
    let lastActivity: Double
    let encrypted: Bool?
    let last: Last?
}

struct EntriesResponse: Decodable { let entries: [Entry]; let last: Int }
struct Entry: Codable, Identifiable, Hashable {
    let seq: Int
    let ts: Double
    let author: String
    let type: String
    var text: String // on an encrypted board: decrypted on this phone
    let title: String?
    let to: String?
    let via: String?
    let artifactName: String?
    var pending: Bool? = nil // sent from this phone, not confirmed yet
    var failed: Bool? = nil
    var id: Int { seq }
    var byAgent: Bool { via == "agent" }
}

struct PostResponse: Decodable { let entry: Entry }

struct TapeResponse: Decodable { let lines: [TapeLine]; let cursor: Int }
struct TapeLine: Codable, Identifiable, Hashable {
    let id: Int
    let boardId: String
    let board: String?
    let seq: Int
    let ts: Double
    let author: String
    let via: String?
    let type: String
    let toUser: String?
    let excerpt: String
    let dm: Bool?
}

struct MeAgentResponse: Decodable {
    struct Agent: Codable { let owner: String; let summary: String?; let capabilities: [String]; let record: Record; let online: Bool; var listed: Bool? = nil }
    struct Record: Codable { let claimsVerified: Int; let claimsDisputed: Int; let tasksDone: Int }
    let agent: Agent
}

/// You, as others see you: name, bio, whether you're in the directory, and what you accept automatically.
struct Profile: Codable, Equatable {
    let name: String
    var displayName: String?
    var bio: String?
    var listed: Bool
    var rules: Rules
    struct Rules: Codable, Equatable { var autoAcceptInvites: String?; var autoAcceptFriends: String?; var autoAcceptAgents: String? }
}
struct ProfileResponse: Decodable { let profile: Profile }

/// A sign-in that can act as you: an agent's connection, the CLI, this app.
struct Connection: Decodable, Identifiable, Equatable {
    let id: String
    let label: String?
    let kind: String?
    let createdAt: Double
    let lastUsed: Double?
    let revokedAt: Double?
    let expiresAt: Double?
}
struct ConnectionsResponse: Decodable { let tokens: [Connection] }

extension Double {
    /// "now", "4m", "2h", "3d", or a date.
    var ago: String {
        let s = max(0, Date().timeIntervalSince1970 - self / 1000)
        if s < 60 { return "now" }
        if s < 3600 { return "\(Int(s / 60))m" }
        if s < 86400 { return "\(Int(s / 3600))h" }
        if s < 604_800 { return "\(Int(s / 86400))d" }
        return Date(timeIntervalSince1970: self / 1000).formatted(.dateTime.month(.abbreviated).day())
    }
}

struct TasksResponse: Decodable { let tasks: [WorkTask] }
/// A board task: who it's for, who's on it right now, how far along its checklist is.
struct WorkTask: Codable, Identifiable, Hashable {
    let seq: Int
    let status: String // todo | doing | blocked | done | stopped
    let assignee: String?
    let assigneeAgent: Bool?
    let leaseHolder: String?
    let leaseAgent: Bool?
    let leaseUntil: Double?
    let priority: String?
    let title: String
    let body: String
    let updatedAt: Double
    var parent: Int? = nil // the task this is a sub-task of
    var children: Progress? = nil // this task's sub-tasks, done of total
    struct Progress: Codable, Hashable { let done: Int; let total: Int }
    var id: Int { seq }

    /// The checklist lines, in order: (text, ticked).
    var items: [(text: String, done: Bool)] {
        body.split(separator: "\n").compactMap { raw in
            let l = raw.trimmingCharacters(in: .whitespaces)
            guard l.hasPrefix("- [ ]") || l.hasPrefix("- [x]") || l.hasPrefix("- [X]") else { return nil }
            return (String(l.dropFirst(5)).trimmingCharacters(in: .whitespaces), !l.hasPrefix("- [ ]"))
        }
    }

    /// Who's on it: the agent or person holding it right now, else who it's assigned to.
    var who: String? {
        if let h = leaseHolder, (leaseUntil ?? 0) > Date().timeIntervalSince1970 * 1000 { return leaseAgent == true ? "\(h)'s agent" : h }
        if let a = assignee { return assigneeAgent == true ? "\(a)'s agent" : a }
        return nil
    }
    /// The body's checklist: (done, total), if it has one.
    var checklist: (done: Int, total: Int)? {
        let lines = body.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        let done = lines.filter { $0.hasPrefix("- [x]") || $0.hasPrefix("- [X]") }.count
        let total = done + lines.filter { $0.hasPrefix("- [ ]") }.count
        return total > 0 ? (done, total) : nil
    }
    var priorityRank: Int { priority == "high" ? 0 : priority == "medium" ? 1 : priority == "low" ? 3 : 2 }
}
