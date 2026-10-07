// The server's secret scan, redaction and injection screen, run on this phone for end-to-end encrypted boards (the
// server can't read them). ClientScan.js is generated from src/secrets.ts and src/screen.ts (src/clientScan.ts) and
// answers exactly as they do (test/clientScan.test.ts); JavaScriptCore runs it. Compiled into the app (ClientScan.swift)
// and the notification extension, each of which bundles ClientScan.js. One instance per thread: a JSContext isn't
// shared across threads.

import Foundation
import JavaScriptCore

final class ScanRules {
    private let scan: JSValue

    init?(bundle: Bundle = .main) {
        guard let url = bundle.url(forResource: "ClientScan", withExtension: "js"),
              let js = try? String(contentsOf: url, encoding: .utf8),
              let ctx = JSContext() else { return nil }
        ctx.evaluateScript(js)
        guard let s = ctx.objectForKeyedSubscript("atteoScan"), s.isObject else { return nil }
        scan = s
    }

    /// The server's words for refusing this text (a credential in it), or nil.
    func blocked(_ text: String) -> String? {
        guard let hit = scan.invokeMethod("scanText", withArguments: [text]), hit.isObject else { return nil }
        return scan.invokeMethod("blockedMessage", withArguments: [hit])?.toString() ?? "Blocked: this looks like it contains a secret."
    }

    /// The text with any credential replaced by "[redacted: …]", as the server redacts (secrets.ts redactText).
    func redact(_ text: String) -> String {
        scan.invokeMethod("redactText", withArguments: [text])?.toString() ?? text
    }

    /// Reads like instructions to an agent (screen.ts): the ⚠'s words, and whether it's only quoted; nil when it doesn't.
    func flag(_ text: String) -> (note: String, quoted: Bool)? {
        guard let f = scan.invokeMethod("screenText", withArguments: [text]), f.isObject,
              let note = scan.invokeMethod("flagNote", withArguments: [f])?.toString() else { return nil }
        return (note, f.objectForKeyedSubscript("quoted")?.toBool() == true)
    }
}
