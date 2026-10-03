// @mentions in a message, highlighted like the web (src/mentions.ts highlightMentions): "@theo", "@theo's agent",
// "@theo/builder", "@agents", "@humans". Only what the server stored as a mention lights up (a dropped self-mention or
// an unknown name stays plain text); while a message is still sending, the board's members stand in. Each one sits in
// a rounded blue box, like Slack's: blue text on a soft blue box for others, white on solid blue for you (or your
// agent). Applied on top of the Markdown, never inside code.

import SwiftUI

/// Marks a mention's run in a message's Text, so MentionBoxes can draw its box.
struct MentionBox: TextAttribute { let mine: Bool }

/// The mention colors: readable in light and dark.
enum MentionColor {
    static let box = Color(UIColor { t in
        t.userInterfaceStyle == .dark ? UIColor(red: 0.20, green: 0.50, blue: 1.0, alpha: 0.26) : UIColor(red: 0.11, green: 0.45, blue: 0.90, alpha: 0.14)
    })
    static let text = Color(UIColor { t in
        t.userInterfaceStyle == .dark ? UIColor(red: 0.60, green: 0.79, blue: 1.0, alpha: 1) : UIColor(red: 0.05, green: 0.36, blue: 0.75, alpha: 1)
    })
    static let mineBox = Color(red: 0.16, green: 0.47, blue: 0.98) // you: solid, the strongest thing in the line
    static let mineText = Color.white
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
    func mentioned(_ mentions: [EntryMention]?, members: [String], me: String?) -> (text: Text, handles: [String]) {
        var out = mdLinked // ("#123" opens that message)
        guard contains("@") else { return (Text(out), []) }
        // What counts: the stored mentions, or (still sending) anyone on the board and their agent.
        let stored = mentions ?? members.flatMap { [EntryMention(user: $0.lowercased(), agent: false), EntryMention(user: $0.lowercased(), agent: true)] }
        guard !stored.isEmpty else { return (Text(out), []) }
        let wanted = Set(stored.map { $0.user.lowercased() + ($0.agent ? "/agent" : "") })
        let plain = String(out.characters)
        let ns = plain as NSString
        var handles: [String] = []
        var boxes: [(Range<AttributedString.Index>, Bool)] = []
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
            out[r].foregroundColor = mine ? MentionColor.mineText : MentionColor.text
            if !(raw == "agents" || raw == "humans") || wanted.contains(raw) {
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
