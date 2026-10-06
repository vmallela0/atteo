// Search on an end-to-end encrypted board, on this phone (docs/research/E2E-EVERYWHERE.md §4): the server can't index
// what it can't read, so the phone decrypts the board's history (BoardCrypto.history) and searches it here. The same
// algorithm as the web page and the CLI (src/localSearch.ts), so all three find the same messages with the same
// snippets: every word must start a word in the message (any case); best match first, then newest; at most 50.
// It works on UTF-16 units as JavaScript does; AtteoTests/LocalSearchTests checks it against the TypeScript.

import Foundation

enum LocalSearch {
    struct Entry: Equatable {
        let seq: Int
        let ts: Double
        let author: String
        let via: String?
        let type: String
        let text: String
    }

    static func search(_ entries: [Entry], _ q: String, from: String? = nil, agent: Bool? = nil, type: String? = nil) -> [ChatSearchResponse.Hit] {
        let words = q.lowercased().split(whereSeparator: { $0.isWhitespace }).map { Array(String($0).utf16) }
        var hits: [(e: Entry, sp: [(Int, Int)])] = []
        for e in entries {
            if let from, !from.isEmpty, e.author != from { continue }
            if let agent, (e.via == "agent") != agent { continue }
            if let type, !type.isEmpty, e.type != type { continue }
            let text = Array(e.text.utf16), lower = Array(e.text.lowercased().utf16)
            let low = lower.count == text.count ? lower : text
            guard let sp = words.isEmpty ? [] : spans(low, words) else { continue }
            hits.append((e, sp))
        }
        hits.sort { $0.sp.count != $1.sp.count ? $0.sp.count > $1.sp.count : $0.e.seq > $1.e.seq }
        return hits.prefix(50).map { h in
            .init(seq: h.e.seq, ts: h.e.ts, author: h.e.author, via: h.e.via, type: h.e.type, title: nil, snippet: snippet(Array(h.e.text.utf16), h.sp))
        }
    }

    /// A letter, a digit or "_" (JavaScript's /[\p{L}\p{N}_]/u on one UTF-16 unit).
    private static func wordChar(_ c: UInt16?) -> Bool {
        guard let c, let s = Unicode.Scalar(c) else { return false }
        if s == "_" { return true }
        switch s.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter, .decimalNumber, .letterNumber, .otherNumber: return true
        default: return false
        }
    }

    /// Where each word starts a word in the (lowercased) text, sorted; nil when one of the words isn't there.
    private static func spans(_ low: [UInt16], _ words: [[UInt16]]) -> [(Int, Int)]? {
        var out: [(Int, Int)] = []
        for w in words {
            var n = 0
            var p = 0
            while p + w.count <= low.count {
                if low[p] == w[0], Array(low[p..<p + w.count]) == w, !wordChar(p > 0 ? low[p - 1] : nil) {
                    out.append((p, p + w.count))
                    n += 1
                }
                p += 1
            }
            if n == 0 { return nil }
        }
        return out.sorted { $0.0 < $1.0 }
    }

    /// The words around the first match, matches between « and » (as the server marks them; SearchHitRow bolds them).
    private static func snippet(_ text: [UInt16], _ sp: [(Int, Int)]) -> String {
        func str(_ a: Int, _ b: Int) -> String { a < b ? String(decoding: text[a..<b], as: UTF16.self) : "" }
        let at = sp.first?.0 ?? 0
        let from = max(0, at - 60), to = min(text.count, at + 140)
        var s = ""
        var i = from
        for (a, b) in sp {
            if b <= i || a >= to { continue }
            s += str(i, max(i, a)) + "«" + str(max(i, a), min(b, to)) + "»"
            i = min(b, to)
        }
        s += str(i, to)
        let flat = s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
        return (from > 0 ? "… " : "") + flat + (to < text.count ? " …" : "")
    }
}
