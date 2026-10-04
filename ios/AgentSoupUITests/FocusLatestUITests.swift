// QA for tapping into the message box in a chat that opened at its first unread (#842, jxn #1011): the keyboard comes
// up and the chat goes to the latest, the newest message in view above the box, with no pill or Jump to latest left.
// It sometimes stayed where it opened (16 and 50 unread, Developer and Everyday), both while the chat was still being
// put at the first unread (its 10 passes, about 1.5 s) and after.

import XCTest

final class FocusLatestUITests: AtteoUITestCase {
    private var n: Int { Int(Date().timeIntervalSince1970) % 100000 }

    private func seq(_ r: [String: Any]) -> Int { (r["entry"] as? [String: Any])?["seq"] as? Int ?? 0 }

    /// When the box is tapped: once it's settled at the first unread, while it's being put there (as soon as the first
    /// unread is in view), or as soon as the chat is on screen (its messages may still be loading).
    enum When { case settled, positioning, opening }

    /// Long ones: enough that 16 of them don't fit on one screen. Short ones: a line each, like UnreadOpenUITests.
    private func text(_ n: Int, _ i: Int, long: Bool) -> String {
        "Focus \(n) message \(i):" + (long ? " checked the retry path again and the double charge only shows up when the webhook lands before the redirect" : " ok")
    }
    private func message(_ a: XCUIApplication, _ n: Int, _ i: Int) -> XCUIElement {
        a.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Focus \(n) message \(i):")).firstMatch
    }

    /// Opens Checkout bug with `count` new messages from theo (after maya's read mark), at its first unread, then taps the
    /// box (`when`). Within 2.5 s the newest message is in view above the keyboard, and stays.
    private func focuses(_ count: Int, mode: String = "developer", when: When = .settled, long: Bool = true) throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let n = n
        XCUIApplication().terminate() // (the last test's app would read theo's messages as they land)
        let last = seq(call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": "Read up to here \(n)"], token: otherApp))
        call("POST", "/api/boards/\(b1)/seen", json: ["seq": last])
        for i in 1...count {
            XCTAssertGreaterThan(seq(call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": text(n, i, long: long)], token: otherApp)), 0)
        }

        let a = app(extra: ["AGENT_SOUP_MODE": mode])
        a.launch()
        if mode == "everyday" {
            XCTAssertTrue(a.buttons["open-chats"].waitForExistence(timeout: 15), "For you")
            a.buttons["open-chats"].tap()
        }
        let box = composer(a)
        let latest = message(a, n, count)
        let divider = a.descendants(matching: .any)["new-divider"]
        switch when {
        case .settled:
            openChat(a, "Checkout bug")
            XCTAssertTrue(eventually(message(a, n, 1), "hittable == true", timeout: 10), "opens at the first unread")
            sleep(2)
            XCTAssertTrue(divider.exists, "under the New line")
            if long { XCTAssertFalse(latest.exists && latest.isHittable, "the newest isn't in view yet") }
            box.tap()
        case .positioning, .opening:
            // A finger doesn't wait: XCUIElement.tap() (and waitForExistence's 1 s polls) wait for the app to go idle,
            // which it isn't while it's being put at the first unread, so the tap would only land after. Here: look as
            // often as we can, and tap through SpringBoard, which lands right away.
            XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15), "Chats")
            if a.buttons["tab-boards"].waitForExistence(timeout: 10) { a.buttons["tab-boards"].tap() }
            a.buttons["chat-Checkout bug"].firstMatch.tap()
            let ready = when == .positioning ? divider : box
            let until = Date().addingTimeInterval(10)
            while !ready.exists && Date() < until { usleep(20_000) }
            XCTAssertTrue(ready.exists, when == .positioning ? "a New line" : "the chat opens")
            let f = box.frame
            let start = Date()
            XCUIApplication(bundleIdentifier: "com.apple.springboard").coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: f.midX, dy: f.midY)).tap()
            XCTContext.runActivity(named: String(format: "tapped %.2fs after it was there", Date().timeIntervalSince(start))) { _ in }
        }
        XCTAssertTrue(a.keyboards.firstMatch.waitForExistence(timeout: 3), "the keyboard is up")
        XCTAssertTrue(eventually(latest, "hittable == true", timeout: 2.5), "tapping the box goes to the latest")
        sleep(2)
        shot("focus-latest-\(count)-\(mode)-\(when)\(long ? "" : "-short")")
        XCTAssertTrue(latest.isHittable, "and stays there")
        XCTAssertFalse(a.buttons["new-messages-pill"].exists, "no pill")
        let chevron = a.buttons["Jump to latest"]
        XCTAssertFalse(chevron.exists && chevron.isHittable, "no Jump to latest")
        // Typing keeps it there.
        box.typeText("on it \(n)")
        XCTAssertTrue(latest.isHittable, "typing keeps the latest in view")
    }

    func testDeveloper16() throws { try focuses(16) }
    func testDeveloper50() throws { try focuses(50) }
    func testEveryday16() throws { try focuses(16, mode: "everyday") }
    func testEveryday50() throws { try focuses(50, mode: "everyday") }
    func testDeveloper16Positioning() throws { try focuses(16, when: .positioning) }
    func testDeveloper50Positioning() throws { try focuses(50, when: .positioning) }
    func testEveryday50Positioning() throws { try focuses(50, mode: "everyday", when: .positioning) }
    func testDeveloper50Opening() throws { try focuses(50, when: .opening) }
    func testDeveloper16Short() throws { try focuses(16, long: false) }
    func testEveryday50Short() throws { try focuses(50, mode: "everyday", long: false) }
    func testDeveloper16ShortPositioning() throws { try focuses(16, when: .positioning, long: false) }
    func testEveryday50ShortPositioning() throws { try focuses(50, mode: "everyday", when: .positioning, long: false) }
}
