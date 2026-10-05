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

/// Does this message @mention `me` the person, by name (jxn #4120)? The server stored a person mention of `me` AND the
/// text says "@me" itself, outside code, quotes and "> " lines: not "@me's agent", not a session ("@me/scout"), and not
/// only a group (@humans, @all expand to every person but don't name you). Like the web's markMe (a person chip whose
/// user is you). Drives the row's tint only; "for you" in notifications and read-aloud keep their own rules.
func mentionsPersonDirectly(text: String, mentions: [EntryMention]?, me: String?) -> Bool {
    guard let me = me?.lowercased(), !me.isEmpty, (mentions ?? []).contains(where: { !$0.agent && $0.user.lowercased() == me }) else { return false }
    var t = text
    for p in ["```[\\s\\S]*?```", "`[^`\\n]+`", "(?m)^>.*$", "\"[^\"\\n]*\"", "“[^”\\n]*”"] {
        t = t.replacingOccurrences(of: p, with: " ", options: .regularExpression)
    }
    let h = NSRegularExpression.escapedPattern(for: me)
    let pattern = "(?:^|[^A-Za-z0-9_.@/-])@\(h)(?![A-Za-z0-9_]|(?:'|’)s\\s+(?:agent|assistant)\\b|/)"
    guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return false }
    return re.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) != nil
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
    func mentioned(_ mentions: [EntryMention]?, members: [String], me: String?, agentNames: [String: String] = [:], author: EntryMention? = nil, displayName: (String) -> String = { $0 }, refTitle: (Int) -> String? = { _ in nil }) -> (text: Text, handles: [String]) {
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
            var chip = AttributedString(out[r])
            if let url = chip.link, let target = personLink(url) {
                let raw = String(chip.characters).dropFirst()
                let address = raw.contains("/") ? String(raw) : target.name + (target.agent ? "'s agent" : "")
                var label = AttributedString(displayName(address))
                if let attributes = chip.runs.first?.attributes { label.setAttributes(attributes) }
                chip = label
            }
            text = text + Text(chip).customAttribute(MentionBox(mine: mine))
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

// MARK: - The message box's mentions as single units (jxn #2551, like the web's chips: src/html.ts mtokens)

/// A mention in the message box is one unit, as on the web: one Backspace at its end removes it whole, an edit that
/// cuts into it takes all of it, the caret never rests inside it, and a selection that cuts into it covers it.
/// Ranges are UTF-16 (NSString), each from the "@" to the mention's end; `tokens` is what's in the box now.
enum MentionTokens {
    /// An edit of `range`, grown to cover each token it cuts into. An empty range at a token's edge (typing right
    /// before or after it) cuts into nothing. Backspace with the caret at a token's end arrives as the range of its
    /// last character, and so takes the whole token.
    static func expand(_ range: NSRange, tokens: [NSRange]) -> NSRange {
        var a = range.location, b = range.location + range.length
        for t in tokens {
            let s = t.location, e = t.location + t.length
            if range.length == 0 {
                if s < a && a < e { a = s; b = e } // an insertion inside a token (the caret can't rest there) replaces it
                continue
            }
            if s < a && a < e { a = s } // the edit starts inside the token
            if s < b && b < e { b = e } // or ends inside it
        }
        return NSRange(location: a, length: b - a)
    }

    /// Where the caret or selection goes: a caret inside a token moves out of it, to the far edge from where it came
    /// (so the arrow keys step over a token: from its end, left goes to its start), else to the nearer edge; a
    /// selection that cuts into a token grows to cover it.
    static func snap(_ sel: NSRange, previous: NSRange?, tokens: [NSRange]) -> NSRange {
        guard sel.length == 0 else { return expand(sel, tokens: tokens) }
        let a = sel.location
        guard let t = tokens.first(where: { $0.location < a && a < $0.location + $0.length }) else { return sel }
        let s = t.location, e = t.location + t.length
        if let p = previous, p.length == 0 {
            if p.location >= e { return NSRange(location: s, length: 0) } // moving left from its end
            if p.location <= s { return NSRange(location: e, length: 0) } // moving right from its start
        }
        return NSRange(location: a - s < e - a ? s : e, length: 0)
    }
}

/// What "@" offers in the message box, in the web's order (src/html.ts mentionOptions): each other member, then their
/// agent (by its name too, when it has one), then each of their agent sessions ("@jxn/opus-b", jxn #2551); then your
/// own agent and sessions; then everyone's agents, everyone, and everyone and their agents.
enum MentionMenu {
    static func options(people: [String], me: String?, named: [String: AppState.AgentName], sessions: [BoardAgent]) -> [Mentionable] {
        func sessionsOf(_ u: String) -> [Mentionable] {
            sessions.filter { $0.user == u && !($0.name ?? "").isEmpty }
                .sorted { ($0.name ?? "") < ($1.name ?? "") }
                .map { s in
                    let status = s.status?.trimmingCharacters(in: .whitespacesAndNewlines)
                    return Mentionable(handle: "\(u)/\(s.name ?? "")", user: u, agent: true,
                                       note: (status?.isEmpty == false ? status : nil) ?? s.client ?? String(localized: "agent session", bundle: .l10n))
                }
        }
        func agentOptions(_ u: String) -> [Mentionable] {
            var out: [Mentionable] = []
            if let n = named[u], !n.ambiguous {
                out.append(Mentionable(handle: n.name, user: u, agent: true, note: u == me ? String(localized: "your agent", bundle: .l10n) : String(localized: "\(u)'s agent", bundle: .l10n)))
            }
            let note: String? = named[u].map { String(localized: "\($0.name) · agent", bundle: .l10n) }
            out.append(Mentionable(handle: "\(u)'s agent", user: u, agent: true, note: note))
            return out + sessionsOf(u)
        }
        var out: [Mentionable] = []
        var seen = Set<String>()
        for u in people.sorted() where u != me && seen.insert(u.lowercased()).inserted { // sorted, like the web
            out.append(Mentionable(handle: u, user: u, agent: false))
            out += agentOptions(u)
        }
        if let me { out += agentOptions(me) }
        out.append(Mentionable(handle: "agents", user: nil, agent: true))
        out.append(Mentionable(handle: "humans", user: nil, agent: false))
        out.append(Mentionable(handle: "all", user: nil, agent: false, note: String(localized: "everyone and their agents", bundle: .l10n))) // last, like the web
        return out
    }

    /// What matches what's typed after "@" so far, like the web: with a "/", the session form ("jxn/op"); otherwise a
    /// member's handle or the option itself ("jx" offers jxn, jxn's agent and jxn's sessions). What's already typed in
    /// full isn't offered again.
    static func filter(_ items: [Mentionable], query: String) -> [Mentionable] {
        let q = query.lowercased()
        return items.filter { m in
            let h = m.handle.lowercased()
            guard h != q else { return false }
            if q.contains("/") { return h.hasPrefix(q) }
            return h.hasPrefix(q) || (m.user?.lowercased().hasPrefix(q) ?? false)
        }
    }
}
