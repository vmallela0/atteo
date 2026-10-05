// The chat row's tint is for a message that @mentions you by name (jxn #4120): not your agent, one of your sessions,
// or a group that happens to include you. Like the web's markMe (a person chip whose user is you).

import XCTest
@testable import Atteo

final class MentionsPersonDirectlyTests: XCTestCase {
    private let me = "vedu"
    private func person(_ u: String) -> EntryMention { EntryMention(user: u, agent: false) }
    private func agent(_ u: String, session: String? = nil) -> EntryMention { EntryMention(user: u, agent: true, session: session) }

    func testDirectMentionOfThePerson() {
        XCTAssertTrue(mentionsPersonDirectly(text: "@vedu can you look?", mentions: [person("vedu")], me: me))
        XCTAssertTrue(mentionsPersonDirectly(text: "thanks, @Vedu.", mentions: [person("vedu")], me: me), "case and a full stop")
    }

    func testTheirAgentIsNotThePerson() {
        XCTAssertFalse(mentionsPersonDirectly(text: "@vedu's agent please land it", mentions: [agent("vedu")], me: me))
        XCTAssertFalse(mentionsPersonDirectly(text: "@vedu’s assistant, please", mentions: [agent("vedu")], me: me))
    }

    func testASessionIsNotThePerson() {
        XCTAssertFalse(mentionsPersonDirectly(text: "@vedu/claude-6 ship it", mentions: [agent("vedu", session: "claude-6")], me: me))
    }

    func testGroupsDontNameYou() {
        XCTAssertFalse(mentionsPersonDirectly(text: "@agents status?", mentions: [agent("vedu"), agent("jxn")], me: me))
        XCTAssertFalse(mentionsPersonDirectly(text: "@humans lunch?", mentions: [person("vedu"), person("jxn")], me: me), "@humans stores a person mention of you, but doesn't name you")
        XCTAssertFalse(mentionsPersonDirectly(text: "@all heads up", mentions: [person("vedu"), agent("vedu")], me: me))
    }

    func testSomeoneElseOrNothing() {
        XCTAssertFalse(mentionsPersonDirectly(text: "@jxn look", mentions: [person("jxn")], me: me))
        XCTAssertFalse(mentionsPersonDirectly(text: "no one", mentions: nil, me: me))
        XCTAssertFalse(mentionsPersonDirectly(text: "@vedu hi", mentions: [person("vedu")], me: nil))
    }

    func testCodeAndQuotesDontCount() {
        XCTAssertFalse(mentionsPersonDirectly(text: "@humans run `@vedu` in the shell", mentions: [person("vedu")], me: me))
        XCTAssertFalse(mentionsPersonDirectly(text: "> @vedu said hi\n> — jxn, #12\n@humans see above", mentions: [person("vedu")], me: me))
    }

    func testDirectAlongsideYourAgent() {
        XCTAssertTrue(mentionsPersonDirectly(text: "@vedu's agent drafted it, @vedu please approve", mentions: [agent("vedu"), person("vedu")], me: me))
    }
}
