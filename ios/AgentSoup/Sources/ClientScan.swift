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

    /// What the server would say when refusing this text (a credential in it), or nil when it's fine to send.
    static func blocked(_ text: String) -> SecretBlocked? {
        guard let scan, let hit = scan.invokeMethod("scanText", withArguments: [text]), hit.isObject,
              let msg = scan.invokeMethod("blockedMessage", withArguments: [hit])?.toString() else { return nil }
        return SecretBlocked(message: msg)
    }
}
