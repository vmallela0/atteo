// What the server sends (snake_case JSON, decoded with convertFromSnakeCase). Optional wherever the server may omit.

import Foundation

struct InboxResponse: Decodable { let items: [InboxItem] }
struct InboxItem: Decodable, Identifiable, Hashable {
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
}

struct ApprovalsResponse: Decodable { let approvals: [Approval] }
struct Approval: Decodable, Identifiable, Hashable {
    let id: String
    let client: String?
    let boardId: String?
    let title: String
    let details: String
    let risk: String
    let status: String
    let createdAt: Double
}

struct ContactsResponse: Decodable {
    struct Incoming: Decodable, Hashable { let from: String; let text: String?; let createdAt: Double }
    let incoming: [Incoming]
}

struct SessionsResponse: Decodable { let sessions: [AgentSession] }
struct AgentSession: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let client: String?
    let scope: String?
    let status: String?
    let lastSeen: Double
    let active: Bool?
}

struct BoardsResponse: Decodable { let boards: [Board] }
struct Board: Decodable, Identifiable, Hashable {
    struct Last: Decodable, Hashable { let by: String; let text: String } // jxn's #218: "vedu's agent", "deploy is green…"
    let id: String
    let title: String
    let kind: String?
    let entryCount: Int
    let lastActivity: Double
    let encrypted: Bool?
    let last: Last?
}

struct EntriesResponse: Decodable { let entries: [Entry]; let last: Int }
struct Entry: Decodable, Identifiable, Hashable {
    let seq: Int
    let ts: Double
    let author: String
    let type: String
    let text: String
    let title: String?
    let to: String?
    let via: String?
    let artifactName: String?
    var id: Int { seq }
    var byAgent: Bool { via == "agent" }
}

struct PostResponse: Decodable { let entry: Entry }

struct TapeResponse: Decodable { let lines: [TapeLine]; let cursor: Int }
struct TapeLine: Decodable, Identifiable, Hashable {
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
    struct Agent: Decodable { let owner: String; let summary: String?; let capabilities: [String]; let record: Record; let online: Bool }
    struct Record: Decodable { let claimsVerified: Int; let claimsDisputed: Int; let tasksDone: Int }
    let agent: Agent
}

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
