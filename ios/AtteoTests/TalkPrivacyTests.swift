// People only and Just mine messages never reach the voice model (#2094/#2095): xAI's model is an agent, and the
// person's own token can read those messages. read_board, mailbox_summary and the standby recap leave them out.

import XCTest
@testable import Atteo

@MainActor
final class TalkPrivacyTests: XCTestCase {
    func testReadBoardLeavesOutPeopleOnlyAndJustMine() {
        let entries: [[String: Any]] = [
            ["seq": 1, "author": "theo", "via": "person", "type": "note", "text": "The deploy is green."],
            ["seq": 2, "author": "theo", "via": "person", "type": "note", "text": "maya, salary numbers attached", "audience": "people", "to_people": ["theo", "maya"]],
            ["seq": 3, "author": "maya", "via": "person", "type": "question", "text": "my own reminder", "audience": "own", "to_people": ["maya"]],
            ["seq": 4, "author": "theo", "via": "agent", "type": "note", "text": "Tests pass.", "audience": NSNull()],
        ]
        let out = TalkSession.entriesForModel(entries)
        XCTAssertEqual(out.compactMap { $0["seq"] as? Int }, [1, 4])
        let json = TalkSession.json(["board": "b_x", "entries": out])
        XCTAssertFalse(json.contains("salary"), "people-only text never goes")
        XCTAssertFalse(json.contains("reminder"), "Just mine text never goes")
        XCTAssertFalse(json.contains("audience"), "nor a hint that something was left out")
        XCTAssertEqual(Set(out[0].keys), ["seq", "author", "via", "type", "text"])
    }

    func testMailboxLeavesOutJustMine() throws {
        let raw = try JSONSerialization.data(withJSONObject: ["mail": [
            ["id": 1, "kind": "mention", "from": "theo", "text": "Can you look at the build?"],
            ["id": 2, "kind": "for_your_agent", "from": "maya", "text": "private plan", "audience": "own"],
            ["id": 3, "kind": "mention", "from": "theo", "text": "people only thing", "audience": "people"],
        ], "more": false])
        let s = String(data: TalkSession.mailForModel(raw), encoding: .utf8) ?? ""
        XCTAssertTrue(s.contains("look at the build"))
        XCTAssertFalse(s.contains("private plan"))
        XCTAssertFalse(s.contains("people only thing"))
        XCTAssertEqual(String(data: TalkSession.mailForModel(Data("not json".utf8)), encoding: .utf8), "{}", "anything odd: nothing")
    }

    func testStandbyRecapLeavesOutPrivateMessagesReadAloud() {
        typealias C = TalkSession.Caption
        let caps = [
            C(id: "y", who: .you, text: "What's new?", done: true),
            C(id: "g", who: .grok, text: "Two messages."),
            C(id: "h1", who: .heard, text: "theo: The deploy is green.", done: true),
            C(id: "h2", who: .heard, text: "theo: salary numbers", done: true, isPrivate: true),
            C(id: "n", who: .note, text: "Reading the board", done: true),
        ]
        let r = TalkStandby.recap(TalkSession.recapTurns(caps))
        XCTAssertTrue(r.contains("The deploy is green"))
        XCTAssertFalse(r.contains("salary"), "a people-only message read to the person isn't told to the model")
        XCTAssertFalse(r.contains("Reading the board"))
    }
}
