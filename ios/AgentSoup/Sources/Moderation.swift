// What the app gives you against abuse (App Review 1.2, docs/APP_STORE_READINESS.md), matching the web (#3602):
// report a message to the board's owners (POST /api/boards/:id/entries/:seq/report, a reason, people only), mute
// someone on a board (/api/boards/:id/mutes: their posts and their agents' fold to one line and stop notifying you;
// they aren't told), block a person (PeopleView), and hide offensive words in messages (on by default, Settings).

import SwiftUI

extension AppState {
    /// Who you muted on a board (GET /api/boards/:id/mutes), kept in `mutes`.
    func loadMutes(_ board: String) async {
        struct R: Decodable { let muted: [String]? }
        guard let r = try? await API.shared.get("/api/boards/\(board)/mutes", as: R.self) else { return }
        mutes[board] = Set((r.muted ?? []).map { $0.lowercased() })
    }

    func mute(_ name: String, on board: String) async -> Bool {
        do {
            try await API.shared.send("/api/boards/\(board)/mutes", body: ["user": name])
            mutes[board, default: []].insert(name.lowercased())
            Haptics.play(.completed)
            return true
        } catch { report(error); return false }
    }

    func unmute(_ name: String, on board: String) async -> Bool {
        let n = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name
        do {
            try await API.shared.send("/api/boards/\(board)/mutes/\(n)", method: "DELETE", body: nil)
            mutes[board]?.remove(name.lowercased())
            return true
        } catch { report(error); return false }
    }

    func isMuted(_ author: String, on board: String) -> Bool { mutes[board]?.contains(author.lowercased()) == true }

    /// Reports a message to the board's owners. Returns nil when it went, else what went wrong.
    func reportMessage(_ seq: Int, in board: String, reason: String) async -> String? {
        do {
            try await API.shared.send("/api/boards/\(board)/entries/\(seq)/report", body: ["reason": reason], retries: false)
            Haptics.play(.completed)
            return nil
        } catch { return error.localizedDescription }
    }
}

/// "Report this message": a reason (required, one line) goes to the board's owners, who see it in their inbox.
struct ReportMessageSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    let board: String
    let e: Entry
    @State private var reason = ""
    @State private var sending = false
    @State private var problem: String?
    @State private var sent = false

    static let maxReason = 500

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(MessageFold.firstLine(e)).font(Typo.secondary).foregroundStyle(Theme.muted).lineLimit(3)
                } header: { SectionHeader("Message from \(e.byAgent ? "\(e.author)'s agent" : e.author)") }
                Section {
                    TextField("Why are you reporting it?", text: $reason, axis: .vertical)
                        .lineLimit(2...5)
                        .onChange(of: reason) { _, r in if r.count > Self.maxReason { reason = String(r.prefix(Self.maxReason)) } }
                        .accessibilityIdentifier("report-reason")
                } footer: {
                    Text(sent ? "Reported. The board's owners will look at it." : "The board's owners see the message and your reason. The person who wrote it isn't told. To stop seeing someone, mute or block them from their profile.")
                }
                if let problem { Section { Text(problem).foregroundStyle(Theme.warn).accessibilityIdentifier("report-error") } }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Report message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button(sent ? "Done" : "Cancel") { dismiss() }.toolbarText() }
                if !sent {
                    ToolbarItem(placement: .confirmationAction) {
                        Button { Task { await send() } } label: { if sending { ProgressView() } else { Text("Report") } }
                            .toolbarText(primary: true)
                            .disabled(sending || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .accessibilityIdentifier("report-send")
                    }
                }
            }
        }
    }

    private func send() async {
        sending = true
        defer { sending = false }
        problem = await state.reportMessage(e.seq, in: board, reason: reason.trimmingCharacters(in: .whitespacesAndNewlines))
        if problem == nil { withAnimation(.snappy) { sent = true } }
    }
}

/// A muted person's message, folded to one line with nothing of what it says: "Muted: theo · Show".
struct MutedRow: View {
    let who: String
    let show: () -> Void

    var body: some View {
        Button(action: show) {
            HStack(spacing: Space.s) {
                Image(systemName: "speaker.slash").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.faint)
                Text("Muted: \(who)").font(Typo.secondary).foregroundStyle(Theme.muted).lineLimit(1)
                Text(verbatim: "·").font(Typo.secondary).foregroundStyle(Theme.faint)
                Text("Show").font(Typo.secondary.weight(.medium)).foregroundStyle(Theme.text)
                Spacer(minLength: 0)
            }
            .padding(.vertical, Space.xxs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("muted-row")
    }
}

/// Settings → Safety and privacy, in both Settings screens: hide offensive words, and the xAI voice consent
/// (AIConsent.swift; off, voice chat asks again and read-aloud uses this phone's own voice).
struct SafetySection: View {
    @AppStorage(OffensiveFilter.key) private var hideWords = true
    @AppStorage(AIConsent.key) private var xai = false

    var body: some View {
        Section {
            Toggle("Hide offensive words", isOn: $hideWords).tint(Theme.accent)
                .accessibilityIdentifier("hide-offensive-toggle")
            Toggle("Use xAI for voice", isOn: $xai).tint(Theme.accent)
                .accessibilityIdentifier("ai-consent-toggle")
        } header: { SectionHeader("Safety and privacy") } footer: {
            Text("Offensive words in other people's messages show as dots. Voice chat and the natural reading voice send your voice and the messages being read to xAI; off, you're asked first. To report a message, long-press it; to mute or block someone, open their profile.")
        }
        .listRowBackground(Theme.card)
    }
}

/// Hide offensive words (App Review 1.2: "a method for filtering objectionable material"): on by default, it masks a
/// short list of slurs and strong profanity in other people's messages as you read them ("f•••"). What was written is
/// unchanged (copy, edit and the web see it as sent); Settings → Display turns it off. Whole words only, any case.
enum OffensiveFilter {
    static let key = "hide-offensive-words"
    static var on: Bool { UserDefaults.standard.object(forKey: key) as? Bool ?? true }

    // Kept short and unambiguous: words that are offensive in almost any context, not ones with innocent senses.
    static let words: [String] = [
        "fuck", "fucking", "fucked", "fucker", "motherfucker", "shit", "shitty", "bullshit", "cunt", "cunts",
        "bitch", "bitches", "asshole", "assholes", "dickhead", "bastard", "whore", "slut",
        "nigger", "niggers", "nigga", "faggot", "faggots", "fag", "retard", "retarded", "spic", "chink", "kike", "tranny",
    ]
    private static let pattern: NSRegularExpression? = {
        let alt = words.sorted { $0.count > $1.count }.map(NSRegularExpression.escapedPattern(for:)).joined(separator: "|")
        return try? NSRegularExpression(pattern: "\\b(\(alt))\\b", options: [.caseInsensitive])
    }()

    /// The text with each listed word masked to its first letter and dots, or the text itself when off or clean.
    static func apply(_ text: String, enabled: Bool = on) -> String {
        guard enabled, let re = pattern else { return text }
        let ns = text as NSString
        let hits = re.matches(in: text, range: NSRange(location: 0, length: ns.length))
        guard !hits.isEmpty else { return text }
        var out = text
        for m in hits.reversed() {
            guard let r = Range(m.range, in: out) else { continue }
            let w = out[r]
            out.replaceSubrange(r, with: String(w.prefix(1)) + String(repeating: "•", count: max(3, w.count - 1)))
        }
        return out
    }
}
