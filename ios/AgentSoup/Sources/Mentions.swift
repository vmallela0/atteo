// @mentions in a message, highlighted like the web (src/mentions.ts highlightMentions): "@theo", "@theo's agent",
// "@theo/builder", "@agents", "@humans". Only what the server stored as a mention lights up (a dropped self-mention or
// an unknown name stays plain text); while a message is still sending, the board's members stand in. Each one sits in
// a rounded blue box, like Slack's: blue text on a soft blue box for others, white on solid blue for you (or your
// agent). Applied on top of the Markdown, never inside code.

import SwiftUI

/// "@Jarvis": a member's agent by the name they gave it (src/mentions.ts agentNameHits): case-insensitive, spaces and
/// apostrophes included, longest name first; a member's own handle at the same spot wins. `names`: lowercased name →
/// owner; `members`: lowercased handles. Ranges are UTF-16 (NSString), from the "@".
func agentNameMentions(in text: String, names: [String: String], members: Set<String>) -> [(range: NSRange, owner: String)] {
    guard !names.isEmpty, text.contains("@") else { return [] }
    let ns = text as NSString
    let sorted = names.keys.filter { !members.contains($0) }.sorted { $0.count > $1.count }
    let before = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.@/-")
    var out: [(NSRange, String)] = []
    var i = ns.range(of: "@").location
    while i != NSNotFound {
        defer { let r = ns.range(of: "@", range: NSRange(location: i + 1, length: ns.length - i - 1)); i = r.location }
        if i > 0, let s = Unicode.Scalar(ns.character(at: i - 1)), before.contains(s) { continue }
        let rest = ns.substring(from: i + 1)
        let handle = String(rest.prefix { $0.isLetter || $0.isNumber || "_.-".contains($0) }).lowercased()
        if !handle.isEmpty && (members.contains(handle) || members.contains(handle.replacingOccurrences(of: "[.-]+$", with: "", options: .regularExpression))) { continue }
        for k in sorted {
            let len = (k as NSString).length
            guard i + 1 + len <= ns.length, ns.substring(with: NSRange(location: i + 1, length: len)).lowercased() == k else { continue }
            if i + 1 + len < ns.length, let s = Unicode.Scalar(ns.character(at: i + 1 + len)), CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_")).contains(s) { continue }
            out.append((NSRange(location: i, length: 1 + len), names[k]!))
            break
        }
    }
    return out
}

/// The author's own form ("@vedu's agent" written by vedu's agent, "@vedu" by vedu) where a mention could be: outside
/// code, "> " quote lines and double quotes, like src/mentions.ts selfMentions. It's left out of the stored mentions
/// (it reaches no one), so it's passed to `mentioned(author:)` to be boxed anyway (vedu #2630).
func selfMention(in text: String, author: String, agent: Bool) -> EntryMention? {
    guard text.contains("@") else { return nil }
    var t = text
    for p in ["```[\\s\\S]*?```", "`[^`\\n]+`", "(?m)^>.*$", "\"[^\"\\n]*\"", "“[^”\\n]*”"] {
        t = t.replacingOccurrences(of: p, with: " ", options: .regularExpression)
    }
    let me = NSRegularExpression.escapedPattern(for: author.lowercased())
    let form = agent ? "@\(me)(?:'|’)s\\s+(?:agent|assistant)\\b" : "@\(me)(?![A-Za-z0-9_]|(?:'|’)s\\s+(?:agent|assistant)\\b|/)"
    guard let re = try? NSRegularExpression(pattern: "(?:^|[^A-Za-z0-9_.@/-])\(form)", options: [.caseInsensitive]) else { return nil }
    return re.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) == nil ? nil : EntryMention(user: author.lowercased(), agent: agent)
}

/// Marks a mention's run in a message's Text, so MentionBoxes can draw its box.
struct MentionBox: TextAttribute { let mine: Bool }

/// The mention colors: readable in light and dark.
enum MentionColor {
    static let box = Theme.mentionBox
    static let text = Theme.mentionText
    static let mineBox = Theme.mentionYouBox // you: a stronger ink box, as on the web (jxn #2706, #2858)
    static let mineText = Theme.mentionText
}

/// Draws each mention's rounded box behind its text (one box per mention per line), then the text.
struct MentionBoxes: TextRenderer {
    func draw(layout: Text.Layout, in ctx: inout GraphicsContext) {
        for line in layout {
            var box: CGRect?
            var mine = false
            func flush(_ ctx: inout GraphicsContext) {
                guard let b = box else { return }
                ctx.fill(Path(roundedRect: b.insetBy(dx: -3, dy: -0.5), cornerRadius: 5, style: .continuous), with: .color(mine ? MentionColor.mineBox : MentionColor.box))
                box = nil
            }
            for run in line {
                if let m = run[MentionBox.self] {
                    let r = run.typographicBounds.rect
                    if let b = box, m.mine == mine, abs(r.minX - b.maxX) < 1.5 { box = b.union(r) } else { flush(&ctx); box = r; mine = m.mine }
                } else { flush(&ctx) }
            }
            flush(&ctx)
        }
        for line in layout { ctx.draw(line) }
    }
}

