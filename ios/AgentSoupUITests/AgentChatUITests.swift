// QA for "Your agent" (#720): pinned at the top of DMs with the agent's picture, never under Boards; inside, a "To"
// picker (Any of my agents, or one live / idle session) and no invite or member list in its Info. A message sent to
// one session reaches the server as that session's ("@maya/builder …", to_session).

import XCTest

final class AgentChatUITests: AtteoUITestCase {
    func testYourAgentChat() throws {
        continueAfterFailure = false
        let a = app()
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15))
        // Not under Boards.
        let boardsTab = a.buttons["tab-boards"]
        XCTAssertTrue(boardsTab.waitForExistence(timeout: 10))
        boardsTab.tap()
        XCTAssertTrue(a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chat-'")).firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(a.buttons["chat-your-agent"].exists, "not under Boards")
        XCTAssertFalse(a.buttons["chat-Your agent"].exists, "not listed as a board")

        // Pinned first under DMs.
        a.buttons["tab-direct"].tap()
        let pinned = a.buttons["chat-your-agent"]
        XCTAssertTrue(pinned.waitForExistence(timeout: 8), "pinned under DMs")
        let first = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chat-'")).firstMatch
        XCTAssertEqual(first.identifier, "chat-your-agent", "at the top")
        XCTAssertFalse(a.buttons["chat-Your agent"].exists, "only once (not also as a plain DM row)")
        shot("agent-01-dms")

        pinned.tap()
        XCTAssertTrue(composer(a).waitForExistence(timeout: 10), "it opens")
        let to = a.buttons["agent-to"]
        XCTAssertTrue(to.waitForExistence(timeout: 5), "the To picker")
        XCTAssertEqual(to.value as? String, "Any of my agents")
        shot("agent-02-chat")

        // Pick one session: builder.
        to.tap()
        let builder = a.buttons.matching(NSPredicate(format: "label BEGINSWITH 'builder'")).firstMatch
        XCTAssertTrue(builder.waitForExistence(timeout: 5), "her sessions are listed")
        shot("agent-03-picker")
        builder.tap()
        XCTAssertTrue(eventually(to, "value == 'builder'"), "builder picked")
        let n = Int(Date().timeIntervalSince1970) % 100000
        let box = composer(a)
        box.tap()
        box.typeText("Run the empty-cart test again (\(n))")
        a.buttons["send"].tap()
        // The server has it as builder's: "@maya/builder" leads the text.
        var text = ""
        for _ in 0..<10 {
            let boards = call("GET", "/api/me/boards")["boards"] as? [[String: Any]] ?? []
            if let id = boards.first(where: { $0["kind"] as? String == "agent" })?["id"] as? String {
                let entries = call("GET", "/api/boards/\(id)/entries?after=0&limit=500")["entries"] as? [[String: Any]] ?? []
                text = entries.compactMap { $0["text"] as? String }.last { $0.contains("(\(n))") } ?? ""
                if !text.isEmpty { break }
            }
            sleep(1)
        }
        XCTAssertTrue(text.hasPrefix("@maya/builder "), "sent to builder (got \(text))")
        shot("agent-04-sent")

        // Its Info: nobody to invite, no member list.
        a.buttons["presence"].tap()
        XCTAssertTrue(a.navigationBars["Info"].waitForExistence(timeout: 5))
        XCTAssertFalse(a.textFields["invite-to"].exists, "no invite")
        XCTAssertFalse(a.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'member-'")).firstMatch.exists, "no members")
        shot("agent-05-info")
        a.navigationBars["Info"].buttons["Done"].tap()
    }
}
