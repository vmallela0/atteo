// Talk to Atteo's spoken yes (#1761): what the person said back to "approve this?" or "post this to your agent?".
// Pure Foundation on purpose (no app types), so it can be checked on its own with swiftc.
//   yes:     a short (6 words or fewer), plain, unqualified yes: "yes", "yeah", "sure", "go ahead", "approve it"…
//   no:      a no word, or the opposite decision ("deny it" while an approve waits): the confirm is dropped.
//   unclear: anything else (a hedge, a condition, a question): the confirm stays and the on-screen Yes/No with it.

import Foundation

enum TalkYes {
    enum Verdict: Equatable { case yes, no, unclear }

    /// `decision`: approve | deny | post.
    static func verdict(_ said: String, to decision: String) -> Verdict {
        if saysNo(said, to: decision) { return .no }
        return saysYes(said, to: decision) ? .yes : .unclear
    }

    static func saysYes(_ said: String, to decision: String) -> Bool {
        if said.contains("?") || said.contains("？") { return false } // a question isn't a yes
        let t = words(said)
        let n = t.split(separator: " ").count
        guard n > 0, n <= 6 else { return false }
        if saysNo(said, to: decision) { return false }
        if t.range(of: #"^ (what|why|how|should|can|could|is|does|did|will|would|are|am) "#, options: .regularExpression) != nil { return false }
        if t.range(of: #" (but|first|wait|no|not|hold on|later|unless|if|until|after|before|only|maybe|instead) "#, options: .regularExpression) != nil { return false }
        let mine = switch decision {
        case "deny": "deny|deny it|reject|reject it"
        case "post": "send it|post it"
        default: "approve|approve it"
        }
        return t.range(of: " (yes|yeah|yep|yup|sure|confirm|confirmed|correct|absolutely|go ahead|do it|\(mine)) ", options: .regularExpression) != nil
    }

    /// A no, or the opposite decision ("deny it" while an approve waits).
    static func saysNo(_ said: String, to decision: String) -> Bool {
        let other = switch decision {
        case "deny": "approve"
        case "post": "don't send|dont send|don't post|dont post"
        default: "deny|reject"
        }
        return words(said).range(of: " (no|nope|nah|don't|dont|do not|cancel|never mind|stop|\(other)) ", options: .regularExpression) != nil
    }

    /// Lowercase words between spaces; curly apostrophes as straight ones ("don’t" is "don't").
    static func words(_ s: String) -> String {
        let t = s.lowercased().replacingOccurrences(of: "\u{2019}", with: "'").replacingOccurrences(of: "\u{2018}", with: "'")
        let w = t.replacingOccurrences(of: #"[^a-z' ]"#, with: " ", options: .regularExpression)
            .split(separator: " ").joined(separator: " ")
        return " " + w + " "
    }
}
