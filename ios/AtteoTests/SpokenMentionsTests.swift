// Dictation's mentions (SpokenMentions.swift): the web's own cases (test/browser/dictation-mentions.mjs, with its
// members vedu, maya (whose agent is Jarvis) and ann), review #1753's false tags, and more cases whose expected text
// came from running the web's `spoken` (src/html.ts) on the same members, so the two give the same text.

import XCTest
@testable import Atteo

final class SpokenMentionsTests: XCTestCase {
    /// The web check's board: you (dmx1), vedu, maya (her agent is Jarvis) and ann.
    private let web = SpokenMentions(me: "dmx1", members: ["dmx1", "vedu", "maya", "ann"], agentNames: ["maya": "Jarvis"])
    /// Longer handles, for near misses.
    private let long = SpokenMentions(me: "vedu", members: ["vedu", "jonathan", "maria", "theo", "kathryn", "kathleen"])

    private func check(_ r: SpokenMentions, _ cases: [(String, String)], line: UInt = #line) {
        for (said, want) in cases { XCTAssertEqual(r.apply(said), want, "\"\(said)\"", line: line) }
    }

    func testWebCases() {
        check(web, [
            ("at agents please look at the logs", "@agents please look at the logs"),
            ("ask at vedu about the deploy", "ask @vedu about the deploy"),
            ("at vito can you check", "@vedu can you check"),
            ("at vedu's agent run the tests", "@vedu's agent run the tests"),
            ("at vedus agent too", "@vedu's agent too"),
            ("at Maya and at jarvis", "@maya and @Jarvis"),
            ("at my agent remember this", "@dmx1's agent remember this"),
            ("at everyone standup in five", "@all standup in five"),
            ("meet at noon at the office", "meet at noon at the office"),
            ("look at this and at least that", "look at this and at least that"),
            ("at zebra is not a member", "at zebra is not a member"),
        ])
    }

    /// Review #1753: "'s" is an agent only before agent/assistant; handles under 5 letters only by word or sound.
    func testNoFalseTags() {
        check(web, [
            ("look at ann's draft", "look at ann's draft"),
            ("at and then we ship", "at and then we ship"),
            ("at ann can you review", "@ann can you review"),
            ("at ann", "@ann"),
            ("at ann's agent take it", "@ann's agent take it"),
            ("at ann’s agent go", "@ann's agent go"), // the curly apostrophe dictation writes
            ("at an", "at an"),
            ("at mya", "at mya"),
            ("that vedu", "that vedu"),
        ])
    }

    func testGroupsAndPunctuation() {
        check(web, [
            ("at agents please check", "@agents please check"),
            ("meet at noon", "meet at noon"),
            ("at vedu", "@vedu"),
            ("At Vedu, can you look?", "@vedu, can you look?"),
            ("at people and at human", "@humans and @humans"),
            ("at all", "at all"), // "not at all": all is an everyday word, as on the web; "at everyone" is @all
            ("not at all, at agent", "not at all, @agents"),
            ("at assistant help", "@agents help"),
            ("at maya’s assistant.", "@Jarvis."),
            ("at jarvis", "@Jarvis"),
            ("at vedu at vedu", "@vedu @vedu"),
        ])
    }

    /// Long handles forgive one letter (5 letters) or two (6+); more than that, or a short one, stays as said.
    func testNearMisses() {
        check(long, [
            ("at jonathon", "@jonathan"),
            ("at jonathn", "@jonathan"),
            ("at jonatxxn", "@jonathan"),
            ("at jonxxxan", "at jonxxxan"),
            ("at mario", "@maria"),
            ("at marie", "@maria"),
            ("at mxria", "@maria"),
            ("at muxia", "at muxia"),
            ("at kathrin", "@kathryn"),
            ("at kathxxn", "@kathryn"),
            ("at kathlene", "@kathleen"),
            ("at theodore", "at theodore"),
            ("at teo", "at teo"),
            ("at thea", "at thea"),
        ])
    }

    /// Two members equally close: neither.
    func testTie() {
        let r = SpokenMentions(me: "vedu", members: ["vedu", "dan", "tan"])
        check(r, [("at ten", "at ten"), ("at dan", "@dan")])
    }

    /// Only this board's members; nothing changes without "at".
    func testOnlyMembers() {
        let r = SpokenMentions(me: "dmx1", members: ["dmx1"])
        check(r, [("at vedu", "at vedu"), ("at agents", "@agents"), ("at my agent", "@dmx1's agent")])
        XCTAssertEqual(web.apply("no mentions here"), "no mentions here")
        XCTAssertEqual(web.apply(""), "")
    }

    func testHints() {
        let r = SpokenMentions(me: "dmx1", members: ["dmx1", "vedu", "maya", "ann", "agents"], agentNames: ["maya": "Jarvis"], displayNames: ["Vedu Mallela", "", "vedu"])
        XCTAssertEqual(r.hints, ["@agents", "@humans", "@all", "vedu", "maya", "ann", "Jarvis", "Vedu Mallela"])
    }

    func testSoundAndDistance() {
        XCTAssertEqual(SpokenMentions.sound("vedu"), "vt")
        XCTAssertEqual(SpokenMentions.sound("vito"), "vt")
        XCTAssertEqual(SpokenMentions.sound("Philippa"), "flp")
        XCTAssertEqual(SpokenMentions.sound("ann"), "an")
        XCTAssertEqual(SpokenMentions.sound(""), "")
        XCTAssertEqual(SpokenMentions.lev("jonathon", "jonathan"), 1)
        XCTAssertEqual(SpokenMentions.lev("", "abc"), 3)
        XCTAssertEqual(SpokenMentions.lev("kitten", "sitting"), 3)
    }
}
