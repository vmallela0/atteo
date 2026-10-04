// Syntax colours for a fenced code block (jxn #2015), the web's exactly: a port of its tokenizer (src/codecolor.ts,
// hlTokens) with the same languages, aliases, token kinds and colours, so a block looks the same on both. The web
// matches one regex per language; here each of its rules is a small hand-written matcher tried in the same order at
// each position, which gives the same tokens (AtteoTests checks them against the web's output) but always in linear
// time, with the web's bounds (strings 1,000 characters, keys 64, look-aheads 200, spaces 8: #2028), and an unclosed
// string's scan remembered. An unknown or missing language stays plain, as does a block over 4,000 characters
// (claude #2029); an unclosed string can't
// swallow the rest. Only colours (and italics for comments, a tint for diff lines) are set, so the block's monospace
// font, selection and Copy (the plain text) are unchanged.

import SwiftUI

/// The web's token classes (sx-k, sx-s, …): keyword, string, comment, number or literal, function call, type,
/// key/property/attribute, tag, meta (decorators, variables, preprocessor, diff hunks), diff inserted/deleted lines.
enum SyntaxKind: String, Hashable {
    case keyword = "k", string = "s", comment = "c", number = "n", function = "f", type = "t", property = "p", tag = "g"
    case meta = "m", inserted = "i", deleted = "d"
}

