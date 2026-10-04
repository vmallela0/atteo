// Starting a reply keeps what you'd typed (vedu #1469, like the web's bd02f02): swipe a message (or long-press → Reply)
// with text in the chat's box and the reply's box has "@theo " and that text, under "Replying to theo"; ✕ cancels the
// reply and the text is back in the chat's box as it was. Sending the reply clears it for good.

import XCTest

final class ReplyDraftUITests: AtteoUITestCase {
    private var n: Int { Int(Date().timeIntervalSince1970) % 100000 }

    private func seq(_ r: [String: Any]) -> Int { (r["entry"] as? [String: Any])?["seq"] as? Int ?? 0 }

    /// theo posts "<text>" on Checkout bug; the app opens that chat, the message in view.
    private func chat(with text: String) throws -> XCUIApplication {
        guard !otherApp.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        XCTAssertGreaterThan(seq(call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": text], token: otherApp)), 0)
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        XCTAssertTrue(a.staticTexts[text].waitForExistence(timeout: 10), "theo's message is here")
        return a
    }

    func testSwipeReplyKeepsTheDraftAndCancelGivesItBack() throws {
        continueAfterFailure = false
        let n = n
        let a = try chat(with: "Swipe me \(n)")
        let box = composer(a)
        box.tap()
        let typed = "half a thought \(n)"
        box.typeText(typed)
        XCTAssertTrue(eventually(box, "value == '\(typed)'"))

        // Swipe theo's message right: the thread opens, its box answering it with "@theo " and what was typed.
        let msg = a.staticTexts["Swipe me \(n)"]
        let from = msg.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
        from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 140, dy: 0)), withVelocity: .fast, thenHoldForDuration: 0)
        if !a.navigationBars["Thread"].waitForExistence(timeout: 3) { // the swipe didn't take: Reply from the long-press
            msg.press(forDuration: 0.8)
            XCTAssertTrue(a.buttons["Reply"].waitForExistence(timeout: 3))
            a.buttons["Reply"].tap()
        }
        XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 5), "the reply opens the thread")
        let tbox = composer(a, "thread-composer")
        XCTAssertTrue(tbox.waitForExistence(timeout: 5))
        XCTAssertTrue(eventually(tbox, "value == '@theo \(typed)'"), "the text is still there, after @theo (\(tbox.value ?? ""))")
        let chip = a.staticTexts["reply-chip"]
        XCTAssertTrue(chip.waitForExistence(timeout: 5), "Replying to …")
        XCTAssertTrue(chip.label.hasPrefix("Replying to theo"), chip.label)
        XCTAssertTrue(chip.label.contains("Swipe me \(n)"), chip.label)
        shot("reply-draft-01-replying")

        // More typed in the reply goes back too.
        tbox.typeText(" more")
        // ✕: the reply is cancelled, the text back in the chat's box without "@theo ".
        a.buttons["reply-cancel"].tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForNonExistence(timeout: 5), "cancelled: back in the chat")
        XCTAssertTrue(eventually(composer(a), "value == '\(typed) more'"), "the text is still there (\(composer(a).value ?? ""))")
        shot("reply-draft-02-cancelled")
    }

    func testSendingTheReplyClearsTheDraft() throws {
        continueAfterFailure = false
        let n = n
        let a = try chat(with: "Answer me \(n)")
        let box = composer(a)
        box.tap()
        let typed = "agreed \(n)"
        box.typeText(typed)
        let msg = a.staticTexts["Answer me \(n)"]
        msg.press(forDuration: 0.8)
        XCTAssertTrue(a.buttons["Reply"].waitForExistence(timeout: 3), "long-press offers Reply")
        a.buttons["Reply"].tap()
        let tbox = composer(a, "thread-composer")
        XCTAssertTrue(tbox.waitForExistence(timeout: 5))
        XCTAssertTrue(eventually(tbox, "value == '@theo \(typed)'"), "the text came along (\(tbox.value ?? ""))")
        a.buttons["thread-send"].tap()
        XCTAssertTrue(a.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", typed)).firstMatch.waitForExistence(timeout: 5), "sent")
        XCTAssertTrue(a.staticTexts["reply-chip"].waitForNonExistence(timeout: 5), "the box answers the thread again")
        a.buttons["thread-close"].tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForNonExistence(timeout: 5))
        let chatBox = composer(a)
        XCTAssertTrue(chatBox.waitForExistence(timeout: 5))
        sleep(1)
        XCTAssertFalse((chatBox.value as? String ?? "").contains(typed), "sent: not left behind in the chat's box (\(chatBox.value ?? ""))")
    }
}
