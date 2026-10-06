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

    /// The tabs from left to right (their ids).
    private func order(_ a: XCUIApplication) -> [String] {
        a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'state-tab-'")).allElementsBoundByIndex
            .sorted { $0.frame.minX < $1.frame.minX }.map { String($0.identifier.dropFirst("state-tab-".count)) }
    }

    private func until(_ seconds: Double, _ ok: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end { if ok() { return true }; usleep(200_000) }
        return ok()
    }

    /// vedu #5194: the tabs never move up or down, also at the largest text, whatever you drag on them. The strip
    /// records (DEBUG) the most its content ever moved vertically, how much taller than the strip it ever was, and any
    /// vertical insets: all three stay 0.
    func testStripNeverScrollsVertically() throws {
        for size in ["UICTContentSizeCategoryL", "UICTContentSizeCategoryAccessibilityXXXL"] {
            let a = app()
            a.launchArguments += ["-UIPreferredContentSizeCategoryName", size]
            a.launch()
            // At the largest size the board can be below the fold of Chats: scroll to it (as TabsUITests does).
            XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15), "Chats")
            if a.buttons["tab-boards"].waitForExistence(timeout: 10) { a.buttons["tab-boards"].tap() }
            let row = a.buttons["chat-Checkout bug"].firstMatch
            for _ in 0..<8 where !row.isHittable { a.swipeUp(velocity: .slow) }
            XCTAssertTrue(row.waitForExistence(timeout: 5), "Checkout bug is in the list")
            row.tap()
            XCTAssertTrue(composer(a).waitForExistence(timeout: 10), "Checkout bug opens")
            let strip = a.descendants(matching: .any)["board-state-tabs"].firstMatch
            let tab = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'state-tab-'")).firstMatch
            XCTAssertTrue(tab.waitForExistence(timeout: 5) && strip.exists, "\(size): the tabs are drawn")
            let inside = { tab.frame.minY >= strip.frame.minY - 0.5 && tab.frame.maxY <= strip.frame.maxY + 0.5 }
            XCTAssertTrue(inside(), "\(size): the tabs sit inside their strip, not shifted up or down (\(tab.frame) in \(strip.frame))")
            let y = tab.frame.minY
            // Slow drags up and down that start on the tabs, held at the end (a bounce shows while held), and quick flicks.
            let mid = strip.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            mid.press(forDuration: 0.1, thenDragTo: mid.withOffset(CGVector(dx: 0, dy: 120)), withVelocity: .slow, thenHoldForDuration: 0.5)
            mid.press(forDuration: 0.1, thenDragTo: mid.withOffset(CGVector(dx: 0, dy: -120)), withVelocity: .slow, thenHoldForDuration: 0.5)
            mid.press(forDuration: 0.05, thenDragTo: mid.withOffset(CGVector(dx: 10, dy: 90)), withVelocity: .fast, thenHoldForDuration: 0)
            mid.press(forDuration: 0.05, thenDragTo: mid.withOffset(CGVector(dx: -10, dy: -90)), withVelocity: .fast, thenHoldForDuration: 0)
            sleep(1)
            let drift = a.descendants(matching: .any)["board-state-tabs-drift"].firstMatch
            XCTAssertTrue(drift.waitForExistence(timeout: 3), "the strip's drift probe (DEBUG build)")
            let v = (drift.value as? String ?? "").split(separator: " ").compactMap { Double($0) }
            if v.count != 3 || v.contains(where: { $0 > 0.5 }) { shot("strip-drift-\(size)") }
            XCTAssertEqual(v.count, 3, "\(size): drift reads moved / taller / insets (\(drift.value ?? "none"))")
            XCTAssertTrue(v.allSatisfy { $0 <= 0.5 }, "\(size): the tabs never moved up or down, never had room to (moved, taller, insets: \(v))")
            XCTAssertEqual(tab.frame.minY, y, accuracy: 0.5, "\(size): the tabs are where they were")
            XCTAssertTrue(inside(), "\(size): and still inside their strip (\(tab.frame) in \(strip.frame))")
            a.terminate()
        }
    }

    /// vedu #5194: a post on another board moves its tab to the front while you're in this one, no refresh.
    func testStripReordersLive() throws {
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        guard let here = boardId(titled: "Checkout bug"), let other = boardId(titled: "Q4 data migration") else { return XCTFail("seeded boards") }
        assertStrip(a, "open")
        call("POST", "/api/boards/\(here)/entries", json: ["type": "note", "text": "Strip order: here"], token: otherApp)
        XCTAssertTrue(until(8) { order(a).first == here }, "a post here puts this board first (\(order(a)))")
        call("POST", "/api/boards/\(other)/entries", json: ["type": "note", "text": "Strip order: there"], token: otherApp)
        XCTAssertTrue(until(8) { order(a).first == other }, "a post on Q4 data migration moves its tab to the front at once (\(order(a)))")
        XCTAssertEqual(order(a).dropFirst().first, here, "this board right after it")
        assertStrip(a, "reordered")
        shot("strip-reordered")
    }
}
