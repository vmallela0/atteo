// QA for one-tap replies (vedu #2490): theo's agent asks maya a question with its own choices; maya's phone shows them
// under it, she taps one, it lands as her reply in the question's thread, and the buttons go. A question with no
// choices gets "Yes, go ahead · Not now · Tell me more"; theo asking from his phone (a person) gets none.
// Same harness as the others (ios/qa/run.sh against a seeded local server).

import XCTest

final class QuickRepliesUITests: AtteoUITestCase {
    func testOneTapReplyToAnAgentsQuestion() throws {
        continueAfterFailure = false
        guard let theoAgent = env["AGENT_SOUP_OTHER_TOKEN"], !theoAgent.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server") }
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")

        let n = Int(Date().timeIntervalSince1970) % 100000
        let asked = call("POST", "/api/boards/\(b1)/entries", json: ["type": "question", "text": "@maya deploy the fix now? (\(n))", "data": ["options": ["Deploy now", "Wait for CI"]]], token: theoAgent)
        let seq = (asked["entry"] as? [String: Any])?["seq"] as? Int ?? 0
        XCTAssertGreaterThan(seq, 0, "\(asked)")
        let second = a.buttons["quick-reply-2"].firstMatch
        XCTAssertTrue(second.waitForExistence(timeout: 10), "the agent's choices show under its question")
        XCTAssertEqual(second.label, "Wait for CI")
        XCTAssertEqual(a.buttons["quick-reply-1"].firstMatch.label, "Deploy now")
        XCTAssertFalse(a.buttons["quick-reply-3"].exists, "only its two")
        shot("qr-01-choices")
        second.tap()

        // Her reply, in the thread; the buttons go.
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: a.buttons["quick-reply-2"].firstMatch)
        waitForExpectations(timeout: 10)
        let page = call("GET", "/api/boards/\(b1)/entries?after=\(seq)&limit=50")["entries"] as? [[String: Any]] ?? []
        let reply = page.first { ($0["reply_to"] as? Int) == seq && ($0["author"] as? String) == "maya" }
        XCTAssertEqual(reply?["text"] as? String, "Wait for CI", "her choice, as her reply in the thread")
        XCTAssertEqual(reply?["via"] as? String, "person")
        shot("qr-02-answered")

        // No choices: the defaults. A person's question: none.
        _ = call("POST", "/api/boards/\(b1)/entries", json: ["type": "question", "text": "@maya tidy the flaky test too? (\(n))"], token: theoAgent)
        let yes = a.buttons["quick-reply-1"].firstMatch
        XCTAssertTrue(yes.waitForExistence(timeout: 10), "defaults for a question with no choices")
        XCTAssertEqual(yes.label, "Yes, go ahead")
        XCTAssertEqual(a.buttons["quick-reply-3"].firstMatch.label, "Tell me more")
        shot("qr-03-defaults")
        yes.tap()
        expectation(for: gone, evaluatedWith: a.buttons["quick-reply-1"].firstMatch)
        waitForExpectations(timeout: 10)
        if !otherApp.isEmpty {
            _ = call("POST", "/api/boards/\(b1)/entries", json: ["type": "question", "text": "@maya lunch? (\(n))"], token: otherApp)
            XCTAssertTrue(a.staticTexts.matching(NSPredicate(format: "label CONTAINS 'lunch? (\(n))'")).firstMatch.waitForExistence(timeout: 10))
            XCTAssertFalse(a.buttons["quick-reply-1"].exists, "no buttons on a person's question to a person")
        }
    }
}
