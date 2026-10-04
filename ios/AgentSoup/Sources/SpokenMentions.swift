// Spoken mentions (jxn #1731, like the web's `spoken` in src/html.ts): dictating "at agents", "at vedu", "at vedu's
// agent", "at my agent" or an agent's name ("at jarvis") puts real @mentions in the message box, for this board's
// members only. Names match loosely by sound ("at vito" still finds vedu), but only when one is clearly closest, and
// everyday words after "at" ("at noon", "look at this", "not at all") are left alone. From review #1753: "'s" only means
// an agent right before agent/assistant ("look at ann's draft" stays as said), and handles under 5 letters match only
// as the same word or the same sound ("at and then" never becomes @ann). Pure, so AtteoTests checks it against the
// web's cases (test/browser/dictation-mentions.mjs).

import Foundation

struct SpokenMentions: Equatable {
    /// You (your handle).
    let me: String
    /// The other members' handles.
    let others: [String]
    /// What members named their agents, owner → name (names two agents share are left out: "@name" can't reach them).
    let agentNames: [String: String]
    /// Members' display names (only for the recognizer's hints).
    var displayNames: [String] = []

    init(me: String, members: [String], agentNames: [String: String] = [:], displayNames: [String] = []) {
        self.me = me
        var seen = Set<String>()
        // The groups are spoken as groups (a member literally named "agents" can't be told apart, like the web).
        self.others = members.filter { $0 != me && !Self.groups.contains($0) && seen.insert($0).inserted }
        self.agentNames = agentNames.filter { !$0.value.isEmpty }
        self.displayNames = displayNames
    }

    private static let groups: Set<String> = ["agents", "humans", "all"]

    /// What to tell the recognizer to listen for (SFSpeechRecognitionRequest.contextualStrings).
    var hints: [String] {
        var seen = Set<String>()
        let all = ["@agents", "@humans", "@all"] + others + others.compactMap { agentNames[$0] } + displayNames
        return all.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
    }

    // MARK: - The web's rules

    static let skip: Set<String> = Set("a an the this that these those it its me you him her us them my your his our their all least last first once home work noon night school lunch dinner some any every each about around which what how one two three four five six seven eight nine ten".split(separator: " ").map(String.init))

    /// "at <word>", its "s" or "'s", and "agent"/"assistant" after it (JS \w is ASCII, so spelled out here).
    private static let re = try! NSRegularExpression(pattern: #"\bat\s+([A-Za-z][A-Za-z0-9_.\-]*?)(['’]?s)?(?:\s+(agent|assistant)\b)?(?=[\s,.!?;:]|$)"#, options: [.caseInsensitive])

    /// A rough sound of a word: d=t, b=p, g=q=k, z=s, ph=f, and no vowels (or h, w, y) after the first letter.
    static func sound(_ w: String) -> String {
        var s = String(String.UnicodeScalarView(w.lowercased().unicodeScalars.filter { $0.value >= 97 && $0.value <= 122 }))
        s = s.replacingOccurrences(of: "ph", with: "f").replacingOccurrences(of: "d", with: "t").replacingOccurrences(of: "b", with: "p")
            .replacingOccurrences(of: "g", with: "k").replacingOccurrences(of: "q", with: "k").replacingOccurrences(of: "z", with: "s")
        guard let first = s.first else { return "" }
        let rest = s.dropFirst().filter { !"aeiouyhw".contains($0) }
        var out = ""
        for c in String(first) + rest where out.last != c { out.append(c) }
        return out
    }

    /// Edit distance.
    static func lev(_ a: String, _ b: String) -> Int {
        let a = Array(a.utf16), b = Array(b.utf16)
        var d = Array(0...b.count)
        guard !a.isEmpty else { return b.count }
        for i in 1...a.count {
            var p = d[0]
            d[0] = i
            for j in stride(from: 1, through: b.count, by: 1) {
                let t = d[j]
                d[j] = min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] == b[j - 1] ? 0 : 1))
                p = t
            }
        }
        return d[b.count]
    }

    /// A candidate: what's matched against the spoken word, and what goes after the "@".
    struct Candidate: Equatable { let name: String; let ins: String }

    /// The one candidate clearly closest to a spoken word: the same word, else the same sound, else (names of 5+
    /// letters) one letter off, or two for 6+. Nil when nothing is close or two different ones are equally close.
    static func closest(_ w: String, _ cands: [Candidate]) -> Candidate? {
        guard w.utf16.count >= 2, !skip.contains(w) else { return nil }
        let sw = sound(w)
        var best: Candidate?
        var bs = 9
        var tie = false
        for c in cands {
            let n = c.name.lowercased(), sn = sound(n), len = n.utf16.count
            let sc = w == n ? 0 : sw == sn && sn.utf16.count >= 2 ? 1 : len >= 5 && lev(w, n) <= (len >= 6 ? 2 : 1) ? 2 : 9
            if sc < bs { bs = sc; best = c; tie = false } else if sc == bs, sc < 9, best?.ins != c.ins { tie = true }
        }
        return bs < 9 && !tie ? best : nil
    }

    /// The dictated text with its spoken mentions made real ("at vedu can you look" → "@vedu can you look").
    func apply(_ text: String) -> String {
        guard text.range(of: #"\bat\s"#, options: [.regularExpression, .caseInsensitive]) != nil else { return text }
        let people = [Candidate(name: me, ins: me)] + others.map { Candidate(name: $0, ins: $0) }
        var agentOf: [String: String] = [me: "\(me)'s agent"] // yours is always "<you>'s agent", as on the web
        var names: [Candidate] = []
        for u in others {
            if let n = agentNames[u] { agentOf[u] = n; names.append(Candidate(name: n, ins: n)) } else { agentOf[u] = "\(u)'s agent" }
        }
        let otherPeople = Array(people.dropFirst())
        let ns = text as NSString
        let out = NSMutableString(string: text)
        for m in Self.re.matches(in: text, range: NSRange(location: 0, length: ns.length)).reversed() {
            func group(_ i: Int) -> String? { m.range(at: i).location == NSNotFound ? nil : ns.substring(with: m.range(at: i)) }
            let all = ns.substring(with: m.range), w = group(1) ?? "", suf = group(2), ag = group(3)
            let l = w.lowercased()
            let tok = (String(all.dropFirst(2)).trimmingCharacters(in: .whitespacesAndNewlines).split(whereSeparator: \.isWhitespace).first.map(String.init) ?? "")
                .lowercased().replacingOccurrences(of: #"['’]s$"#, with: "", options: .regularExpression)
            let said: String? = {
                if ag != nil && tok == "my" { return agentOf[me] }
                if Self.skip.contains(tok) { return nil }
                if ag == nil {
                    if l == "agent" || l == "assistant" { return "agents" }
                    if l == "human" || l == "people" { return "humans" }
                    if l == "everyone" || l == "everybody" { return "all" }
                }
                if ag == nil, let suf, suf.contains("'") || suf.contains("’") { return nil } // "look at ann's draft"
                if ag != nil {
                    guard let who = Self.closest(l, people) else { return nil }
                    return agentOf[who.ins]
                }
                let word = suf != nil ? l + "s" : l // "at chris": the s is part of the name
                return Self.closest(word, otherPeople + names)?.ins
            }()
            if let said { out.replaceCharacters(in: m.range, with: "@" + said) }
        }
        return out as String
    }
}
