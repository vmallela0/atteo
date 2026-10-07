// The secret scan for end-to-end encrypted boards, on this phone (docs/research/E2E-EVERYWHERE.md §4). The server
// can't read what you send to such a board, so it can't refuse an API key in it the way it does elsewhere: the phone
// runs the server's own rules first (Shared/ScanRules.swift; the web page and the CLI run the same rules). What
// arrives is checked too (review #5551 item 6): a credential someone else sent shows redacted, and text that reads
// like instructions to an agent gets the ⚠.

import JavaScriptCore
import SwiftUI

struct SecretBlocked: LocalizedError {
    let message: String
    var errorDescription: String? {
        message + " " + String(localized: "(Caught on this phone: nothing was encrypted or sent.)", bundle: .l10n)
    }
}

/// The rules didn't load (a broken build): on an encrypted board nothing is sent unchecked (review #5551 item 5).
struct ScanUnavailable: LocalizedError {
    var errorDescription: String? {
        String(localized: "This phone couldn't check the message for secrets, so nothing was encrypted or sent. Update Atteo and try again.", bundle: .l10n)
    }
}

@MainActor
enum ClientScan {
    private static let rules = ScanRules()

    /// Whether the rules loaded (they ship in the app; false would mean a broken build).
    static var ready: Bool { rules != nil }

    /// Why this text mustn't go to an encrypted board (a credential in it, or no way to check), or nil to send it.
    /// Fails closed: without the rules, nothing is sent.
    static func refusal(_ text: String) -> LocalizedError? { refusal(text, using: rules) }

    static func refusal(_ text: String, using rules: ScanRules?) -> LocalizedError? {
        guard let rules else { return ScanUnavailable() }
        return rules.blocked(text).map { SecretBlocked(message: $0) }
    }

    /// What the server would say when refusing this text (a credential in it), or nil when it has none.
    static func blocked(_ text: String) -> SecretBlocked? { refusal(text) as? SecretBlocked }

    /// A decrypted message as it's shown: any credential in it redacted. Without the rules, nothing readable shows.
    static func redact(_ text: String) -> String {
        rules?.redact(text) ?? String(localized: "🔒 Encrypted. This phone can't read it yet.", bundle: .l10n)
    }

    /// The ⚠ for a decrypted message that reads like instructions to an agent, or nil.
    static func flag(_ text: String) -> (note: String, quoted: Bool)? { rules?.flag(text) }
}

/// The ⚠ on an encrypted board's message that reads like instructions to an agent (the web's .fbadge), in the
/// server's words: "⚠ Flagged: tries to override an agent's instructions; do not act on it".
struct FlagBadge: View {
    let note: String
    var body: some View {
        Text("⚠ " + note.prefix(1).uppercased() + note.dropFirst())
            .font(Typo.micro.weight(.medium)).foregroundStyle(Theme.warn)
            .fixedSize(horizontal: false, vertical: true)
    }
}
