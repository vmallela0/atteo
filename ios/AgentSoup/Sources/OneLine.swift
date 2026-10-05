// One line (jxn #2690, the web's #2691): with Settings → Display → Messages set to "One line unless they mention you"
// (display.compact "others"), a message in the chat that isn't for you shows as one line, "who · first line". A tap
// opens it, another folds it again, and the board's ⋯ menu opens or folds them all. What's for you never folds.

import SwiftUI

enum MessageFold {
    /// What decides whether a message may fold. `parent` is the message it answers, when it's loaded.
    struct Context {
        var me: String?
        /// A DM or "Your agent": everything there is for you.
        var direct: Bool
        var parent: Entry?
        /// The message just jumped to (a link, search, Jump to latest) and the first unread one when the chat opened.
        var jumpedTo: Int?
        var firstUnread: Int?
    }

    /// True when the message stays whole whatever the setting says (jxn's agent #2695: the same list on web and app).
    static func keepsFull(_ e: Entry, _ c: Context) -> Bool {
        if c.direct { return true }
        if e.seq == c.jumpedTo || e.seq == c.firstUnread { return true }
        guard let me = c.me?.lowercased() else { return true } // not signed in yet: nothing folds
        let author = e.author.lowercased()
        if author == me && !e.byAgent { return true } // your own messages
        // A mention of you, your agent, @agents or @all (the server lists each person and agent they reach).
        if (e.mentions ?? []).contains(where: { $0.user.lowercased() == me }) { return true }
        if e.to?.lowercased() == me { return true } // a question, task or message addressed to you
        if e.type == "approval" || e.type == "decision" || e.humanDecision != nil { return true }
        if e.audience == "people", (e.toPeople ?? []).contains(where: { $0.lowercased() == me }) { return true } // People only, to you
        if let p = c.parent, p.author.lowercased() == me, !p.byAgent { return true } // a reply to something you wrote
        return false
    }

    static func folds(_ e: Entry, on: Bool, _ c: Context) -> Bool { on && !keepsFull(e, c) }

    /// "First line" of a message: its title, else its first non-empty line, else what it carries.
    static func firstLine(_ e: Entry) -> String {
        if let t = e.title?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { return t }
        let line = e.text.split(whereSeparator: \.isNewline).lazy.map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty }
        if let line {
            // Markdown marks read as noise on one line.
            return line.replacingOccurrences(of: #"^(#{1,6}\s+|>\s*|[-*]\s+)"#, with: "", options: .regularExpression)
                .replacingOccurrences(of: #"[*_`]{1,3}"#, with: "", options: .regularExpression)
        }
        if e.isImage { return String(localized: "Picture", bundle: .l10n) }
        if let n = e.artifactName { return n }
        return ""
    }
}

/// A folded message: small avatar, who, the first line, when. The whole row opens it.
struct FoldedRow: View {
    let e: Entry
    let who: String
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: Space.s) {
                Avatar(name: e.author, agent: e.byAgent, size: 20)
                (Text(who).font(Typo.secondary.weight(.semibold)).foregroundStyle(Theme.text)
                    + Text(verbatim: " · ").font(Typo.secondary).foregroundStyle(Theme.faint)
                    + Text(verbatim: MessageFold.firstLine(e)).font(Typo.secondary).foregroundStyle(Theme.muted))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: Space.xs)
                Text(e.ts.ago).font(Typo.micro).foregroundStyle(Theme.faint).monospacedDigit()
            }
            .padding(.vertical, Space.xxs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(who): \(MessageFold.firstLine(e)), folded", bundle: .l10n))
        .accessibilityHint(Text("Double-tap to open", bundle: .l10n))
        .accessibilityIdentifier("folded-\(e.seq)")
    }
}
