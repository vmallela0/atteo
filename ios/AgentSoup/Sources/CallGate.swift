// Board calls' Atteo gate (vedu #5383): whether words are said to Atteo ("Atteo, what's next?", "hey Atteo …",
// "what did we decide, Atteo?"), not just about it ("I asked Atteo yesterday", "Atteo's summary"). Only words that are
// reach Atteo; the rest of the call never does. The same rule as the server's addressesAtteo (src/calls.ts) and the web
// page's callAddressed (src/callWeb.ts): keep the three the same (AtteoTests/CallGateTests.swift runs the same cases).

import Foundation

enum CallGate {
    private static let name = "@?(?:atteo|ateo|a teo|attayo|ateyo)"
    private static let start = try! NSRegularExpression(pattern: "^[\\s\"'(\\[]*(?:(?:hey|hi|hello|ok|okay|so|and|um|uh|yo|right)[\\s,.!]+)*\(name)(?!['\\w])")
    private static let end = try! NSRegularExpression(pattern: ",\\s*\(name)\\s*[?.!]*\\s*$")

    static func addressesAtteo(_ text: String) -> Bool {
        let t = text.precomposedStringWithCompatibilityMapping.lowercased()
            .replacingOccurrences(of: "\u{2019}", with: "'").replacingOccurrences(of: "\u{2018}", with: "'")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return false }
        let r = NSRange(t.startIndex..., in: t)
        return start.firstMatch(in: t, range: r) != nil || end.firstMatch(in: t, range: r) != nil
    }
}
