// The code-block tokenizer (SyntaxHighlight.swift): the same tokens as the web's (src/codecolor.ts) on every fixture
// (CodeColorFixtures, made by ios/qa/codecolor-fixtures.mjs), the web's own test cases, unknown and odd language
// names, malformed input, the 4,000-character cap, and hostile input that made the web's regexes backtrack.

import SwiftUI
import XCTest
@testable import Atteo

final class SyntaxHighlightTests: XCTestCase {
    /// Every stretch, plain ("") ones merged: [[class, text], …], as the fixtures have them.
    private func all(_ code: String, _ lang: String) -> [[String]] {
        let s = Array(code.unicodeScalars)
        var out: [[String]] = []
        var at = 0
        func plain(_ r: Range<Int>) {
            guard !r.isEmpty else { return }
            let t = SyntaxHighlight.text(s, r)
            if let last = out.last, last[0].isEmpty { out[out.count - 1][1] += t } else { out.append(["", t]) }
        }
        for run in SyntaxHighlight.runs(code, lang) {
            plain(at..<run.range.lowerBound)
            out.append([run.kind.rawValue, SyntaxHighlight.text(s, run.range)])
            at = run.range.upperBound
        }
        plain(at..<s.count)
        return out
    }
    /// The web's `has`: a stretch of this class whose trimmed text is this.
    private func has(_ code: String, _ lang: String, _ cls: String, _ text: String) -> Bool {
        all(code, lang).contains { $0[0] == cls && $0[1].trimmingCharacters(in: .whitespacesAndNewlines) == text }
    }