extension String {
    /// The message as Text with its mentions boxed (draw it with `.textRenderer(MentionBoxes())`), and the handles
    /// that were (for VoiceOver and the QA).
    /// `author`: the writer's own form ("@vedu's agent" in vedu's agent's message), boxed though the server leaves it out
    /// of the stored mentions (it reaches no one, vedu #2630). Display only, like the web's highlightMentions `self`.
    func mentioned(_ mentions: [EntryMention]?, members: [String], me: String?, agentNames: [String: String] = [:], author: EntryMention? = nil, refTitle: (Int) -> String? = { _ in nil }) -> (text: Text, handles: [String]) {
        var out = mdLinked(refTitle) // ("#123": that message's title, opening it)
        guard contains("@") else { return (Text(out), []) }
        // What counts: the stored mentions, or (still sending) anyone on the board and their agent.
        let stored = mentions ?? members.flatMap { [EntryMention(user: $0.lowercased(), agent: false), EntryMention(user: $0.lowercased(), agent: true)] }
        guard !stored.isEmpty || author != nil else { return (Text(out), []) }
        let wanted = Set((stored + (author.map { [$0] } ?? [])).map { $0.user.lowercased() + ($0.agent ? "/agent" : "") })
        let plain = String(out.characters)
        let ns = plain as NSString
        var handles: [String] = []
        var boxes: [(Range<AttributedString.Index>, Bool)] = []
        // "@Jarvis": a member's agent by its name (#1125), stored as that member's agent.
        var taken = Set<Int>()
        for hit in agentNameMentions(in: plain, names: agentNames, members: Set(members.map { $0.lowercased() })) where wanted.contains(hit.owner + "/agent") {
            guard let r = Range(hit.range, in: out), !out[r].runs.contains(where: { $0.inlinePresentationIntent?.contains(.code) == true }) else { continue }
            let mine = hit.owner == me?.lowercased()
            out[r].foregroundColor = mine ? MentionColor.mineText : MentionColor.text
            out[r].link = URL(string: "atteo-person://\(hit.owner)?agent=1")
            out[r].font = Typo.body.weight(.semibold)
            boxes.append((r, mine))
            handles.append(ns.substring(with: hit.range))
            taken.insert(hit.range.location)
        }
        for m in Self.mentionRE.matches(in: plain, range: NSRange(location: 0, length: ns.length)) {
            if taken.contains(m.range(at: 2).location - 1) { continue }
            let handle = ns.substring(with: m.range(at: 2))
            let suffix = m.range(at: 3).location == NSNotFound ? nil : ns.substring(with: m.range(at: 3))
            let raw = handle.lowercased()
            var length: Int // of the highlighted part, from the "@"
            var mine = false
            if (raw == "agents" || raw == "humans" || raw == "all") && suffix == nil && !wanted.contains(raw) {
                // Everyone's agents / everyone / everyone and their agents: a group, never "you".
                guard mentions == nil || raw == "all" || stored.contains(where: { $0.agent == (raw == "agents") }) else { continue }
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
            out[r].foregroundColor = mine ? MentionColor.mineText : MentionColor.text
            if (raw == "agents" || raw == "humans" || raw == "all") && suffix == nil && !wanted.contains(raw) {
                out[r].link = URL(string: "atteo-group://\(raw)") // everyone's agents / everyone: who that reaches
            } else {
                // Tap: their card (or their agent's).
                let user = raw.replacingOccurrences(of: "[.-]+$", with: "", options: .regularExpression)
                out[r].link = URL(string: "atteo-person://\(user)?agent=\(suffix != nil ? 1 : 0)")
            }
            out[r].font = Typo.body.weight(.semibold)
            boxes.append((r, mine))
            handles.append(ns.substring(with: NSRange(location: at, length: length)))
        }
        guard !boxes.isEmpty else { return (Text(out), []) }
        // The message as pieces: plain text, and each mention tagged for its box.
        var text = Text("")
        var cursor = out.startIndex
        for (r, mine) in boxes.sorted(by: { $0.0.lowerBound < $1.0.lowerBound }) where r.lowerBound >= cursor {
            if cursor < r.lowerBound { text = text + Text(AttributedString(out[cursor..<r.lowerBound])) }
            text = text + Text(AttributedString(out[r])).customAttribute(MentionBox(mine: mine))
            cursor = r.upperBound
        }
        if cursor < out.endIndex { text = text + Text(AttributedString(out[cursor...])) }
        return (text, handles)
    }

    /// The web's MENTION_RE: "@handle", optionally "'s agent" or "/session", not inside an email, a path or a word.
    private static let mentionRE = try! NSRegularExpression(
        pattern: "(^|[^A-Za-z0-9_.@/-])@([A-Za-z0-9][A-Za-z0-9_.-]{0,31})((?:'|’)s\\s+agent\\b|/[A-Za-z0-9][A-Za-z0-9_.-]{0,31})?",
        options: [.caseInsensitive])
}
