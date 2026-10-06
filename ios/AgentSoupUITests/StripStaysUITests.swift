// The board tabs under the header keep drawing through everything a session does (vedu #5046, #5106: "the tabs r
// missing again"): messages arriving, scrolling, typing and sending (the keyboard), Chat / Tasks / Files, leaving the
// app and coming back, and opening another board from the strip and returning. Same harness as the other UI tests.

import XCTest

final class StripStaysUITests: AtteoUITestCase {
    private func assertStrip(_ a: XCUIApplication, _ step: String, file: StaticString = #filePath, line: UInt = #line) {
        let tab = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'state-tab-'")).firstMatch
        let ok = tab.waitForExistence(timeout: 3) && tab.isHittable && tab.frame.height >= 20
        if !ok { shot("strip-missing-\(step)") }
        XCTAssertTrue(ok, "\(step): the board tabs are drawn (\(tab.exists ? "\(tab.frame)" : "gone"))", file: file, line: line)
        let chat = a.boardTab("tab-chat")
        if ok, chat.exists { XCTAssertLessThan(chat.frame.minY - tab.frame.maxY, 20, "\(step): the pills follow the tabs", file: file, line: line) }
    }

    func testStripSurvivesASession() throws {
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        guard let b = boardId(titled: "Checkout bug") else { return XCTFail("Checkout bug") }
        assertStrip(a, "open")

        // Messages arriving, a few at a time, as the board's feed brings them in.
        for i in 0..<6 {
            call("POST", "/api/boards/\(b)/entries", json: ["type": "note", "text": "Strip check \(i) from theo"], token: otherApp)
            if i % 2 == 1 { sleep(1); assertStrip(a, "feed-\(i)") }
        }
        sleep(2)
        assertStrip(a, "feed")

        // Scrolling the chat up and back down.
        a.swipeDown(velocity: .fast); a.swipeDown(velocity: .fast)
        assertStrip(a, "scrolled-up")
        a.swipeUp(velocity: .fast); a.swipeUp(velocity: .fast); a.swipeUp(velocity: .fast)
        assertStrip(a, "scrolled-down")

        // Typing and sending: the keyboard comes and goes.
        let box = composer(a)
        box.tap()
        box.typeText("Checking the strip")
        assertStrip(a, "keyboard")
        a.buttons["send"].tap()
        sleep(1)
        assertStrip(a, "sent")
        a.swipeDown(velocity: .slow) // the keyboard goes
        sleep(1)
        assertStrip(a, "keyboard-gone")

        // Chat · Tasks · Files.
        XCTAssertTrue(a.openBoardTab("tab-tasks")); assertStrip(a, "tasks")
        XCTAssertTrue(a.openBoardTab("tab-files")); assertStrip(a, "files")
        XCTAssertTrue(a.openBoardTab("tab-chat")); assertStrip(a, "chat")

        // Away and back.
        XCUIDevice.shared.press(.home)
        sleep(2)
        call("POST", "/api/boards/\(b)/entries", json: ["type": "note", "text": "While you were away"], token: otherApp)
        a.activate()
        sleep(2)
        assertStrip(a, "foreground")

        // Another board from the strip, and back.
        let other = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'state-tab-' AND NOT (identifier CONTAINS %@)", b)).firstMatch
        if other.exists && other.isHittable {
            other.tap()
            sleep(2)
            assertStrip(a, "other-board")
            let back = a.buttons["state-tab-\(b)"].firstMatch
            if back.waitForExistence(timeout: 3) {
                for _ in 0..<3 where !back.isHittable { a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'state-tab-'")).firstMatch.swipeLeft() }
                if back.isHittable { back.tap(); sleep(2); assertStrip(a, "back") }
            }
        }
        // More of the feed after all that.
        for i in 0..<4 { call("POST", "/api/boards/\(b)/entries", json: ["type": "note", "text": "Later \(i)"], token: otherApp) }
        sleep(3)
        assertStrip(a, "feed-later")
        shot("strip-end")
    }
}
