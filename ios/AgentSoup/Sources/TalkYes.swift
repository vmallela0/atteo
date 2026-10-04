// Talk to Atteo's spoken yes (#1761): what the person said back to "approve this?" or "post this to your agent?".
// Pure Foundation on purpose (no app types), so it can be checked on its own with swiftc.
//   yes:     a short (6 words or fewer; 8 characters or fewer in Chinese or Japanese, written without spaces), plain,
//            unqualified yes: "yes", "go ahead", "approve it", "네", "oui", "हाँ", "sí", "はい", "好的"…
//   no:      a no word, or the opposite decision ("deny it" while an approve waits): the confirm is dropped.
//   unclear: anything else (a hedge, a condition, a question): the confirm stays and the on-screen Yes/No with it.
// The app's languages (en, ko, fr, hi, es, ja, zh) all count, whichever one the app is in: people answer in their own.

import Foundation

enum TalkYes {
    enum Verdict: Equatable { case yes, no, unclear }

    /// A plain yes and no, and the hedges that make a yes not a yes, in the app's other languages. Regexes over
    /// `words(said)` (" word word "): space-separated languages match whole words (" (…) "), Chinese and Japanese
    /// anywhere. A no is checked before a hedge, and a hedge before a yes ("不是", "但是" and "いいえ" hold a yes's
    /// characters).
    static let languages: [(yes: String, no: String, hedge: String)] = [
        // Korean: the yes words alone ("네", "네네", "예 보내 주세요"); hedges and nos anywhere (they take endings).
        (yes: " (네|예|응)+ ", no: "아니|취소|하지 ?마", hedge: "근데|먼저|하지만|잠깐|나중에|만약|까요"),
        // French
        (yes: " (oui|d'accord|vas y|allez y) ", no: " (non|attends|attendez|annule|annuler|arrête) ",
         hedge: " (mais|d'abord|si|plus tard|seulement|peut être|est ce) "),
        // Hindi
        (yes: " (हाँ|हां|ठीक है) ", no: " (नहीं|नही|रुको|मत|रद्द) ", hedge: " (लेकिन|पहले|पर|क्या|बाद में|अगर|शायद) "),
        // Spanish ("si" without its accent is "if": only "sí" is a yes)
        (yes: " (sí|vale|adelante) ", no: " (no|espera|cancela) ",
         hedge: " (pero|primero|si|después|luego|solo|quizás|tal vez|antes) "),
        // Japanese (no うん: it's inside ううん, a no)
        (yes: "はい|お願い", no: "いいえ|待って|やめて|キャンセル|だめ|ダメ", hedge: "でも|まず|けど|あとで|後で|ちょっと|ですか|ますか"),
        // Chinese, simplified and traditional
        (yes: "是|好|对|對|可以|确认|確認", no: "不|别|別|等等|取消|算了",
         hedge: "但是|先|吗|嗎|还是|還是|等一下|以后|以後|如果|呢"),
    ]

    /// `decision`: approve | deny | post.
    static func verdict(_ said: String, to decision: String) -> Verdict {
        if saysNo(said, to: decision) { return .no }
        return saysYes(said, to: decision) ? .yes : .unclear
    }

    static func saysYes(_ said: String, to decision: String) -> Bool {
        if said.contains("?") || said.contains("？") || said.contains("¿") { return false } // a question isn't a yes
        let t = words(said)
        let n = t.split(separator: " ").count
        guard n > 0, n <= 6 else { return false }
        // Chinese and Japanese go without spaces: 8 characters at most.
        if t.range(of: #"[\p{Han}\p{Hiragana}\p{Katakana}]"#, options: .regularExpression) != nil,
           t.filter({ $0 != " " }).count > 8 { return false }
        if saysNo(said, to: decision) { return false }
        if t.range(of: #"^ (what|why|how|should|can|could|is|does|did|will|would|are|am) "#, options: .regularExpression) != nil { return false }
        if t.range(of: #" (but|first|wait|no|not|hold on|later|unless|if|until|after|before|only|maybe|instead) "#, options: .regularExpression) != nil { return false }
        if languages.contains(where: { t.range(of: $0.hedge, options: .regularExpression) != nil }) { return false }
        let mine = switch decision {
        case "deny": "deny|deny it|reject|reject it"
        case "post": "send it|post it"
        default: "approve|approve it"
        }
        if t.range(of: " (yes|yeah|yep|yup|sure|confirm|confirmed|correct|absolutely|go ahead|do it|\(mine)) ", options: .regularExpression) != nil { return true }
        return languages.contains { t.range(of: $0.yes, options: .regularExpression) != nil }
    }

    /// A no, or the opposite decision ("deny it" while an approve waits).
    static func saysNo(_ said: String, to decision: String) -> Bool {
        let other = switch decision {
        case "deny": "approve"
        case "post": "don't send|dont send|don't post|dont post"
        default: "deny|reject"
        }
        let t = words(said)
        if t.range(of: " (no|nope|nah|don't|dont|do not|cancel|never mind|stop|\(other)) ", options: .regularExpression) != nil { return true }
        return languages.contains { t.range(of: $0.no, options: .regularExpression) != nil }
    }

    /// Lowercase words between spaces, in any script (letters and their marks: Devanagari's vowel signs, accents);
    /// curly apostrophes as straight ones ("don’t" is "don't"), a hyphen as a space ("vas-y" is "vas y"), and
    /// composed accents ("sí" however it was typed).
    static func words(_ s: String) -> String {
        let t = s.precomposedStringWithCanonicalMapping.lowercased()
            .replacingOccurrences(of: "\u{2019}", with: "'").replacingOccurrences(of: "\u{2018}", with: "'")
        let w = t.replacingOccurrences(of: #"[^\p{L}\p{M}' ]"#, with: " ", options: .regularExpression)
            .split(separator: " ").joined(separator: " ")
        return " " + w + " "
    }
}
