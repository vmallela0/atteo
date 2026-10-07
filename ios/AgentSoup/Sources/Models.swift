// What the server sends (snake_case JSON, decoded with convertFromSnakeCase). Optional wherever the server may omit.

import Foundation

struct InboxResponse: Decodable {
    let items: [InboxItem]
    var notify: NotifySummary? = nil // when the digest is due (people; NotifyLevels.swift)
}
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
    var interrupt: String? = nil // now | digest | none: whether it notifies you (your level and quiet hours)
    var approvalId: String? = nil // kind approval: the request it's for

    func read(at t: Double) -> InboxItem {
        InboxItem(id: id, boardId: boardId, boardTitle: boardTitle, seq: seq, kind: kind, actor: actor, actorVia: actorVia, excerpt: excerpt, createdAt: createdAt, readAt: t, interrupt: interrupt, approvalId: approvalId)
    }
}

struct ApprovalsResponse: Decodable { let approvals: [Approval] }
struct Approval: Codable, Identifiable, Hashable {
    let id: String
    let client: String?
    let boardId: String?
    let title: String
    let details: String
    var tool: String? = nil // permission hook: Bash, Edit, etc.
    var command: String? = nil // the exact command or file the person is approving, verbatim
    var session: String? = nil // the agent session that asked
    let risk: String
    let status: String
    let createdAt: Double
    var requestedBy: String? = nil // who asked (on a board), if someone else's request started it
    var seq: Int? = nil // the message on the board it's about
    var expiresAt: Double? = nil
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
    var state: String? = nil // live (working now) | idle | gone
}

/// An agent on a board: a named session, or a member's agent connected without one.
struct BoardAgent: Codable, Hashable, Identifiable {
    let user: String
    let name: String?
    let client: String?
    let status: String?
    let lastSeen: Double
    let state: String // live | idle | gone
    var agentName: String? = nil // what its owner named it ("Jarvis"): shown with them, "Jarvis · theo's agent" (#1125)
    var agentNameAmbiguous: Bool? = nil // another member's agent here has the same name: "@Jarvis" needs the owner form
    var id: String { "\(user)/\(name ?? "")" }
    /// What people call it: "theo's agent", or "Jarvis · theo's agent" when theo named it (the session's slug and
    /// client are details, not its name).
    var label: String { agentLabel(user, agentName) }
    /// "Claude Code · claude-code-3": which tool and which session, when there's more than one.
    var detail: String? { let d = [client, name].compactMap { $0 }.filter { !$0.isEmpty }; return d.isEmpty ? nil : d.joined(separator: " · ") }
}
struct BoardAgentsResponse: Decodable { let agents: [BoardAgent] }
/// A board's members (for @-mentions in the message box).
struct MembersResponse: Decodable {
    struct Member: Decodable { let user: String; let displayName: String?; var agentName: String? = nil; var agentNameAmbiguous: Bool? = nil }
    let members: [Member]
}

struct BoardsResponse: Decodable { let boards: [Board] }
struct Board: Codable, Identifiable, Hashable {
    struct Last: Codable, Hashable { let by: String; let text: String } // jxn's #218: "vedu's agent", "deploy is green…"
    let id: String
    let title: String
    let kind: String?
    let entryCount: Int
    var lastActivity: Double // moved by the live feed as lines arrive (AppState.bump)
    let encrypted: Bool?
    let last: Last?
    var liveAgents: Int? = nil // agent sessions working on it right now
    var createdBy: String? = nil // its creator (renames, archives, removes anyone's task)
    var archived: Bool? = nil
    var picture: String? = nil // "/board-picture/<id>?v=<n>" (members only, versioned), or nil: its initial (a DM shows the other person)
    var openedAt: Double? = nil // when you last opened it, here or on the web: the tabs' "Last opened" order (vedu #5192)
}

extension Board {
    /// What to call it: a DM ("maya ↔ priya") is the other person; a board is its title.
    func displayName(me: String?) -> String {
        guard kind == "direct" else { return title }
        return title.components(separatedBy: "↔").map { $0.trimmingCharacters(in: .whitespaces) }.first { $0 != me && !$0.isEmpty } ?? title
    }
}

