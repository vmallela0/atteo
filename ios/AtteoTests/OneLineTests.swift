// One line (OneLine.swift, jxn #2690): which messages fold, and what a folded line says. The never-fold list is the
// same on web and app (jxn's agent #2695).

import XCTest
@testable import Atteo

final class OneLineTests: XCTestCase {
    private func entry(_ seq: Int = 10, author: String = "theo", via: String? = "person", type: String = "note", text: String = "hello there",
                       to: String? = nil, mentions: [EntryMention]? = [], replyTo: Int? = nil) -> Entry {
        var e = Entry(seq: seq, ts: 0, author: author, type: type, text: text, title: nil, to: to, via: via, artifactName: nil)
        e.mentions = mentions
        e.replyTo = replyTo
        return e
    }
    private func ctx(me: String? = "maya", direct: Bool = false, parent: Entry? = nil, jumped: Int? = nil, firstUnread: Int? = nil) -> MessageFold.Context {
        MessageFold.Context(me: me, direct: direct, parent: parent, jumpedTo: jumped, firstUnread: firstUnread)
    }

    func testOffNeverFolds() {
        XCTAssertFalse(MessageFold.folds(entry(), on: false, ctx()))
    }

    func testSomeoneElsesPlainMessageFolds() {
        XCTAssertTrue(MessageFold.folds(entry(), on: true, ctx()))
        XCTAssertTrue(MessageFold.folds(entry(author: "theo", via: "agent"), on: true, ctx()), "another person's agent")
    }

    func testMentionOfYouStaysFull() {
        XCTAssertFalse(MessageFold.folds(entry(mentions: [EntryMention(user: "maya", agent: false)]), on: true, ctx()))
        XCTAssertFalse(MessageFold.folds(entry(mentions: [EntryMention(user: "Maya", agent: false)]), on: true, ctx()), "case doesn't matter")
    }

    func testMentionOfYourAgentStaysFull() {
        XCTAssertFalse(MessageFold.folds(entry(mentions: [EntryMention(user: "maya", agent: true)]), on: true, ctx()))
        XCTAssertFalse(MessageFold.folds(entry(mentions: [EntryMention(user: "maya", agent: true, session: "builder")]), on: true, ctx()), "one of your sessions")
    }

    func testAtAgentsStaysFull() {
        // @agents reaches every member's agent: the server lists each one, yours among them.
        let all = [EntryMention(user: "theo", agent: true), EntryMention(user: "maya", agent: true)]
        XCTAssertFalse(MessageFold.folds(entry(mentions: all), on: true, ctx()))
    }

    func testMentionOfSomeoneElseFolds() {
        XCTAssertTrue(MessageFold.folds(entry(mentions: [EntryMention(user: "jxn", agent: false)]), on: true, ctx()))
    }

    func testApprovalsStayFull() {
        XCTAssertFalse(MessageFold.folds(entry(type: "approval"), on: true, ctx()))
    }

    func testQuestionToYouStaysFull() {
        XCTAssertFalse(MessageFold.folds(entry(type: "question", to: "maya"), on: true, ctx()))
        XCTAssertTrue(MessageFold.folds(entry(type: "question", to: "jxn"), on: true, ctx()), "a question to someone else folds")
    }

    func testDecisionsStayFull() {
        XCTAssertFalse(MessageFold.folds(entry(type: "decision"), on: true, ctx()))
    }

    func testReplyToYouStaysFull() {
        let mine = entry(5, author: "maya", via: "person")
        XCTAssertFalse(MessageFold.folds(entry(replyTo: 5), on: true, ctx(parent: mine)))
        let theirs = entry(5, author: "jxn")
        XCTAssertTrue(MessageFold.folds(entry(replyTo: 5), on: true, ctx(parent: theirs)), "a reply to someone else folds")
        let yourAgent = entry(5, author: "maya", via: "agent")
        XCTAssertTrue(MessageFold.folds(entry(replyTo: 5), on: true, ctx(parent: yourAgent)), "a reply to your agent isn't a reply to you")
    }

    func testDirectMessagesNeverFold() {
        XCTAssertFalse(MessageFold.folds(entry(), on: true, ctx(direct: true)))
    }

    func testYourOwnMessagesStayFull() {
        XCTAssertFalse(MessageFold.folds(entry(author: "maya", via: "person"), on: true, ctx()))
        XCTAssertTrue(MessageFold.folds(entry(author: "maya", via: "agent"), on: true, ctx()), "your agent's posts can fold")
    }

    func testJumpedToAndFirstUnreadStayFull() {
        XCTAssertFalse(MessageFold.folds(entry(10), on: true, ctx(jumped: 10)))
        XCTAssertFalse(MessageFold.folds(entry(10), on: true, ctx(firstUnread: 10)))
        XCTAssertTrue(MessageFold.folds(entry(11), on: true, ctx(jumped: 10, firstUnread: 10)))
    }

    func testPeopleOnlyToYouStaysFull() {
        var e = entry()
        e.audience = "people"
        e.toPeople = ["maya", "theo"]
        XCTAssertFalse(MessageFold.folds(e, on: true, ctx()))
    }

    func testFirstLine() {
        XCTAssertEqual(MessageFold.firstLine(entry(text: "\n\n  **Shipped** the fix\nmore below")), "Shipped the fix")
        XCTAssertEqual(MessageFold.firstLine(entry(text: "# Plan for today")), "Plan for today")
        XCTAssertEqual(MessageFold.firstLine(entry(text: "- a list item")), "a list item")
    }
}
