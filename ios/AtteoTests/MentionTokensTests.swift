// The message box's mentions as single units, like the web's chips (src/html.ts mtokens, jxn #2551), and the @ menu's
// options in the web's order with each agent session ("@jxn/opus-b"). Each case says what the web does with the same
// text, so the two behave the same.

import XCTest
@testable import Atteo

final class MentionTokensTests: XCTestCase {
    private let members: Set<String> = ["vedu", "jxn", "maya"]

    private func tokens(_ text: String, me: String? = "vedu", names: [String: String] = [:]) -> [NSRange] {
        ComposerField.mentions(in: text, members: members, me: me, agentNames: names).map(\.range)
    }

    private func sub(_ text: String, _ r: NSRange) -> String { (text as NSString).substring(with: r) }

    // MARK: Which runs are tokens (the web's mtokens)

    func testTokensMatchTheWeb() {
        let t = "hi @jxn and @jxn's agent, @jxn/opus-b @maya's assistant @agents @all"
        XCTAssertEqual(tokens(t).map { sub(t, $0) }, ["@jxn", "@jxn's agent", "@jxn/opus-b", "@maya's assistant", "@agents", "@all"])
    }

    func testYourOwnHandleIsNotAToken_butYourAgentIs() {
        let t = "@vedu and @vedu's agent and @vedu/scout"
        XCTAssertEqual(tokens(t).map { sub(t, $0) }, ["@vedu's agent", "@vedu/scout"], "the web skips a mention of yourself, not your agent")
    }

    func testUnknownNamesEmailsAndTrailingDotsAreNotTokens() {
        XCTAssertEqual(tokens("ask @nobody, or a@jxn.com").count, 0)
        let t = "thanks @jxn."
        XCTAssertEqual(tokens(t).map { sub(t, $0) }, ["@jxn"], "the dot isn't part of the name")
    }

    func testAgentNamesAreTokens() {
        let t = "@Jarvis can you"
        XCTAssertEqual(tokens(t, names: ["jarvis": "maya"]).map { sub(t, $0) }, ["@Jarvis"])
    }

    // MARK: Edits (Backspace and friends)

    func testBackspaceAtATokensEndTakesItWhole() {
        let t = "hi @jxn's agent"
        let toks = tokens(t)
        let end = (t as NSString).length
        // Backspace with the caret at the end arrives as the range of the last character.
        let grown = MentionTokens.expand(NSRange(location: end - 1, length: 1), tokens: toks)
        XCTAssertEqual(sub(t, grown), "@jxn's agent")
        let after = (t as NSString).replacingCharacters(in: grown, with: "")
        XCTAssertEqual(after, "hi ")
    }

    func testBackspaceAfterTheSpaceDeletesOnlyTheSpace() {
        let t = "@jxn/opus-b "
        let grown = MentionTokens.expand(NSRange(location: 11, length: 1), tokens: tokens(t))
        XCTAssertEqual(grown, NSRange(location: 11, length: 1), "the space after a mention is plain text")
    }

    func testTypingRightBeforeOrAfterATokenIsUntouched() {
        let t = "say @jxn ok"
        let toks = tokens(t)
        XCTAssertEqual(MentionTokens.expand(NSRange(location: 4, length: 0), tokens: toks), NSRange(location: 4, length: 0), "before the @")
        XCTAssertEqual(MentionTokens.expand(NSRange(location: 8, length: 0), tokens: toks), NSRange(location: 8, length: 0), "at its end")
    }

    func testAnEditThatCutsIntoATokenTakesAllOfIt() {
        let t = "a @maya's agent b"
        let toks = tokens(t)
        // A selection from "a " into the middle of the mention.
        let grown = MentionTokens.expand(NSRange(location: 1, length: 6), tokens: toks)
        XCTAssertEqual(sub(t, grown), " @maya's agent")
        // One that starts inside it and runs past it.
        let grown2 = MentionTokens.expand(NSRange(location: 5, length: 12), tokens: toks)
        XCTAssertEqual(sub(t, grown2), "@maya's agent b")
    }

    func testEditsAroundTokensKeepThemWhole() {
        // Typing between two mentions, and replacing plain text next to one, leave both mentions as they were.
        var t = "@jxn @maya"
        let r = MentionTokens.expand(NSRange(location: 4, length: 1), tokens: tokens(t)) // the space between
        XCTAssertEqual(r, NSRange(location: 4, length: 1))
        t = (t as NSString).replacingCharacters(in: r, with: " and ")
        XCTAssertEqual(tokens(t).map { sub(t, $0) }, ["@jxn", "@maya"])
    }

    // MARK: The caret and selections

    func testTheCaretNeverRestsInsideAToken() {
        let t = "hi @jxn's agent ok"
        let toks = tokens(t) // 3..<15
        XCTAssertEqual(MentionTokens.snap(NSRange(location: 5, length: 0), previous: nil, tokens: toks), NSRange(location: 3, length: 0), "a tap near its start")
        XCTAssertEqual(MentionTokens.snap(NSRange(location: 13, length: 0), previous: nil, tokens: toks), NSRange(location: 15, length: 0), "a tap near its end")
        XCTAssertEqual(MentionTokens.snap(NSRange(location: 16, length: 0), previous: nil, tokens: toks), NSRange(location: 16, length: 0), "outside: untouched")
    }