/// The web's --sx-* colours (each at least 4.5:1 on the code background), light and dark.
enum SyntaxPalette {
    private static func hex(_ v: UInt32) -> UIColor {
        UIColor(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
    private static func pair(_ light: UInt32, _ dark: UInt32) -> Color { Color(light: hex(light), dark: hex(dark)) }

    static func color(_ k: SyntaxKind) -> Color {
        switch k {
        case .keyword: return pair(0xc4202e, 0xff7b72)
        case .string: return pair(0x0a3069, 0xa5d6ff)
        case .comment: return pair(0x5f6670, 0x8b949e)
        case .number: return pair(0x0550ae, 0x79c0ff)
        case .function: return pair(0x7340c8, 0xd2a8ff)
        case .type: return pair(0x8a3300, 0xffa657)
        case .property, .tag: return pair(0x116329, 0x7ee787)
        case .meta: return pair(0x6b40b5, 0xd2a8ff)
        case .inserted: return pair(0x116329, 0x7ee787)
        case .deleted: return pair(0xa40e26, 0xffa198)
        }
    }
    /// Diff lines sit on a tint.
    static func background(_ k: SyntaxKind) -> Color? {
        switch k {
        case .inserted: return pair(0xdafbe1, 0x12261e)
        case .deleted: return pair(0xffebe9, 0x2d1215)
        default: return nil
        }
    }
}

enum SyntaxHighlight {
    /// Longer blocks stay plain (UTF-16 length, as on the web's MAX).
    static let maxLength = 4_000

    /// A fence's language → the tokenizer's (the web's HL_ALIAS).
    static let aliases: [String: String] = [
        "js": "js", "javascript": "js", "mjs": "js", "cjs": "js", "jsx": "js", "node": "js", "ts": "js", "typescript": "js", "tsx": "js", "mts": "js", "cts": "js",
        "json": "json", "jsonc": "json", "json5": "json", "py": "py", "python": "py", "python3": "py",
        "sh": "sh", "bash": "sh", "zsh": "sh", "shell": "sh", "console": "sh", "shellsession": "sh", "terminal": "sh", "fish": "sh",
        "go": "go", "golang": "go", "rs": "rs", "rust": "rs", "swift": "swift",
        "java": "java", "kotlin": "java", "kt": "java", "kts": "java", "scala": "java", "dart": "java", "cs": "java", "csharp": "java", "c#": "java", "groovy": "java",
        "c": "c", "h": "c", "cpp": "c", "c++": "c", "cc": "c", "hpp": "c", "cxx": "c", "objc": "c", "objective-c": "c", "php": "php", "rb": "rb", "ruby": "rb",
        "sql": "sql", "sqlite": "sql", "postgres": "sql", "postgresql": "sql", "psql": "sql", "mysql": "sql", "plsql": "sql", "yaml": "yaml", "yml": "yaml",
        "toml": "toml", "ini": "toml", "cfg": "toml", "conf": "toml", "env": "toml", "dotenv": "toml", "properties": "toml",
        "css": "css", "scss": "css", "less": "css", "sass": "css",
        "html": "html", "htm": "html", "xml": "html", "svg": "html", "vue": "html", "xhtml": "html", "plist": "html", "diff": "diff", "patch": "diff",
    ]

    /// The tokenizer for a fence's language, or nil: not one we colour (a plain dictionary lookup).
    static func language(_ name: String?) -> String? {
        guard let n = name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !n.isEmpty else { return nil }
        return aliases[n]
    }

    /// The code block's accessibility value: "highlighted: swift" when it's coloured, else empty (for UI tests).
    static func accessibilityValue(_ name: String?, code: String) -> String {
        guard language(name) != nil, code.utf16.count <= maxLength, let n = name else { return "" }
        let value: String = "highlighted: " + n.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return value
    }

    /// The coloured runs: (kind, scalar offsets), in order. Empty for an unknown language or a block over maxLength.
    /// `cap` is for tests that time the tokenizer on longer input.
    static func runs(_ code: String, _ name: String?, cap: Int = maxLength) -> [(kind: SyntaxKind, range: Range<Int>)] {
        guard let lang = language(name), code.utf16.count <= cap else { return [] }
        var lx = Lexer(Array(code.unicodeScalars))
        if lang == "diff" { lx.diff() } else if let spec = LangSpec.all[lang] { lx.run(spec) }
        return lx.runs
    }

    /// The coloured stretches as text, in order (for tests).
    static func tokens(_ code: String, _ name: String?) -> [(kind: SyntaxKind, text: String)] {
        let s = Array(code.unicodeScalars)
        return runs(code, name).map { ($0.kind, text(s, $0.range)) }
    }

    static func text(_ s: [Unicode.Scalar], _ r: Range<Int>) -> String {
        var v = String.UnicodeScalarView()
        v.append(contentsOf: s[r])
        return String(v)
    }

    private final class Box { let value: AttributedString; init(_ v: AttributedString) { value = v } }
    private static let cache: NSCache<NSString, Box> = { let c = NSCache<NSString, Box>(); c.countLimit = 300; return c }()

    /// The code with its colours: foreground colours, italic comments and tinted diff lines; the view's font and
    /// default colour apply to the rest. Cached: a message re-renders often.
    static func attributed(_ code: String, language name: String?) -> AttributedString {
        guard language(name) != nil, code.utf16.count <= maxLength else { return AttributedString(code) }
        let key = "\(name ?? "")\u{0}\(code)" as NSString
        if let hit = cache.object(forKey: key) { return hit.value }
        let s = Array(code.unicodeScalars)
        var out = AttributedString()
        var at = 0
        for run in runs(code, name) {
            if run.range.lowerBound > at { out.append(AttributedString(text(s, at..<run.range.lowerBound))) }
            var piece = AttributedString(text(s, run.range))
            piece.foregroundColor = SyntaxPalette.color(run.kind)
            if run.kind == .comment { piece.inlinePresentationIntent = .emphasized }
            if let bg = SyntaxPalette.background(run.kind) { piece.backgroundColor = bg }
            out.append(piece)
            at = run.range.upperBound
        }
        if at < s.count { out.append(AttributedString(text(s, at..<s.count))) }
        cache.setObject(Box(out), forKey: key)
        return out
    }
}

// MARK: - Languages (the web's HL_LANGS)

/// One of the web's regex alternatives, by what it matches.
enum Rule {
    case lineComment // //…
    case blockComment // /* … */ (or to the end)
    case hashComment // # … at the start or after a space (the space included)
    case hashAny // # … anywhere
    case dashComment // -- …
    case dq, sq, bt // "…" and '…' on one line, `…` across lines (or to the end)
    case tri // """…""" or '''…''' (or to the end)
    case pyTri, pyQuote // the same with an optional r/b/u/f prefix
    case rustStr // b"…"
    case rustChar // 'x', '\n'
    case jsonKey // "key" before a colon
    case num // 12, 1.5e3, 10px
    case negNum // -1.5
    case cssNum // -.5em, 120%
    case rbSymbolOrNum // :name or a number
    case atDotted // @name.sub
    case atWord // @Name
    case atOrHash // @name, #if
    case shVar // ${…}, $x, $1, $@
    case rustMeta // #[derive], println!(
    case cDirective // #include at the start of a line
    case phpVar // $x
    case rbIvar // @x, @@x
    case yamlKey // key: at the start of a line
    case yamlMeta // &anchor, *alias, ---
    case iniComment // ; … at the start of a line
    case tomlTable // [section] at the start of a line
    case tomlKey // key =
    case cssHex // #fff
    case cssAt // @media, !important
    case cssProp // color: …;
    case htmlComment // <!-- … -->
    case htmlMeta // <!DOCTYPE …>, <?xml … ?>
    case htmlTag // <a href="x"> (split into tag, attribute names and values)
    case htmlEntity // &amp;
}

struct LangSpec {
    var rules: [(SyntaxKind, Rule)]
    var keywords: Set<String> = []
    var literals: Set<String> = []
    var types = false // a Capitalised name is a type
    var caseInsensitive = false

    private static func w(_ s: String) -> Set<String> { Set(s.split(separator: " ").map(String.init)) }

    static let all: [String: LangSpec] = [
        "js": LangSpec(rules: [(.comment, .lineComment), (.comment, .blockComment), (.string, .bt), (.string, .dq), (.string, .sq), (.number, .num), (.meta, .atDotted)],
                       keywords: w("break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await as implements interface type enum public private protected readonly declare namespace abstract keyof satisfies"),
                       literals: w("true false null undefined NaN Infinity"), types: true),
        "json": LangSpec(rules: [(.property, .jsonKey), (.string, .dq), (.comment, .lineComment), (.comment, .blockComment), (.number, .negNum)],
                         literals: w("true false null")),
        "py": LangSpec(rules: [(.string, .pyTri), (.comment, .hashAny), (.string, .pyQuote), (.number, .num), (.meta, .atDotted)],
                       keywords: w("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self"),
                       literals: w("True False None"), types: true),
        "sh": LangSpec(rules: [(.comment, .hashComment), (.string, .dq), (.string, .sq), (.meta, .shVar), (.number, .num)],
                       keywords: w("if then else elif fi for while until do done case esac in function return exit local export source echo cd set unset readonly shift sudo alias"),
                       literals: w("true false")),
        "go": LangSpec(rules: [(.comment, .lineComment), (.comment, .blockComment), (.string, .bt), (.string, .dq), (.string, .sq), (.number, .num)],
                       keywords: w("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
                       literals: w("true false nil iota"), types: true),
        "rs": LangSpec(rules: [(.comment, .lineComment), (.comment, .blockComment), (.string, .rustStr), (.string, .rustChar), (.number, .num), (.meta, .rustMeta)],
                       keywords: w("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while"),
                       literals: w("true false"), types: true),
        "swift": LangSpec(rules: [(.comment, .lineComment), (.comment, .blockComment), (.string, .tri), (.string, .dq), (.number, .num), (.meta, .atOrHash)],
                          keywords: w("associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch is super self Self throw throws try async await some any override mutating final lazy weak"),
                          literals: w("true false nil"), types: true),
        "java": LangSpec(rules: [(.comment, .lineComment), (.comment, .blockComment), (.string, .tri), (.string, .dq), (.string, .sq), (.number, .num), (.meta, .atWord)],
                         keywords: w("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws transient try void volatile while var val fun object when is in out override data sealed open internal companion lateinit suspend namespace using struct readonly async await get set string bool decimal def"),
                         literals: w("true false null"), types: true),
        "c": LangSpec(rules: [(.comment, .lineComment), (.comment, .blockComment), (.meta, .cDirective), (.string, .dq), (.string, .sq), (.number, .num)],
                      keywords: w("auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected virtual override new delete this using constexpr bool"),
                      literals: w("true false NULL nullptr"), types: true),
        "php": LangSpec(rules: [(.comment, .lineComment), (.comment, .blockComment), (.comment, .hashComment), (.string, .dq), (.string, .sq), (.meta, .phpVar), (.number, .num)],
                        keywords: w("abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global if implements include instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while yield"),
                        literals: w("true false null TRUE FALSE NULL"), types: true),
        "rb": LangSpec(rules: [(.comment, .hashAny), (.string, .dq), (.string, .sq), (.number, .rbSymbolOrNum), (.meta, .rbIvar)],
                       keywords: w("alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require attr_accessor attr_reader puts"),
                       literals: w("true false nil"), types: true),
        "sql": LangSpec(rules: [(.comment, .dashComment), (.comment, .blockComment), (.string, .sq), (.property, .dq), (.number, .num)],
                        keywords: w("select from where and or not insert into values update set delete create table index view drop alter add column join left right inner outer full cross on as group by order having limit offset distinct union all in is like between case when then else end primary key foreign references default unique check constraint with returning asc desc exists if begin commit rollback transaction integer text real blob varchar char int bigint boolean date timestamp autoincrement replace pragma explain"),
                        literals: w("true false null"), caseInsensitive: true),
        "yaml": LangSpec(rules: [(.comment, .hashComment), (.property, .yamlKey), (.string, .dq), (.string, .sq), (.number, .num), (.meta, .yamlMeta)],
                         literals: w("true false null yes no on off ~")),
        "toml": LangSpec(rules: [(.comment, .hashComment), (.comment, .iniComment), (.type, .tomlTable), (.property, .tomlKey), (.string, .tri), (.string, .dq), (.string, .sq), (.number, .num)],
                         literals: w("true false")),
        "css": LangSpec(rules: [(.comment, .blockComment), (.comment, .lineComment), (.string, .dq), (.string, .sq), (.number, .cssHex), (.keyword, .cssAt), (.property, .cssProp), (.number, .cssNum)]),
        "html": LangSpec(rules: [(.comment, .htmlComment), (.meta, .htmlMeta), (.tag, .htmlTag), (.meta, .htmlEntity)]),
    ]
}

// MARK: - The scanner

struct Lexer {
    let s: [Unicode.Scalar]
    let n: Int
    var runs: [(kind: SyntaxKind, range: Range<Int>)] = []
    /// The last quoted string's scan, per quote character (see quoted).
    private struct QuotePath { let start: Int; let stop: Int; let closes: Bool; let cum: [Int] }
    private var quotePaths: [UInt32: QuotePath] = [:]

    init(_ s: [Unicode.Scalar]) { self.s = s; n = s.count }

    private mutating func add(_ k: SyntaxKind, _ lo: Int, _ hi: Int) {
        let hi = min(hi, n)
        if hi > lo { runs.append((k, lo..<hi)) }
    }

    // Character classes as JavaScript regexes see them (no "u" flag: \w and \d are ASCII).
    static func isW(_ c: Unicode.Scalar) -> Bool {
        let v = c.value
        return (v >= 48 && v <= 57) || (v >= 65 && v <= 90) || (v >= 97 && v <= 122) || v == 95
    }
    static func isD(_ c: Unicode.Scalar) -> Bool { c.value >= 48 && c.value <= 57 }
    static func isS(_ c: Unicode.Scalar) -> Bool {
        switch c.value {
        case 9...13, 32, 0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff: return true
        default: return false
        }
    }
    /// "." without the s flag: anything but a line break.
    static func isDot(_ c: Unicode.Scalar) -> Bool { !(c == "\n" || c == "\r" || c.value == 0x2028 || c.value == 0x2029) }
    static func isIdStart(_ c: Unicode.Scalar) -> Bool {
        let v = c.value
        return (v >= 65 && v <= 90) || (v >= 97 && v <= 122) || v == 95 || v == 36
    }
    static func isId(_ c: Unicode.Scalar) -> Bool { isW(c) || c == "$" }

    private func at(_ i: Int, _ p: String) -> Bool {
        var j = i
        for c in p.unicodeScalars {
            guard j < n, s[j] == c else { return false }
            j += 1
        }
        return true
    }
    private func find(_ p: String, from i: Int) -> Int? {
        guard let first = p.unicodeScalars.first else { return nil }
        var j = i
        while j < n {
            if s[j] == first, at(j, p) { return j }
            j += 1
        }
        return nil
    }
    private func lineEnd(_ i: Int) -> Int {
        var j = i
        while j < n, s[j] != "\n" { j += 1 }
        return j
    }
    private func run(_ i: Int, _ ok: (Unicode.Scalar) -> Bool) -> Int {
        var j = i
        while j < n, ok(s[j]) { j += 1 }
        return j
    }
    /// \b before position i, when s[i] is a word character.
    private func wordStart(_ i: Int) -> Bool { i == 0 || !Self.isW(s[i - 1]) }

    // MARK: The rules

    /// A quoted string on one line, `"(?:\\.|[^"\\\n]){0,1000}"`: its end, or nil if it doesn't close within 1,000
    /// UTF-16 units (as on the web). A quote met inside an earlier scan is one of its escaped characters, so its own
    /// scan follows the same path from there: the path is kept (where it stops, whether that's the closing quote, the
    /// units used up to each point), so a line of escaped quotes stays linear instead of rescanning 1,000 units each.
    private mutating func quoted(_ i: Int, _ q: Unicode.Scalar) -> Int? {
        guard i < n, s[i] == q else { return nil }
        if let p = quotePaths[q.value], i > p.start, i < p.stop {
            guard p.closes else { return nil }
            let used = p.cum[p.stop - p.start - 1] - p.cum[i - p.start]
            return used <= 1000 ? p.stop + 1 : nil
        }
        var cum = [0] // units used before position i + 1 + k
        var j = i + 1, units = 0, closes = false
        while j < n {
            let c = s[j]
            if c == q { closes = true; break }
            if c == "\n" { break }
            if c == "\\" {
                guard j + 1 < n, Self.isDot(s[j + 1]) else { break }
                cum.append(units)
                units += s[j + 1].utf16.count // "\\." and, for a character outside the BMP, its second half
                cum.append(units)
                j += 2
                continue
            }
            units += c.utf16.count
            cum.append(units)
            j += 1
        }
        let path = QuotePath(start: i, stop: j, closes: closes, cum: cum)
        quotePaths[q.value] = path
        return closes && cum[j - i - 1] <= 1000 ? j + 1 : nil
    }

    /// `"""[\s\S]*?(?:"""|$)` or the ''' one.
    private func triple(_ i: Int) -> Int? {
        guard i + 2 < n else { return nil }
        let q = s[i]
        guard (q == "\"" || q == "'"), s[i + 1] == q, s[i + 2] == q else { return nil }
        let close = q == "\"" ? "\"\"\"" : "'''"
        return find(close, from: i + 3).map { $0 + 3 } ?? n
    }

    /// `\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\w*`, with the \b check done by the caller when it has a prefix.
    private func number(_ i: Int, boundary: Bool = true) -> Int? {
        guard i < n, Self.isD(s[i]), !boundary || wordStart(i) else { return nil }
        var j = run(i, Self.isD)
        if j + 1 < n, s[j] == ".", Self.isD(s[j + 1]) { j = run(j + 1, Self.isD) }
        if j < n, s[j] == "e" || s[j] == "E" {
            var k = j + 1
            if k < n, s[k] == "+" || s[k] == "-" { k += 1 }
            if k < n, Self.isD(s[k]) { j = run(k, Self.isD) }
        }
        return run(j, Self.isW)
    }

    /// `(?:^|\n)[ \t]*`: where the rest may start, at the start of the code or just after a line break.
    private func lineStarts(_ i: Int) -> [Int] {
        var out: [Int] = []
        if i == 0 { out.append(run(0) { $0 == " " || $0 == "\t" }) }
        if i < n, s[i] == "\n" { out.append(run(i + 1) { $0 == " " || $0 == "\t" }) }
        return out
    }

    /// Python's optional \b[rRbBuUfF]{1,2} before a string.
    private mutating func prefixed(_ i: Int, _ body: (inout Lexer, Int) -> Int?) -> Int? {
        let isPrefix: (Unicode.Scalar) -> Bool = { "rRbBuUfF".unicodeScalars.contains($0) }
        if i < n, isPrefix(s[i]), wordStart(i) {
            let count = i + 1 < n && isPrefix(s[i + 1]) ? 2 : 1
            for len in stride(from: count, through: 1, by: -1) {
                if let e = body(&self, i + len) { return e }
            }
        }
        return body(&self, i)
    }

    /// A run of `ok` characters from i of 1 to `max` characters ({1,64}): its end, or nil when it's longer (the next
    /// character would be one of them, so no shorter run can satisfy what follows either) or empty.
    private func bounded(_ i: Int, _ max: Int, _ ok: (Unicode.Scalar) -> Bool) -> Int? {
        var j = i
        while j < n, ok(s[j]) {
            j += 1
            if j - i > max { return nil }
        }
        return j > i ? j : nil
    }
    /// Up to 8 spaces or tabs, then `c`: the position just past it.
    private func spacesThen(_ e: Int, _ c: Unicode.Scalar) -> Int? {
        var k = e
        while k < n, k - e < 8, s[k] == " " || s[k] == "\t" { k += 1 }
        return k < n && s[k] == c ? k + 1 : nil
    }

    /// `\[[^\]\n]{0,200}\]` from the "[" at j: the end, past the "]".
    private func bracket(_ j: Int) -> Int? {
        var k = j + 1
        while k < n, k - j - 1 <= 200, s[k] != "]", s[k] != "\n" { k += 1 }
        return k < n && k - j - 1 <= 200 && s[k] == "]" ? k + 1 : nil
    }

    /// `(?=[ \t]{0,8}:[^;{}\n]{0,200}[;})\n])` after a CSS name that ends at e.
    private func cssPropertyFollows(_ e: Int) -> Bool {
        guard let from = spacesThen(e, ":") else { return false }
        var j = from
        while j < n, j - from <= 200 {
            let c = s[j]
            if c == ")" || c == ";" || c == "}" || c == "\n" { return true }
            if c == "{" { return false }
            j += 1
        }
        return false
    }

    private mutating func match(_ rule: Rule, _ i: Int) -> Int? {
        let c = s[i]
        switch rule {
        case .lineComment:
            return at(i, "//") ? lineEnd(i) : nil
        case .blockComment:
            guard at(i, "/*") else { return nil }
            return find("*/", from: i + 2).map { $0 + 2 } ?? n
        case .hashComment:
            if i == 0, c == "#" { return lineEnd(i) }
            if Self.isS(c), i + 1 < n, s[i + 1] == "#" { return lineEnd(i + 1) }
            return nil
        case .hashAny:
            return c == "#" ? lineEnd(i) : nil
        case .dashComment:
            return at(i, "--") ? lineEnd(i) : nil
        case .dq: return quoted(i, "\"")
        case .sq: return quoted(i, "'")
        case .bt:
            guard c == "`" else { return nil }
            var j = i + 1
            while j < n {
                if s[j] == "\\" { if j + 1 < n { j += 2; continue } else { return j } }
                if s[j] == "`" { return j + 1 }
                j += 1
            }
            return n
        case .tri: return triple(i)
        case .pyTri: return prefixed(i) { lx, j in j < lx.n ? lx.triple(j) : nil }
        case .pyQuote: return prefixed(i) { lx, j in lx.quoted(j, "\"") ?? lx.quoted(j, "'") }
        case .rustStr:
            if c == "b", let e = quoted(i + 1, "\"") { return e }
            return quoted(i, "\"")
        case .rustChar:
            guard c == "'", i + 2 < n else { return nil }
            let d = s[i + 1]
            // One UTF-16 unit, as the web's regex sees it: a character outside the BMP never fits.
            if d == "\\" { return i + 3 < n && Self.isDot(s[i + 2]) && s[i + 2].value <= 0xffff && s[i + 3] == "'" ? i + 4 : nil }
            return d != "'" && d != "\n" && d.value <= 0xffff && s[i + 2] == "'" ? i + 3 : nil
        case .jsonKey:
            guard let e = quoted(i, "\"") else { return nil }
            return spacesThen(e, ":") != nil ? e : nil
        case .num: return number(i)
        case .negNum:
            if c == "-" { return number(i + 1, boundary: false) }
            return number(i)
        case .cssNum:
            var j = i
            if j < n, s[j] == "-" { j += 1 }
            if j < n, s[j] == "." { j += 1 }
            guard var e = number(j, boundary: j == i) else { return nil }
            if e < n, s[e] == "%" { e += 1 }
            return e
        case .rbSymbolOrNum:
            if c == ":", i + 1 < n, Self.isW(s[i + 1]) { return run(i + 1, Self.isW) }
            return number(i)
        case .atDotted:
            guard c == "@", i + 1 < n, Self.isW(s[i + 1]) || s[i + 1] == "." else { return nil }
            return run(i + 1) { Self.isW($0) || $0 == "." }
        case .atWord:
            guard c == "@", i + 1 < n, Self.isW(s[i + 1]) else { return nil }
            return run(i + 1, Self.isW)
        case .atOrHash:
            guard c == "@" || c == "#", i + 1 < n, Self.isW(s[i + 1]) else { return nil }
            return run(i + 1, Self.isW)
        case .shVar:
            guard c == "$", i + 1 < n else { return nil }
            let d = s[i + 1]
            if d == "{" {
                var j = i + 2
                while j < n, j - i - 2 <= 200, s[j] != "}", s[j] != "\n" { j += 1 }
                if j < n, j - i - 2 <= 200, s[j] == "}" { return j + 1 }
            }
            if Self.isW(d) { return run(i + 1, Self.isW) }
            if "@#?*!$-".unicodeScalars.contains(d) { return i + 2 }
            return nil
        case .rustMeta:
            if c == "#" {
                var j = i + 1
                if j < n, s[j] == "!" { j += 1 }
                if j < n, s[j] == "[" { return bracket(j) }
                return nil
            }
            guard wordStart(i), let e = bounded(i, 64, Self.isW) else { return nil }
            return e + 1 < n && s[e] == "!" && "([{".unicodeScalars.contains(s[e + 1]) ? e + 1 : nil
        case .cDirective:
            for j in lineStarts(i) {
                guard j < n, s[j] == "#" else { continue }
                let k = run(j + 1) { $0 == " " || $0 == "\t" }
                if k < n, Self.isW(s[k]) { return run(k, Self.isW) }
            }
            return nil
        case .phpVar:
            guard c == "$", i + 1 < n, Self.isW(s[i + 1]) else { return nil }
            return run(i + 1, Self.isW)
        case .rbIvar:
            guard c == "@" else { return nil }
            var j = i + 1
            if j < n, s[j] == "@", j + 1 < n, Self.isW(s[j + 1]) { j += 1 }
            guard j < n, Self.isW(s[j]) else { return nil }
            return run(j, Self.isW)
        case .yamlKey:
            let key: (Unicode.Scalar) -> Bool = { Self.isW($0) || $0 == "." || $0 == "-" }
            for j0 in lineStarts(i) {
                var starts = [j0]
                if j0 + 1 < n, s[j0] == "-", s[j0 + 1] == " " { starts.insert(j0 + 2, at: 0) }
                for j in starts {
                    guard let e = bounded(j, 64, key), let k = spacesThen(e, ":") else { continue }
                    if k >= n || Self.isS(s[k]) { return e }
                }
            }
            return nil
        case .yamlMeta:
            if c == "&" || c == "*", i + 1 < n, Self.isW(s[i + 1]) || s[i + 1] == "-" { return run(i + 1) { Self.isW($0) || $0 == "-" } }
            return at(i, "---") ? i + 3 : nil
        case .iniComment:
            for j in lineStarts(i) where j < n && s[j] == ";" { return lineEnd(j) }
            return nil
        case .tomlTable:
            for j in lineStarts(i) where j < n && s[j] == "[" {
                if let e = bracket(j) { return e }
            }
            return nil
        case .tomlKey:
            let key: (Unicode.Scalar) -> Bool = { Self.isW($0) || $0 == "." || $0 == "-" }
            guard let e = bounded(i, 64, key), spacesThen(e, "=") != nil else { return nil }
            return e
        case .cssHex:
            guard c == "#" else { return nil }
            let e = run(i + 1) { $0.properties.isASCIIHexDigit }
            let len = e - i - 1
            return len >= 3 && len <= 8 && (e >= n || !Self.isW(s[e])) ? e : nil
        case .cssAt:
            if c == "@", i + 1 < n, Self.isW(s[i + 1]) || s[i + 1] == "-" { return run(i + 1) { Self.isW($0) || $0 == "-" } }
            if at(i, "!important"), i + 10 >= n || !Self.isW(s[i + 10]) { return i + 10 }
            return nil
        case .cssProp:
            // --?[\w-]{1,64} or \b[a-z][\w-]{0,63}, then the look-ahead.
            let name: (Unicode.Scalar) -> Bool = { Self.isW($0) || $0 == "-" }
            if c == "-" {
                if i + 1 < n, s[i + 1] == "-", let e = bounded(i + 2, 64, name), cssPropertyFollows(e) { return e }
                if let e = bounded(i + 1, 64, name), cssPropertyFollows(e) { return e }
                return nil
            }
            guard c.value >= 97, c.value <= 122, wordStart(i), let e = bounded(i, 64, name), cssPropertyFollows(e) else { return nil }
            return e
        case .htmlComment:
            guard at(i, "<!--") else { return nil }
            return find("-->", from: i + 4).map { $0 + 3 } ?? n
        case .htmlMeta:
            if at(i, "<!") {
                let e = run(i + 2) { $0 != ">" }
                return e < n ? e + 1 : e
            }
            if at(i, "<?") { return find("?>", from: i + 2).map { $0 + 2 } ?? n }
            return nil
        case .htmlTag:
            guard c == "<" else { return nil }
            var j = i + 1
            if j < n, s[j] == "/" { j += 1 }
            guard j < n, (s[j].value >= 65 && s[j].value <= 90) || (s[j].value >= 97 && s[j].value <= 122) else { return nil }
            j = run(j + 1) { Self.isW($0) || $0 == ":" || $0 == "." || $0 == "-" }
            while j < n {
                let d = s[j]
                if d == "\"" || d == "'" {
                    var k = j + 1
                    while k < n, s[k] != d { k += 1 }
                    if k >= n { break } // never closes: the tag ends before it
                    j = k + 1
                } else if d == ">" {
                    return j + 1
                } else { j += 1 }
            }
            return j
        case .htmlEntity:
            guard c == "&" else { return nil }
            var j = i + 1
            if j < n, s[j] == "#" { j += 1 }
            guard j < n, Self.isW(s[j]) else { return nil }
            let e = run(j, Self.isW)
            return e < n && s[e] == ";" ? e + 1 : nil
        }
    }

    /// A tag's parts (the web's hlTag): "<a" / "</a" / ">" / "/>" as the tag, names before "=" as attributes,
    /// quoted values as strings. Looks only inside the tag.
    private mutating func tagParts(_ lo: Int, _ hi: Int) {
        let name: (Unicode.Scalar) -> Bool = { Self.isW($0) || $0 == ":" || $0 == "." || $0 == "-" }
        var p = lo
        var runEnd = -1, runOK = false
        while p < hi {
            let c = s[p]
            if c == "<" {
                var j = p + 1
                if j < hi, s[j] == "/", j + 1 < hi, name(s[j + 1]) { j += 1 }
                if j < hi, name(s[j]) {
                    var e = j
                    while e < hi, name(s[e]) { e += 1 }
                    add(.tag, p, e); p = e; continue
                }
            }
            if c == "/", p + 1 < hi, s[p + 1] == ">" { add(.tag, p, p + 2); p += 2; continue }
            if c == ">" { add(.tag, p, p + 1); p += 1; continue }
            if name(c) {
                if p >= runEnd {
                    runEnd = p
                    while runEnd < hi, name(s[runEnd]) { runEnd += 1 }
                    var q = runEnd
                    while q < hi, Self.isS(s[q]) { q += 1 }
                    runOK = q < hi && s[q] == "="
                }
                if runOK { add(.property, p, runEnd); p = runEnd; continue }
            }
            if c == "\"" || c == "'" {
                var k = p + 1
                while k < hi, s[k] != c { k += 1 }
                if k < hi { add(.string, p, k + 1); p = k + 1; continue }
            }
            p += 1
        }
    }

    /// What a name is: keyword, literal, a call (an opening parenthesis within the next 40 characters, after spaces),
    /// a type (Capitalised, in languages with types), or plain.
    private func classify(_ lo: Int, _ hi: Int, _ spec: LangSpec) -> SyntaxKind? {
        let word = SyntaxHighlight.text(s, lo..<hi)
        let lower = spec.caseInsensitive ? word.lowercased() : word
        if spec.keywords.contains(lower) { return .keyword }
        if spec.literals.contains(lower) || spec.literals.contains(word) { return .number }
        var j = hi, units = 0
        while j < n, units < 40, Self.isS(s[j]) { units += s[j].utf16.count; j += 1 }
        if j < n, units < 40, s[j] == "(" { return .function }
        if spec.types, hi - lo >= 2 {
            let a = s[lo].value, b = s[lo + 1].value
            if a >= 65, a <= 90, (b >= 97 && b <= 122) || (b >= 48 && b <= 57), s[(lo + 2)..<hi].allSatisfy(Self.isW) { return .type }
        }
        return nil
    }

    mutating func run(_ spec: LangSpec) {
        var i = 0
        scan: while i < n {
            for (kind, rule) in spec.rules {
                if let e = match(rule, i), e > i {
                    if rule == .htmlTag { tagParts(i, e) } else { add(kind, i, e) }
                    i = e
                    continue scan
                }
            }
            if Self.isIdStart(s[i]) {
                let e = run(i, Self.isId)
                if let k = classify(i, e, spec) { add(k, i, e) }
                i = e
                continue
            }
            i += 1
        }
    }

    /// Diff: whole lines; "+++"/"---" headers and "@@" hunks are meta, "+" inserted, "-" deleted.
    mutating func diff() {
        var i = 0
        while i < n {
            let e = lineEnd(i)
            if e > i {
                let c = s[i]
                let header = (at(i, "+++") || at(i, "---")) && (i + 3 >= e || Self.isS(s[i + 3]))
                if header { add(.meta, i, e) } else if c == "+" { add(.inserted, i, e) } else if c == "-" { add(.deleted, i, e) } else if at(i, "@@") { add(.meta, i, e) }
            }
            i = e + 1
        }
    }
}

extension Rule: Equatable {}

extension CodeBlock {
    /// The language to colour by: none when the whole block is over the cap, even while it's folded to fewer lines
    /// (so it doesn't turn plain on "Show all", and stays plain where the web's is).
    func colourBy(_ code: String) -> String? { code.utf16.count <= SyntaxHighlight.maxLength ? language : nil }
}
