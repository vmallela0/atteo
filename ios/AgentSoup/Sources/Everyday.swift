// Everyday mode (board decision #1272; the locked design is ios/qa/design/everyday: index.html, NOTES.md, png/).
// Everyday is everyone's default face: For you first, plain words (chat, assistant, to-do, "Needs your OK"), a result
// card instead of a change card's commits, and no message numbers, sessions or agent files. Developer mode is exactly
// today's app: one switch at the bottom of Settings ("Advanced (for developers)"), and it turns on by itself the first
// time this phone sees one of your agents running in a coding tool (Claude Code, Codex, Cursor…). Your own choice,
// once you flip the switch, always wins.
//
// Per device: the server's display prefs (/api/app/prefs) only take text, density and theme (any other key is a 400),
// so the mode isn't synced across devices yet.

import SwiftUI

@MainActor
final class AppMode: ObservableObject {
    static let shared = AppMode()
    /// Your choice on this phone: "on" (Developer), "off" (Everyday), or absent (follow your agents).
    static let choiceKey = "developer-mode"
    /// The first coding agent this phone saw (it turned Developer mode on by itself): its client and when.
    static let autoKey = "developer-mode-auto"

    struct AutoReason: Codable, Equatable { let client: String; let at: Double }

    @Published private(set) var developer = false
    @Published private(set) var autoReason: AutoReason?
    /// Whether you have an agent connected (any session), once the server has said; nil until then.
    @Published private(set) var hasAgent: Bool?

    private init() {
        #if DEBUG
        // UI tests: AGENT_SOUP_MODE=developer|everyday sets the switch for the run (the harness turns Developer mode on
        // for every test unless a test opts into Everyday). Written as your choice, so flipping it in Settings works.
        if let m = API.environment("MODE") { UserDefaults.standard.set(m == "developer" ? "on" : "off", forKey: Self.choiceKey) }
        #endif
        if let d = UserDefaults.standard.data(forKey: Self.autoKey) { autoReason = try? JSONDecoder().decode(AutoReason.self, from: d) }
        recompute()
    }

    var everyday: Bool { !developer }

    /// Your explicit choice, if you made one.
    var choice: Bool? {
        switch UserDefaults.standard.string(forKey: Self.choiceKey) {
        case "on": return true
        case "off": return false
        default: return nil
        }
    }

    /// The switch in Settings.
    func set(developer on: Bool) {
        UserDefaults.standard.set(on ? "on" : "off", forKey: Self.choiceKey)
        Haptics.play(.touch)
        withAnimation(.smooth) { recompute() }
    }

    /// Your sessions as the server listed them: the first coding agent turns Developer mode on (unless you chose).
    func note(sessions: [AgentSession], fromServer: Bool) {
        if fromServer || !sessions.isEmpty { hasAgent = !sessions.isEmpty }
        if autoReason == nil, let s = sessions.first(where: { Self.isCodingAgent($0.client) }) {
            let r = AutoReason(client: Self.clientName(s.client ?? ""), at: Date().timeIntervalSince1970 * 1000)
            autoReason = r
            if let d = try? JSONEncoder().encode(r) { UserDefaults.standard.set(d, forKey: Self.autoKey) }
        }
        withAnimation(.smooth) { recompute() }
    }

    /// Signing out: the next person starts in Everyday (and their own agents decide again).
    func forget() {
        UserDefaults.standard.removeObject(forKey: Self.autoKey)
        #if DEBUG
        if API.environment("MODE") == nil { UserDefaults.standard.removeObject(forKey: Self.choiceKey) }
        #else
        UserDefaults.standard.removeObject(forKey: Self.choiceKey)
        #endif
        autoReason = nil
        hasAgent = nil
        recompute()
    }

    private func recompute() {
        let d = choice ?? (autoReason != nil)
        if d != developer { developer = d }
        Vocab.everyday = !d
    }

