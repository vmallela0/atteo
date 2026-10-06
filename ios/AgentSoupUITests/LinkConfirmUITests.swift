// QA for links that leave Atteo (jxn #4173, LinkGate.swift): tapping a GitHub link in a message asks "Open this
// link?" with the whole address before anything opens; Cancel stays in the chat.

import XCTest

final class LinkConfirmUITests: AtteoUITestCase {
    func testOutsideLinkAsksFirst() throws {
        guard let b = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded Checkout bug board") }
        let run = String(Int(Date().timeIntervalSince1970) % 100_000)
        call("POST", "/api/boards/\(b)/entries", json: ["type": "note", "text": "The fix is in https://github.com/vmallela0/agent-soup/pull/58 (run \(run))"])
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let link = a.links.matching(NSPredicate(format: "label CONTAINS 'github.com'")).firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 15), "the GitHub link shows in the chat")
        link.tap()
        let address = a.descendants(matching: .any)["leaving-address"].firstMatch
        XCTAssertTrue(address.waitForExistence(timeout: 5), "asks before leaving")
        XCTAssertTrue(a.staticTexts["Open this link?"].exists)
        shot("link-confirm")
        a.buttons["leaving-cancel"].tap()
        XCTAssertTrue(eventually(address, "exists == false"), "Cancel stays in Atteo")
        XCTAssertEqual(a.state, .runningForeground, "nothing opened")
    }
}