    func testArrowKeysStepOverAToken() {
        let toks = tokens("hi @jxn's agent ok")
        // Left from its end lands inside: it goes on to its start (not back to the end, which would trap the caret).
        XCTAssertEqual(MentionTokens.snap(NSRange(location: 14, length: 0), previous: NSRange(location: 15, length: 0), tokens: toks), NSRange(location: 3, length: 0))
        // Right from its start: to its end.
        XCTAssertEqual(MentionTokens.snap(NSRange(location: 4, length: 0), previous: NSRange(location: 3, length: 0), tokens: toks), NSRange(location: 15, length: 0))
    }

    func testASelectionThatCutsIntoATokenCoversIt() {
        let t = "hi @jxn's agent ok"
        let sel = MentionTokens.snap(NSRange(location: 6, length: 4), previous: nil, tokens: tokens(t))
        XCTAssertEqual(sub(t, sel), "@jxn's agent")
    }

    // MARK: The @ menu

    private func agent(_ user: String, _ name: String?, status: String? = nil, client: String? = "claude-code") -> BoardAgent {
        BoardAgent(user: user, name: name, client: client, status: status, lastSeen: 0, state: "live")
    }

    func testTheMenuListsEachSessionUnderItsOwner_inTheWebsOrder() {
        let opts = MentionMenu.options(people: ["vedu", "jxn", "maya"], me: "vedu",
                                       named: ["maya": AppState.AgentName(name: "Jarvis", ambiguous: false)],
                                       sessions: [agent("jxn", "opus-b", status: "running tests"), agent("jxn", "opus-a"), agent("jxn", nil), agent("vedu", "scout")])
        XCTAssertEqual(opts.map(\.handle), [
            "jxn", "jxn's agent", "jxn/opus-a", "jxn/opus-b",
            "maya", "maya's agent",
            "vedu's agent", "vedu/scout",
            "agents", "humans", "all",
        ])
        let b = opts.first { $0.handle == "jxn/opus-b" }
        XCTAssertEqual(b?.note, "running tests", "a session shows its status")
        XCTAssertEqual(opts.first { $0.handle == "jxn/opus-a" }?.note, "claude-code", "else its client")
        XCTAssertEqual(b?.user, "jxn")
        XCTAssertEqual(b?.agent, true)
        let named = opts.first { $0.handle == "maya's agent" }
        XCTAssertEqual(named?.display, "Jarvis")
        XCTAssertEqual(named?.note, "@maya's agent")
    }

    func testFilteringLikeTheWeb() {
        let opts = MentionMenu.options(people: ["vedu", "jxn", "maya"], me: "vedu", named: [:],
                                       sessions: [agent("jxn", "opus-b"), agent("jxn", "opus-a")])
        XCTAssertEqual(MentionMenu.filter(opts, query: "jx").map(\.handle), ["jxn", "jxn's agent", "jxn/opus-a", "jxn/opus-b"], "a handle offers its agent and sessions")
        XCTAssertEqual(MentionMenu.filter(opts, query: "jxn/op").map(\.handle), ["jxn/opus-a", "jxn/opus-b"], "with a slash: the sessions")
        XCTAssertEqual(MentionMenu.filter(opts, query: "jxn/opus-b").map(\.handle), [], "what's typed in full isn't offered again")
        XCTAssertEqual(MentionMenu.filter(opts, query: "a").map(\.handle), ["agents", "all"])
    }

    func testDisplayNamesFindPeopleAndAgentsWithoutChangingTheirAddress() {
        let opts = MentionMenu.options(people: ["vedu", "jxn", "maya"], me: "vedu",
                                       named: ["jxn": AppState.AgentName(name: "Bender", ambiguous: true),
                                               "maya": AppState.AgentName(name: "Bender", ambiguous: true)], sessions: [],
                                       displayNames: ["maya": "Maya Chen"])
        XCTAssertEqual(MentionMenu.filter(opts, query: "ben").map(\.handle), ["jxn's agent", "maya's agent"])
        XCTAssertEqual(MentionMenu.filter(opts, query: "maya ch").map(\.handle), ["maya"])
        XCTAssertEqual(opts.first { $0.handle == "maya" }?.note, "@maya")
        XCTAssertEqual(opts.first { $0.handle == "maya's agent" }?.display, "Bender")
        XCTAssertEqual(MentionMenu.filter(opts, query: "ben").map { "@" + $0.handle + " " }, ["@jxn's agent ", "@maya's agent "])
    }

    func testThePickedTextIsWhatTheWebInserts() {
        // The web's mpick: "@" + its ins + a space; ins is "jxn", "jxn's agent", or "jxn/opus-b".
        let opts = MentionMenu.options(people: ["vedu", "jxn"], me: "vedu", named: [:], sessions: [agent("jxn", "opus-b")])
        let ins = opts.map { "@" + $0.handle + " " }
        XCTAssertTrue(ins.contains("@jxn/opus-b "))
        XCTAssertTrue(ins.contains("@jxn's agent "))
        // And once in the box it's one token, exactly the mention (not the space).
        let t = "@jxn/opus-b "
        XCTAssertEqual(tokens(t).map { sub(t, $0) }, ["@jxn/opus-b"])
    }
}