    /// A coding agent's client, as the server names it (src/mcp.ts clientName) or as a session was created with.
    static func isCodingAgent(_ client: String?) -> Bool {
        guard let c = client?.lowercased() else { return false }
        return ["claude code", "claude-code", "codex", "cursor", "windsurf", "vs code", "visual-studio-code", "goose", "gemini", "opencode"].contains { c.contains($0) }
    }

    /// "Claude Code", "Codex", …: the client's name without a session's suffix.
    static func clientName(_ raw: String) -> String {
        let c = raw.components(separatedBy: " (").first ?? raw
        switch c.lowercased() {
        case "claude-code": return "Claude Code"
        case "codex-mcp-client": return "Codex"
        default: return c
        }
    }
}

/// The words, by mode (NOTES.md's map). Display only: what's sent (mentions, to_session, commands) never changes.
enum Vocab {
    /// Mirrors AppMode (a plain flag, so free functions like agentLabel can read it).
    nonisolated(unsafe) static var everyday = false

    static func pick(_ developer: String, _ everyday: String) -> String { Self.everyday ? everyday : developer }

    /// "theo's agent" / "Theo's assistant".
    static func agentOf(_ owner: String) -> String { everyday ? "\(owner.capitalizedFirst)'s assistant" : "\(owner)'s agent" }
    /// A name the server wrote ("theo's agent: …" in a chat's last line, a reaction's user): as Everyday says it.
    static func shown(_ serverName: String) -> String {
        everyday && serverName.hasSuffix("'s agent") ? agentOf(String(serverName.dropLast(8))) : serverName
    }
    static var agent: String { pick("agent", "assistant") }
    static var agents: String { pick("agents", "assistants") }
    static var yourAgent: String { pick("Your agent", "Your assistant") }
    static var tasks: String { pick("Tasks", "To-dos") }
    static var task: String { pick("task", "to-do") }
    static var boards: String { pick("Boards", "Groups") }
}

extension String {
    /// nil when empty. (capitalizedFirst, "maya" → "Maya", is TasksView's.)
    var nonEmpty: String? { isEmpty ? nil : self }
}

/// Hooks other features plug into Everyday's screens without editing them.
enum EverydayHooks {
    /// The Ask screen's "Talk" slot (live voice with the assistant, e.g. Grok's): when set, its button shows beside
    /// "Type instead". Nil: nothing there.
    nonisolated(unsafe) static var talk: (() -> AnyView)?
}

/// The signed-in app: Everyday's For you (with Chats a tap away) or, in Developer mode, today's Chats.
struct ModeRoot: View {
    @EnvironmentObject var state: AppState
    @ObservedObject private var mode = AppMode.shared

    var body: some View {
        Group {
            if mode.developer { ChatsView() } else { EverydayRoot() }
        }
        .id(mode.developer) // every screen below re-reads its words
    }
}

/// Everyday: For you first; Chats is a screen beside it. The first run asks you to bring your assistant.
struct EverydayRoot: View {
    @EnvironmentObject var state: AppState
    @ObservedObject private var mode = AppMode.shared
    @State private var chats = false
    @AppStorage(BringAssistantView.doneKey) private var firstRunDone = false

    private var firstRun: Bool { !firstRunDone && state.loaded && mode.hasAgent == false }

    var body: some View {
        ZStack {
            if chats {
                ChatsView(home: { withAnimation(.smooth(duration: 0.3)) { chats = false } })
                    .transition(.move(edge: .trailing))
            } else {
                ForYouView(openChats: { withAnimation(.smooth(duration: 0.3)) { chats = true } })
                    .transition(.move(edge: .leading))
            }
        }
        .fullScreenCover(isPresented: Binding(get: { firstRun }, set: { if !$0 { firstRunDone = true } })) {
            BringAssistantView(firstRun: true) { firstRunDone = true }
                .environmentObject(state)
        }
        .onAppear {
            #if DEBUG
            if API.environment("FIRST_RUN") != nil { firstRunDone = false } // UI tests: the first run again
            #endif
        }
    }
}
