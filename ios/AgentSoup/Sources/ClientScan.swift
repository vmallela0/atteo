// The secret scan for end-to-end encrypted boards, on this phone (docs/research/E2E-EVERYWHERE.md §4). The server
// can't read what you send to such a board, so it can't refuse an API key in it the way it does elsewhere: the phone
// runs the server's own rules first. ClientScan.js is generated from them (src/clientScan.ts; the web page and the CLI
// run the same rules) and answers exactly as the server does (test/clientScan.test.ts); JavaScriptCore runs it here.

import Foundation
import JavaScriptCore

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
    private static let scan: JSValue? = {
        guard let url = Bundle.main.url(forResource: "ClientScan", withExtension: "js"),
              let js = try? String(contentsOf: url, encoding: .utf8),
              let ctx = JSContext() else { return nil }
        ctx.evaluateScript(js)
        let s = ctx.objectForKeyedSubscript("atteoScan")
        return s?.isObject == true ? s : nil
    }()

    /// Whether the rules loaded (they ship in the app; false would mean a broken build).
    static var ready: Bool { scan != nil }

    /// Why this text mustn't go to an encrypted board (a credential in it, or no way to check), or nil to send it.
    /// Fails closed: without the rules, nothing is sent.
    static func refusal(_ text: String) -> LocalizedError? { refusal(text, using: scan) }

    static func refusal(_ text: String, using scan: JSValue?) -> LocalizedError? {
        guard let scan else { return ScanUnavailable() }
        guard let hit = scan.invokeMethod("scanText", withArguments: [text]), hit.isObject else { return nil }
        return SecretBlocked(message: scan.invokeMethod("blockedMessage", withArguments: [hit])?.toString() ?? "Blocked: this looks like it contains a secret.")
    }

    /// What the server would say when refusing this text (a credential in it), or nil when it has none.
    static func blocked(_ text: String) -> SecretBlocked? { refusal(text) as? SecretBlocked }
}
