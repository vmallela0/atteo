// People's display names (jxn #4369), the same rule as the web's src/names.ts: a person is shown as the name they
// chose, and the @handle stays where it's an address (typed @mentions) and for VoiceOver. A blank name, or one made
// only of invisible characters, falls back to the handle. Agents keep "<handle>'s agent" (or a session's "handle/name").

import Foundation

enum PersonName {
    /// Controls, zero-width and bidi-override characters (src/names.ts INVISIBLE).
    private static let invisible: NSRegularExpression = {
        let pattern = "[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0]"
        return try! NSRegularExpression(pattern: pattern)
    }()

    /// The display name as shown, or nil when there's nothing to show (unset, blank, or only invisible characters).
    static func clean(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        let ns = raw as NSString
        var s = invisible.stringByReplacingMatches(in: raw, range: NSRange(location: 0, length: ns.length), withTemplate: "")
        s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.count > 60 { s = String(s.prefix(60)) }
        return s.isEmpty ? nil : s
    }

    /// What to call a person: their display name, else their handle.
    static func shown(_ handle: String, _ display: String?) -> String {
        clean(display) ?? handle
    }

    /// Whether `display` could pass for another person: written as a handle ("@vedu"), or equal to a handle the
    /// screen also shows (`known`). A plain "Vedu" for vmallela is fine. One equal to their own handle is not.
    static func looksLikeOther(_ handle: String, _ display: String, known: some Sequence<String>) -> Bool {
        let bare = display.hasPrefix("@") ? String(display.dropFirst()) : display
        if bare.lowercased() == handle.lowercased() { return false }
        if display.range(of: "^@[A-Za-z0-9]", options: .regularExpression) != nil { return true }
        let d = bare.lowercased()
        for k in known where k.lowercased() == d { return true }
        return false
    }

    /// A server label that may already be an agent or a session ("jxn's agent", "jxn/scout", Everyday's
    /// "Jxn's assistant"). Those stay. A bare handle becomes the display name.
    static func label(_ raw: String, names: [String: String]) -> String {
        if raw.contains("/") || raw.hasSuffix("'s agent") || raw.hasSuffix("'s assistant") { return raw }
        return shown(raw, names[raw])
    }

    /// VoiceOver, the hover equivalent: "Vedu Mallela, @vedu" when the visible name isn't the handle.
    static func spoken(_ handle: String, names: [String: String]) -> String {
        let d = shown(handle, names[handle])
        return d == handle ? d : "\(d), @\(handle)"
    }

    /// A direct chat's "a ↔ b" title, each side by the name they chose. Any other title stays.
    static func boardTitle(_ title: String, names: [String: String]) -> String {
        guard title.contains("↔") else { return title }
        return title.components(separatedBy: "↔").map { part in
            let h = part.trimmingCharacters(in: .whitespaces)
            return shown(h, names[h])
        }.joined(separator: " ↔ ")
    }
}

extension Board {
    /// What the chat list and the header call it. A DM is the other person by the name they chose; a board is its title.
    func shownTitle(me: String?, names: [String: String]) -> String {
        guard kind == "direct" else { return title }
        let other = displayName(me: me)
        if other.contains("↔") { return PersonName.boardTitle(other, names: names) }
        return PersonName.shown(other, names[other])
    }
}