struct EntriesResponse: Decodable { let entries: [Entry]; let last: Int; var reactions: [String: [Reaction]]? = nil; var reads: [String: SeenMark]? = nil; var decisions: [String: HumanDecision]? = nil; var quick: [String: QuickChips]? = nil }
/// One emoji on a message and who left it (agents' 👀 / ✅ are read receipts: read and working / done).
struct Reaction: Codable, Hashable { let emoji: String; let users: [String] }
struct Entry: Codable, Identifiable, Hashable {
    let seq: Int
    let ts: Double
    let author: String
    let type: String
    var text: String // on an encrypted board: decrypted on this phone
    var title: String? // on an encrypted board: from the message's encrypted extras
    let to: String?
    let via: String?
    var artifactName: String? // on an encrypted board: the first of its decrypted files
    var pending: Bool? = nil // sent from this phone, not confirmed yet
    var failed: Bool? = nil
    var replyTo: Int? = nil // the message this one answers
    var mentions: [EntryMention]? = nil // who it names, as the server resolved them (nil while sending)
    var media: Media? = nil // a stored file's type and size ({mime, w, h, size}); nil for text files
    var artifactVersion: Int? = nil
    var artifactSize: Int? = nil
    var local: String? = nil // a file sending from this phone: its bytes on disk (for the preview and a retry)
    var retracts: Int? = nil // this one unsends that one (the retraction itself isn't shown; its target reads "Unsent")
    var resolves: [Int]? = nil // questions answered / tasks completed by this one
    var supersedes: Int? = nil // replaces an earlier entry
    var card: ChangeCardData? = nil // type "change": the git change card (branch, commits, files)
    var attachments: [FileRef]? = nil // every file of the message, in order (several: a grid, PictureGrid.swift)
    var humanDecision: HumanDecision? = nil // a person's decision: where it stands (HumanDecisions.swift)
    var agentName: String? = nil // an agent post: what its owner named it ("Jarvis"), shown "Jarvis · vedu's agent"
    /// Who can see it, when not everyone (#1748): "own" (Just mine: its person and their agents) or "people" (People
    /// only: `toPeople`, author included, never an agent). Nil: everyone on the board.
    var audience: String? = nil
    var toPeople: [String]? = nil
    /// Which agent wrote an agent post: "scout · Claude Code" for a named session, else just the client.
    var client: String? = nil
    /// An encrypted board's message that reads like instructions to an agent, screened on this phone: the ⚠'s words
    /// (ClientScan.flag; review #5551 item 6). Plain boards' messages are screened by the server.
    var flag: String? = nil
    var id: Int { seq }
    var byAgent: Bool { via == "agent" }
    /// The agent session's name ("opus-b" from "opus-b · Claude Code"), as the web reads it (jxn #2589). Nil for
    /// people and for an agent posting without a named session.
    var sessionName: String? {
        guard byAgent, let c = client, let r = c.range(of: " · ") else { return nil }
        let s = String(c[..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
        return s.isEmpty ? nil : s
    }
    /// Who wrote it, for grouping a run of messages: two sessions of one person's agent are two speakers.
    var senderKey: String { "\(author)|\(via ?? "")|\(sessionName ?? "")" }
    /// A picture shown inline (PNG, JPEG, GIF or WebP, as the server sniffed it).
    var isImage: Bool { artifactName != nil && (media?.mime.hasPrefix("image/") ?? false) }
}

/// "@theo", "@theo's agent", "@theo/builder": who a message names.
struct EntryMention: Codable, Hashable { let user: String; let agent: Bool; var session: String? = nil }
/// A stored file: its type, pixel size (pictures) and bytes.
struct Media: Codable, Hashable { let mime: String; let w: Int?; let h: Int?; let size: Int? }

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
    struct Agent: Codable, Equatable { let owner: String; let summary: String?; let capabilities: [String]; let record: Record; let online: Bool; var listed: Bool? = nil }
    struct Record: Codable, Equatable { let claimsVerified: Int; let claimsDisputed: Int; let tasksDone: Int }
    let agent: Agent
}

/// You, as others see you: name, bio, whether you're in the directory, and what you accept automatically.
struct Profile: Codable, Equatable {
    let name: String
    var displayName: String?
    var bio: String?
    var listed: Bool
    var rules: Rules
    var display: DisplayPrefs? = nil // text size, density, theme (only in your own profile; nil from an older server)
    var agentName: String? = nil // what you named your agent ("Jarvis"; #1125)
    var reactions: [String]? = nil // your favourite reaction emoji, 1–8 (the server's default preset until you pick; #1163)
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

/// "theo's agent", or "Jarvis · theo's agent" when theo named it (a name never shows without its owner, #1125).
func agentLabel(_ owner: String, _ name: String?) -> String {
    // Everyday says "Theo's assistant" (Everyday.swift); Developer mode, as today.
    guard let name, !name.isEmpty else { return Vocab.agentOf(owner) }
    return "\(name) · \(Vocab.agentOf(owner))"
}

/// The reaction row's default, until you pick your own (the server's DEFAULT_REACTIONS).
let defaultReactions = ["👍", "✅", "🤔", "🎉", "❤️", "🔥", "😂", "🙏"]

/// A board's MEMORY: short facts for agents.
struct MemoryResponse: Decodable { let items: [MemoryItem]; var max: Int? = nil }
struct MemoryItem: Decodable, Identifiable, Equatable {
    let id: Int
    let text: String
    let by: String
    let via: String
    var session: String? = nil
    var from: Int? = nil
    let ts: Double
    /// "theo", "theo's agent", "theo/scout".
    var who: String { via == "agent" ? (session.map { "\(by)/\($0)" } ?? String(localized: "\(by)'s agent", bundle: .l10n)) : by }
}

extension Double {
    /// "now", "4m", "2h", "3d", or a date (in the app's language: "刚刚", "4分钟"…).
    var ago: String {
        let s = max(0, Date().timeIntervalSince1970 - self / 1000)
        if s < 60 { return String(localized: "now", bundle: .l10n, comment: "Relative time: under a minute ago") }
        if s < 3600 { return String(localized: "\(Int(s / 60))m", bundle: .l10n, comment: "Relative time: minutes ago, short") }
        if s < 86400 { return String(localized: "\(Int(s / 3600))h", bundle: .l10n, comment: "Relative time: hours ago, short") }
        if s < 604_800 { return String(localized: "\(Int(s / 86400))d", bundle: .l10n, comment: "Relative time: days ago, short") }
        return Date(timeIntervalSince1970: self / 1000).formatted(.dateTime.month(.abbreviated).day())
    }
    /// Under a minute ago (what `ago` calls "now", in any language).
    var isJustNow: Bool { Date().timeIntervalSince1970 - self / 1000 < 60 }
}

struct TasksResponse: Decodable { let tasks: [WorkTask] }
/// A board task: who it's for, who's on it right now, how far along its checklist is.
struct WorkTask: Codable, Identifiable, Hashable {
    let seq: Int
    var status: String // todo | doing | blocked | done | stopped
    let assignee: String?
    let assigneeAgent: Bool?
    var leaseHolder: String?
    var leaseAgent: Bool?
    var leaseUntil: Double?
    let priority: String?
    let title: String
    var body: String
    var updatedAt: Double
    var version: Int? = nil // edits of the whole body say which version they started from
    var author: String? = nil // who posted it (they, or the board's creator, can remove it)
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
        if let h = leaseHolder, (leaseUntil ?? 0) > Date().timeIntervalSince1970 * 1000 { return leaseAgent == true ? Vocab.agentOf(h) : h }
        if let a = assignee { return assigneeAgent == true ? Vocab.agentOf(a) : a }
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

// MARK: - Chat parity, wave 2 (threads, reactions, unsend, receipts, board info, search, "on it")

/// How far a member has seen a board: as a person, and through their agent (-1: their agent has never been here).
struct SeenMark: Codable, Hashable { let personSeen: Int; let agentSeen: Int }

/// Which agent (or person) took a message ("theo/builder", "theo's agent"), and whether it's done.
struct Handling: Codable, Hashable { let by: String; let user: String?; let done: Bool? }

/// The board's live view (only what the app needs from it): who's on what, and how far everyone has read.
struct UpdatesResponse: Decodable { var handling: [String: Handling]? = nil; var reads: [String: SeenMark]? = nil }

/// One message with its replies (a thread).
struct ThreadResponse: Decodable { let entry: Entry; let replies: [Entry]; var reactions: [Reaction]? = nil }

/// A toggled reaction: whether yours is on now, and the message's reactions.
struct ReactResponse: Decodable { let on: Bool; let reactions: [Reaction] }

/// The answer to "On it": whether you have it now, and who does.
struct HandleResponse: Decodable { let ok: Bool; let by: String?; let done: Bool?; let message: String? }

/// Someone's card to open: the person, or their agent.
struct ProfileTarget: Identifiable, Hashable { let name: String; let agent: Bool; var id: String { "\(name)/\(agent)" } }

/// Search across your boards (the Chats list): boards whose name matches, and messages in them.
struct CrossSearchResponse: Decodable {
    struct Hit: Decodable, Hashable, Identifiable {
        let board: String; let title: String; let kind: String
        var seq: Int? = nil; var author: String? = nil; var via: String? = nil; let snippet: String
        var id: String { "\(board)#\(seq ?? 0)#\(snippet.hashValue)" }
    }
    let boards: [String]
    let hits: [Hit]
}

/// Search in one chat: messages (with a «highlighted» snippet) and files.
struct ChatSearchResponse: Decodable {
    struct Hit: Decodable, Hashable, Identifiable { let seq: Int; let ts: Double; let author: String; let via: String?; let type: String; let title: String?; let snippet: String; var id: Int { seq } }
    struct FileHit: Decodable, Hashable, Identifiable { let name: String; let version: Int; let snippet: String; var id: String { name } }
    let entries: [Hit]
    var files: [FileHit]? = nil
}

// MARK: - The web's features in the app (#508): people, files, members, invites

/// Someone you can find in People: their name, a line about them, and how you're connected.
struct Person: Decodable, Identifiable, Hashable {
    let name: String
    let displayName: String?
    let bio: String?
    var relation: String // self | friend | pending_out | pending_in | blocked | none
    let sharedBoards: Int?
    var id: String { name }
    var relationLabel: String? {
        switch relation {
        case "friend": return String(localized: "Friend", bundle: .l10n)
        case "pending_out": return String(localized: "Request sent", bundle: .l10n)
        case "pending_in": return String(localized: "Wants to be friends", bundle: .l10n)
        case "blocked": return String(localized: "Blocked", bundle: .l10n)
        case "self": return String(localized: "You", bundle: .l10n)
        default:
            let n = sharedBoards ?? 0
            return n > 0 ? String(localized: "\(n) shared boards", bundle: .l10n) : nil
        }
    }
}
struct PeopleResponse: Decodable { let people: [Person] }
struct PersonResponse: Decodable { let person: Person; let presence: String? }
struct FriendsResponse: Decodable { let friends: [Person] }
struct DirectResponse: Decodable { let board: String; let title: String }

/// A file on a board: every file is a versioned document.
struct DocMeta: Decodable, Identifiable, Hashable {
    let name: String
    let version: Int
    let updatedBy: String
    let updatedAt: Double
    let via: String?
    let size: Int
    var mime: String? = nil
    /// The public, still-sent message that posted this version; absent for private posts and unposted edits.
    var seq: Int? = nil
    var id: String { name }
}
struct DocsResponse: Decodable { let docs: [DocMeta] }
struct Doc: Decodable, Equatable {
    let name: String
    let version: Int
    let latest: Int
    let content: String
    let updatedBy: String
    let updatedAt: Double
    let via: String?
    /// Version-specific posting message, with the same visibility rules as DocMeta.seq.
    var seq: Int? = nil
}
struct DocVersion: Decodable, Identifiable, Hashable {
    let version: Int
    let author: String
    let ts: Double
    let via: String?
    let summary: String?
    var id: Int { version }
}
struct DocHistoryResponse: Decodable { let versions: [DocVersion] }

/// A board's members with their roles, and yours.
struct BoardMembersResponse: Decodable {
    struct Member: Decodable, Identifiable, Hashable { let user: String; let displayName: String?; let role: String; let lastSeen: Double?; var id: String { user } }
    let members: [Member]
    let you: String?
}
struct InviteLinkResponse: Decodable { let url: String }
struct InviteResponse: Decodable { let message: String? }
struct NewBoardResponse: Decodable { struct B: Decodable { let id: String; let title: String }; let board: B }
struct TaskResponse: Decodable { let task: WorkTask }

extension DocMeta {
    /// As a chat entry, so it opens the way a file in the chat does (Quick Look).
    var entry: Entry {
        Entry(seq: 0, ts: updatedAt, author: updatedBy, type: "artifact", text: "", title: nil, to: nil, via: via, artifactName: name,
              media: mime.map { Media(mime: $0, w: nil, h: nil, size: size) }, artifactVersion: version, artifactSize: size)
    }
}
