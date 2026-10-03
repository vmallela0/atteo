// @mentions in a message, highlighted like the web (src/mentions.ts highlightMentions): "@theo", "@theo's agent",
// "@theo/builder", "@agents", "@humans". Only what the server stored as a mention lights up (a dropped self-mention or
// an unknown name stays plain text); while a message is still sending, the board's members stand in. Yours (you or
// your agent) in clay, everyone else's in a quiet neutral tint. Applied on top of the Markdown, never inside code.

import SwiftUI

extension String {
    /// The message as styled text with its mentions tinted, and the handles that were (for VoiceOver and the QA).
    func mentioned(_ mentions: [EntryMention]?, members: [String], me: String?) -> (text: AttributedString, handles: [String]) {
        var out = md
        guard contains("@") else { return (out, []) }
        // What counts: the stored mentions, or (still sending) anyone on the board and their agent.
        let stored = mentions ?? members.flatMap { [EntryMention(user: $0.lowercased(), agent: false), EntryMention(user: $0.lowercased(), agent: true)] }
        guard !stored.isEmpty else { return (out, []) }
        let wanted = Set(stored.map { $0.user.lowercased() + ($0.agent ? "/agent" : "") })
        let plain = String(out.characters)
        let ns = plain as NSString
        var handles: [String] = []
        for m in Self.mentionRE.matches(in: plain, range: NSRange(location: 0, length: ns.length)) {
            let handle = ns.substring(with: m.range(at: 2))
            let suffix = m.range(at: 3).location == NSNotFound ? nil : ns.substring(with: m.range(at: 3))
            let raw = handle.lowercased()
            var length: Int // of the highlighted part, from the "@"
            var mine = false
            if (raw == "agents" || raw == "humans") && suffix == nil && !wanted.contains(raw) {
                // Everyone's agents / everyone: a group, never "you".
                guard mentions == nil || stored.contains(where: { $0.agent == (raw == "agents") }) else { continue }
                length = 1 + handle.utf16.count
            } else {
                // A trailing "." or "-" isn't part of the name ("thanks @theo."), unless that's someone's whole name.
                let isMember = { (n: String) in wanted.contains(n) || wanted.contains(n + "/agent") }
                let trimmed = raw.replacingOccurrences(of: "[.-]+$", with: "", options: .regularExpression)
                let user = isMember(raw) || trimmed.isEmpty ? raw : trimmed
                let agent = suffix != nil && user == raw
                guard wanted.contains(user + (agent ? "/agent" : "")) else { continue }
                length = 1 + (agent ? handle.utf16.count + (suffix?.utf16.count ?? 0) : user.utf16.count)
                mine = user == me?.lowercased()
            }
            let at = m.range(at: 2).location - 1 // the "@"
            guard let r = Range(NSRange(location: at, length: length), in: out) else { continue }
            if out[r].runs.contains(where: { $0.inlinePresentationIntent?.contains(.code) == true }) { continue } // `@name` in code
            out[r].foregroundColor = mine ? Theme.accent : Theme.text
            out[r].backgroundColor = mine ? Theme.accent.opacity(0.16) : Color.white.opacity(0.09)
            out[r].font = Typo.body.weight(.semibold)
            handles.append(ns.substring(with: NSRange(location: at, length: length)))
        }
        return (out, handles)
    }

    /// The web's MENTION_RE: "@handle", optionally "'s agent" or "/session", not inside an email, a path or a word.
    private static let mentionRE = try! NSRegularExpression(
        pattern: "(^|[^A-Za-z0-9_.@/-])@([A-Za-z0-9][A-Za-z0-9_.-]{0,31})((?:'|’)s\\s+agent\\b|/[A-Za-z0-9][A-Za-z0-9_.-]{0,31})?",
        options: [.caseInsensitive])
}
