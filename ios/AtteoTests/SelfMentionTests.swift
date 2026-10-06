// An agent's @ of itself (vedu #2630): the server leaves it out of the stored mentions (it reaches no one), but the
// message still boxes it, like the web (src/mentions.ts highlightMentions' `self`).

import XCTest
@testable import Atteo

final class SelfMentionTests: XCTestCase {
    private let members = ["vedu", "jxn"]

    func testAgentsOwnFormIsBoxedThoughNotStored() {
        let text = "@vedu's agent is on it"
        let none = text.mentioned([], members: members, me: "jxn")
        XCTAssertEqual(none.handles, [], "without the author, a dropped self-mention stays plain")
        let boxed = text.mentioned([], members: members, me: "jxn", author: EntryMention(user: "vedu", agent: true))
        XCTAssertEqual(boxed.handles, ["@vedu's agent"])
    }

    func testOnlyTheAuthorsOwnForm() {
        let r = "ask @jxn's agent, and @vedu".mentioned([], members: members, me: "jxn", author: EntryMention(user: "vedu", agent: true))
        XCTAssertEqual(r.handles, [], "another member's agent, or the person, isn't the agent's own form")
    }

    func testAPersonsOwnHandle() {
        let r = "note to @vedu".mentioned([], members: members, me: "jxn", author: EntryMention(user: "vedu", agent: false))
        XCTAssertEqual(r.handles, ["@vedu"])
    }

    func testSelfMentionFindsTheOwnFormOnlyOutsideQuotesAndCode() {
        XCTAssertEqual(selfMention(in: "@vedu's agent is on it", author: "vedu", agent: true), EntryMention(user: "vedu", agent: true))
        XCTAssertEqual(selfMention(in: "@Vedu’s agent is on it", author: "vedu", agent: true), EntryMention(user: "vedu", agent: true))
        XCTAssertEqual(selfMention(in: "note to @vedu", author: "vedu", agent: false), EntryMention(user: "vedu", agent: false))
        XCTAssertNil(selfMention(in: "@vedu is on it", author: "vedu", agent: true), "naming its person isn't its own form")
        XCTAssertNil(selfMention(in: "@vedu's agent", author: "vedu", agent: false), "the person naming their agent is a real mention")
        XCTAssertNil(selfMention(in: "> **jxn** · #4\n> ping @vedu", author: "vedu", agent: false), "a forward's quote")
        XCTAssertNil(selfMention(in: "he wrote \"@vedu's agent\" there", author: "vedu", agent: true))
        XCTAssertNil(selfMention(in: "`@vedu's agent`", author: "vedu", agent: true))
        XCTAssertNil(selfMention(in: "@vedu/scout takes it", author: "vedu", agent: false))
        XCTAssertNil(selfMention(in: "@vedux hi", author: "vedu", agent: false))
    }

    func testGroupsUnchanged() {
        // Display only: "@agents" doesn't light up just because the author is an agent.
        let r = "@agents go".mentioned([], members: members, me: "jxn", author: EntryMention(user: "vedu", agent: true))
        XCTAssertEqual(r.handles, [])
    }

    func testAgentsOwnNameIsBoxedThoughNotStored() { // vedu #4583
        for name in ["moby", "MOBY"] {
            let text = "@\(name) the posthog is ready; @vedu's agent tells @vedu"
            let author = selfMention(in: text, author: "vedu", agent: true, agentName: "moby")
            XCTAssertEqual(author, EntryMention(user: "vedu", agent: true))
            let boxed = text.mentioned([EntryMention(user: "vedu", agent: false)], members: members, me: "jxn",
                                       agentNames: ["moby": "vedu"], author: author)
            XCTAssertEqual(boxed.handles, ["@\(name)", "@vedu's agent", "@vedu"])
        }
        for text in ["@moby is on it", "thanks @MOBY!"] {
            let author = selfMention(in: text, author: "vedu", agent: true, agentName: "moby")
            XCTAssertEqual(author, EntryMention(user: "vedu", agent: true))
            XCTAssertEqual(text.mentioned([], members: members, me: "jxn", agentNames: ["moby": "vedu"], author: author).handles.count, 1)
        }
        for text in ["@mobyx", "@moby_", "x@moby", "https://host/@moby", "`@moby`", "```\n@moby\n```", "\"@moby\"", "“@moby”", "> @moby"] {
            XCTAssertNil(selfMention(in: text, author: "vedu", agent: true, agentName: "moby"), text)
        }
        XCTAssertNil(selfMention(in: "@moby", author: "vedu", agent: false, agentName: "moby"))
        XCTAssertNil(selfMention(in: "@moby", author: "vedu", agent: true))
        let text = "@moby @agents"
        let author = selfMention(in: text, author: "vedu", agent: true, agentName: "moby")
        XCTAssertEqual(text.mentioned([], members: members, me: "jxn", agentNames: ["moby": "vedu"], author: author).handles, ["@moby"])
    }
}
