// QA for #675: message numbers are for agents, not people. "#123" in a message reads as that message's title
// ("↗ Roll back plan…") and still opens it; nothing on screen shows "#<number>" (headers, quotes, Info, thread rows,
// tasks); "Copy link" keeps the number in the link (/b/<board>#e<seq>), for agents and the web.

import XCTest

final class MessageNumbersUITests: AtteoUITestCase {
    func testNoNumbersForPeople() throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let n = Int(Date().timeIntervalSince1970) % 100000
        let target = call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": "Rollback plan \(n): flip PAYMENTS_V2 off"], token: otherApp)
        let seq = (target["entry"] as? [String: Any])?["seq"] as? Int ?? 0
        XCTAssertGreaterThan(seq, 0)
        let ref = call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": "If it goes wrong, see #\(seq) and keep `#\(seq)` as is"], token: otherApp)
        let refSeq = (ref["entry"] as? [String: Any])?["seq"] as? Int ?? 0

        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let line = a.staticTexts.matching(NSPredicate(format: "label CONTAINS 'If it goes wrong'")).firstMatch
        XCTAssertTrue(line.waitForExistence(timeout: 10), "the message is here")
        XCTAssertTrue(line.label.contains("↗ Rollback plan \(n)"), "the number reads as the message's title (\(line.label))")
        XCTAssertTrue(line.label.contains("`#\(seq)`") || line.label.contains("#\(seq) as is"), "but not inside code")
        XCTAssertFalse(line.label.contains("see #\(seq)"), "no bare number")
        shot("numbers-01-chip")

        // Nothing else on screen is a bare "#<number>" (besides the code span above).
        let bare = a.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "^#[0-9]+$"))
        XCTAssertEqual(bare.count, 0, "no message numbers on screen")

        // Copy link keeps the number.
        line.press(forDuration: 1.0)
        let copy = a.buttons["Copy link"]
        XCTAssertTrue(copy.waitForExistence(timeout: 5), "Copy link in the menu")
        copy.tap()
        sleep(1)
        // Pasted into the message box (the app reads its own copy; the test runner reading it would ask permission).
        let box = composer(a)
        box.tap()
        sleep(1)
        box.press(forDuration: 1.0)
        let paste = a.descendants(matching: .any).matching(NSPredicate(format: "label == 'Paste' AND (elementType == %d OR elementType == %d)",
                                                                        XCUIElement.ElementType.menuItem.rawValue, XCUIElement.ElementType.button.rawValue)).firstMatch
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "Paste")
        paste.tap()
        XCTAssertTrue(eventually(box, "value ENDSWITH '/b/\(b1)#e\(refSeq)'"), "the link has the board and the number (\(box.value ?? ""))")
        box.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: ((box.value as? String) ?? "").count + 2))
        a.swipeDown()

        // Info: open questions and decisions without numbers.
        a.buttons["presence"].tap()
        XCTAssertTrue(a.navigationBars["Info"].waitForExistence(timeout: 5))
        sleep(1)
        XCTAssertEqual(a.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "^#[0-9]+$")).count, 0, "no numbers in Info")
        shot("numbers-02-info")
        a.navigationBars["Info"].buttons["Done"].tap()

        // Tasks: no numbers in the list.
        let strip = a.buttons["work-strip"]
        if strip.waitForExistence(timeout: 5) {
            strip.tap()
            sleep(2)
            XCTAssertEqual(a.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "^#[0-9]+$")).count, 0, "no numbers in Tasks")
            XCTAssertEqual(a.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '#'")).count, 0, "nor at the start of a line")
            shot("numbers-03-tasks")
            a.buttons["Done"].tap()
        }
    }
}
