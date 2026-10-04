// QA for new messages in a chat, like the web (jxn #1366, #1367): scrolled up reading, a message from someone else
// doesn't move what you're reading; a "1 new message" pill appears, and tapping it goes down to it and goes away. At
// the latest, a new message just comes into view, no pill.

import XCTest

final class NewMessagesUITests: AtteoUITestCase {
    private var n: Int { Int(Date().timeIntervalSince1970) % 100000 }

    @discardableResult
    private func post(_ board: String, _ text: String) -> Int {
        let r = call("POST", "/api/boards/\(board)/entries", json: ["type": "note", "text": text], token: otherApp)
        let seq = (r["entry"] as? [String: Any])?["seq"] as? Int ?? 0
        XCTAssertGreaterThan(seq, 0, "posted: \(text)")
        return seq
    }

    private func message(_ a: XCUIApplication, _ text: String) -> XCUIElement {
        a.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", text)).firstMatch
    }

    func testNewMessagesPill() throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let n = n
        // Enough to scroll: a page of theo's messages, read already (so it opens at the latest, not the first unread).
        var last = 0
        for i in 1...40 { last = post(b1, "Backlog \(n) line \(i)") }
        call("POST", "/api/boards/\(b1)/seen", json: ["seq": last])

        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let pill = a.buttons["new-messages-pill"]
        // It may open at the first unread: start from the latest.
        let latest = message(a, "Backlog \(n) line 40")
        XCTAssertTrue(latest.waitForExistence(timeout: 10), "theo's messages are here")
        sleep(2) // the open settles (first unread, lazy layout)
        let chevron = a.buttons["Jump to latest"]
        if chevron.exists && chevron.isHittable { chevron.tap(); sleep(1) }
        XCTAssertTrue(eventually(latest, "hittable == true"), "at the latest")
        XCTAssertFalse(pill.exists, "nothing new yet")

        // Scroll up to read: an older line in view.
        let older = message(a, "Backlog \(n) line 6")
        for _ in 0..<10 where !(older.exists && older.isHittable) { a.swipeDown(velocity: .slow); sleep(1) }
        XCTAssertTrue(older.exists && older.isHittable, "scrolled up to an older message")
        XCTAssertFalse(latest.exists && latest.isHittable, "really scrolled up: the latest is out of view")
        sleep(1)
        let before = older.frame
        shot("newmsg-01-reading")

        // theo posts: the pill counts it, and what you're reading stays put.
        let arrived = "Arrived \(n) while you read"
        post(b1, arrived)
        XCTAssertTrue(pill.waitForExistence(timeout: 8), "scrolled up: the new-messages pill")
        XCTAssertEqual(pill.label, "1 new message")
        sleep(1)
        XCTAssertTrue(older.isHittable, "the older message is still in view")
        XCTAssertEqual(older.frame.minY, before.minY, accuracy: 1, "the list didn't move (\(before) → \(older.frame))")
        XCTAssertFalse(message(a, arrived).exists && message(a, arrived).isHittable, "the new one isn't pulled into view")
        shot("newmsg-02-pill")

        // A second one: the pill says 2.
        post(b1, "Arrived \(n) again")
        XCTAssertTrue(eventually(pill, "label == '2 new messages'"), "counts up (\(pill.label))")
        XCTAssertEqual(older.frame.minY, before.minY, accuracy: 1, "still where you were reading")

        // Tap it: down to the new messages, and it goes.
        pill.tap()
        XCTAssertTrue(eventually(message(a, "Arrived \(n) again"), "hittable == true"), "the pill goes to the latest")
        XCTAssertTrue(message(a, arrived).isHittable, "the first new one is in view too")
        XCTAssertTrue(pill.waitForNonExistence(timeout: 3), "and clears")
        shot("newmsg-03-latest")

        // At the latest: a new message comes into view, no pill.
        let live = "Live \(n) at the bottom"
        post(b1, live)
        XCTAssertTrue(message(a, live).waitForExistence(timeout: 8), "it arrives")
        XCTAssertTrue(eventually(message(a, live), "hittable == true"), "in view")
        sleep(1)
        XCTAssertFalse(pill.exists, "no pill at the latest")
        shot("newmsg-04-live")
    }
}