    func testSameTokensAsTheWeb() throws {
        let data = try XCTUnwrap(Data(base64Encoded: CodeColorFixtures.base64))
        let cases = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 1000)
        var failures = 0
        for c in cases {
            let lang = c["l"] as! String, code = c["c"] as! String, want = c["t"] as! [[String]]
            let got = all(code, lang)
            if got != want {
                failures += 1
                if failures <= 15 { XCTFail("\(lang) \(code.debugDescription)\n web: \(want)\n app: \(got)") }
            }
        }
        XCTAssertEqual(failures, 0, "cases that differ from the web")
    }

    func testTheWebsCases() {
        let ts = #"// note"# + "\n" + #"export function f<T>(ms = 250): Promise<T> { const s = `a ${ms}`; return setTimeout(() => g("x\"y"), ms) /* end */ }"#
        for (c, s) in [("c", "// note"), ("k", "export"), ("k", "function"), ("n", "250"), ("t", "Promise"), ("k", "const"), ("s", "`a ${ms}`"),
                       ("f", "setTimeout"), ("s", #""x\"y""#), ("c", "/* end */")] {
            XCTAssertTrue(has(ts, "ts", c, s), "\(c) \(s)")
        }
        let py = "@cache\ndef top(n: int = 5):\n    \"\"\"Doc.\"\"\"\n    return f\"{n}\" if True else None  # why"
        for (c, s) in [("m", "@cache"), ("k", "def"), ("f", "top"), ("s", "\"\"\"Doc.\"\"\""), ("s", "f\"{n}\""), ("n", "True"), ("n", "None"), ("c", "# why")] {
            XCTAssertTrue(has(py, "python", c, s), "\(c) \(s)")
        }
        XCTAssertTrue(has("select a from t where x = 'y' -- c", "sql", "k", "select"))
        XCTAssertTrue(has("SELECT COUNT(*) FROM t", "sqlite", "k", "FROM"))
        let j = #"{"a": "b", "n": -1.5, "ok": true}"#
        XCTAssertTrue(has(j, "json", "p", #""a""#) && has(j, "json", "s", #""b""#) && has(j, "json", "n", "-1.5") && has(j, "json", "n", "true"))
        let sh = #"echo "$HOME" ${X} # done"#
        XCTAssertTrue(has(sh, "bash", "k", "echo") && has(sh, "bash", "m", "${X}") && has(sh, "bash", "c", "# done"))
        let h = #"<a href="x">hi</a>"#
        XCTAssertTrue(has(h, "html", "g", "<a") && has(h, "html", "p", "href") && has(h, "html", "s", #""x""#) && has(h, "html", "", "hi"))
        let d = "@@ -1 +1 @@\n-old\n+new\n same"
        XCTAssertTrue(has(d, "diff", "m", "@@ -1 +1 @@") && has(d, "diff", "d", "-old") && has(d, "diff", "i", "+new") && has(d, "diff", "", "same"))
    }

    func testUnknownMissingAndOddLanguagesStayPlain() {
        for lang in ["", "code", "mermaid", "brainfuck", "__proto__", "constructor", "toString", "hasOwnProperty"] {
            XCTAssertNil(SyntaxHighlight.language(lang), lang)
            XCTAssertTrue(SyntaxHighlight.runs("x = 1 // \"a\"", lang).isEmpty, lang)
            XCTAssertEqual(SyntaxHighlight.accessibilityValue(lang, code: "x"), "")
        }
        XCTAssertTrue(SyntaxHighlight.runs("x = 1", nil).isEmpty)
        let a = SyntaxHighlight.attributed("let x = 1", language: "nope")
        XCTAssertEqual(String(a.characters), "let x = 1")
        XCTAssertTrue(a.runs.allSatisfy { $0.swiftUI.foregroundColor == nil })
    }

    func testAliasesAndAccessibilityValue() {
        XCTAssertEqual(SyntaxHighlight.language("TypeScript"), "js")
        XCTAssertEqual(SyntaxHighlight.language(" py "), "py")
        XCTAssertEqual(SyntaxHighlight.language("zsh"), "sh")
        XCTAssertEqual(SyntaxHighlight.language("c#"), "java")
        XCTAssertEqual(SyntaxHighlight.language("yml"), "yaml")
        XCTAssertEqual(SyntaxHighlight.language("ini"), "toml")
        XCTAssertEqual(SyntaxHighlight.language("svg"), "html")
        XCTAssertEqual(SyntaxHighlight.language("patch"), "diff")
        XCTAssertEqual(SyntaxHighlight.accessibilityValue("swift", code: "let x = 1"), "highlighted: swift")
        XCTAssertEqual(SyntaxHighlight.accessibilityValue("TS", code: "x"), "highlighted: ts")
    }

    func testColoursAndStylesInTheText() {
        let code = "let a = \"é\" // ok\nlet n = 3"
        let attributed = SyntaxHighlight.attributed(code, language: "swift")
        XCTAssertEqual(String(attributed.characters), code, "the text is unchanged")
        XCTAssertTrue(attributed.runs.contains { $0.swiftUI.foregroundColor != nil }, "coloured")
        XCTAssertTrue(attributed.runs.contains { $0.inlinePresentationIntent == .emphasized }, "comments in italics")
        let diff = SyntaxHighlight.attributed("-old\n+new", language: "diff")
        XCTAssertEqual(diff.runs.filter { $0.swiftUI.backgroundColor != nil }.count, 2, "diff lines on a tint")
    }

    func testMalformedInputNeverLosesText() {
        // Unclosed strings don't swallow the next line; unclosed comments run to the end.
        XCTAssertTrue(has("const a = 'it's\nlet b = 2 /* open", "js", "k", "let"))
        XCTAssertTrue(has("const a = 'it's\nlet b = 2 /* open", "js", "c", "/* open"))
        XCTAssertTrue(has("x = \"open\ny = 1\n\"\"\"never closed", "py", "n", "1"))
        let nasty = ["\"\\", "'", "`", "\"\"\"", "/*", "<", "<a", "${", "$", "#", "@", "'a", "0x", "1e", ".", "-", "&", "<![CDATA[", "key:", "- ",
                     "\u{301}é𝔘👩‍👩‍👧", "'😀'", "\"\\😀\"", "<div class=\"a", ""]
        for lang in SyntaxHighlight.aliases.keys {
            for s in nasty {
                XCTAssertEqual(all(s, lang).map { $0[1] }.joined(), s, "\(lang) \(s.debugDescription)")
                XCTAssertEqual(String(SyntaxHighlight.attributed(s, language: lang).characters), s)
            }
        }
    }

    func testOver4000CharactersStaysPlain() {
        let line = "let x = \"a\" // c\n" // 17 characters
        let under = String(repeating: line, count: 235) // 3,995
        let over = String(repeating: line, count: 236) // 4,012
        XCTAssertFalse(SyntaxHighlight.runs(under, "swift").isEmpty)
        XCTAssertTrue(SyntaxHighlight.runs(over, "swift").isEmpty)
        XCTAssertEqual(SyntaxHighlight.accessibilityValue("swift", code: over), "")
        XCTAssertEqual(String(SyntaxHighlight.attributed(over, language: "swift").characters), over)
    }

    /// The web's regexes took ~450ms on these (#2028); here each is well under 50ms even at 20,000 characters.
    func testHostileInputIsLinear() {
        let cases: [(String, String)] = [("css", "-a"), ("toml", "a."), ("css", "a:"), ("yaml", "a."), ("js", "\"\\"), ("py", "'\\"), ("html", "<a \""),
                                         ("sh", "${"), ("rs", "#["), ("json", "\"a\" "), ("c", "\n#"), ("css", "a:("), ("toml", "\n["), ("sql", "'")]
        for (lang, unit) in cases {
            let code = String(repeating: unit, count: 20_000 / unit.count)
            let start = Date()
            _ = SyntaxHighlight.runs(code, lang, cap: .max)
            let ms = Date().timeIntervalSince(start) * 1000
            XCTAssertLessThan(ms, 50, "\(lang) \(unit.debugDescription): \(Int(ms))ms")
        }
        // Every 2-character repeat of the characters the rules care about, and some 3-character ones, in every
        // language, at the cap.
        let chars = Array("\"'`\\/*#-:;{(<[.\na").map(String.init)
        var units = chars.flatMap { a in chars.map { a + $0 } }
        units += ["a.b", "-a-", "a: ", "\"a\\", "<a=", "#[a", "${a", "'a'", "a!(", "x =", "/*a", "<!-"]
        let langs = Array(Set(SyntaxHighlight.aliases.values))
        let start = Date()
        var worst = (0.0, "")
        for unit in units {
            let code = String(repeating: unit, count: 4_000 / unit.count)
            for lang in langs {
                let t = Date()
                _ = SyntaxHighlight.runs(code, lang)
                let ms = Date().timeIntervalSince(t) * 1000
                if ms > worst.0 { worst = (ms, "\(lang) \(unit.debugDescription)") }
            }
        }
        XCTAssertLessThan(worst.0, 50, "worst: \(worst.1) \(Int(worst.0))ms")
        XCTAssertLessThan(Date().timeIntervalSince(start), 30, "the whole sweep")
    }
}
