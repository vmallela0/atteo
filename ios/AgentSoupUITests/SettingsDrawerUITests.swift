// Settings as a drawer (vedu #2488): pull from the left edge of Chats and Settings slides in; swipe the screen beside it
// back, tap it, or Done, and it closes. A short pull springs back. Inside a chat the same edge swipe is still Back, and
// the rows' own swipes (Archive / Leave) still work.

import XCTest

final class SettingsDrawerUITests: AtteoUITestCase {
    private func drawer(_ a: XCUIApplication) -> XCUIElement { a.descendants(matching: .any)["settings-drawer"].firstMatch }
    private func at(_ a: XCUIApplication, _ x: CGFloat, _ y: CGFloat = 0.55) -> XCUICoordinate { a.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)) }
    /// A pull from the very edge to `to` (a fraction of the screen's width).
    private func pull(_ a: XCUIApplication, from: CGFloat = 0.01, to: CGFloat, velocity: XCUIGestureVelocity = .default) {
        at(a, from).press(forDuration: 0.05, thenDragTo: at(a, to), withVelocity: velocity, thenHoldForDuration: 0.05)
    }
    private func isOpen(_ a: XCUIApplication) -> Bool { drawer(a).exists && drawer(a).frame.minX > -20 }

    func testEdgePullOpensSettingsAndItCloses() throws {
        let a = app()
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15), "Chats")

        // A short, slow pull springs back.
        pull(a, to: 0.2, velocity: .slow)
        XCTAssertTrue(eventually(drawer(a), "exists == false", timeout: 3) || !isOpen(a), "a short pull doesn't open it")

        // A pull past half way opens Settings beside the screen.
        pull(a, to: 0.85)
        XCTAssertTrue(drawer(a).waitForExistence(timeout: 5), "Settings slides in")
        XCTAssertTrue(a.navigationBars["Settings"].waitForExistence(timeout: 5), "it's Settings")
        XCTAssertTrue(isOpen(a), "all the way open")
        shot("drawer-01-open")

        // Swipe the screen beside it back: closed.
        at(a, 0.95).press(forDuration: 0.05, thenDragTo: at(a, 0.3))
        XCTAssertTrue(eventually(drawer(a), "exists == false", timeout: 4), "a swipe back closes it")

        // Open again, tap beside it: closed.
        pull(a, to: 0.85)
        XCTAssertTrue(drawer(a).waitForExistence(timeout: 5))
        at(a, 0.96, 0.5).tap()
        XCTAssertTrue(eventually(drawer(a), "exists == false", timeout: 4), "a tap beside it closes it")

        // Open again, Done: closed.
        pull(a, to: 0.85)
        XCTAssertTrue(drawer(a).waitForExistence(timeout: 5))
        let done = drawer(a).buttons["Done"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 3), "Settings' Done")
        done.tap()
        XCTAssertTrue(eventually(drawer(a), "exists == false", timeout: 4), "Done closes it")

        // The picture button still opens Settings (as a sheet, as before).
        a.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(a.navigationBars["Settings"].waitForExistence(timeout: 5), "the button still opens Settings")
        a.buttons["Done"].firstMatch.tap()
    }

    func testInsideAChatTheEdgeIsBackAndRowSwipesStillWork() throws {
        let title = "Checkout bug"
        guard boardId(titled: title) != nil else { throw XCTSkip("needs the seed") }
        let a = app()
        a.launch()
        openChat(a, title)
        // In a chat the edge swipe is the system's Back, not Settings.
        pull(a, to: 0.85)
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 5), "the edge swipe went back to Chats")
        XCTAssertFalse(drawer(a).exists, "and didn't open Settings")

        let row = a.buttons["chat-\(title)"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(row.isHittable, "the row is on screen")
        // A swipe right that starts in the middle of a row (not at the edge) is the row's, not the drawer's.
        let mid = row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        mid.press(forDuration: 0.05, thenDragTo: row.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)))
        shot("drawer-02-row-swipe")
        XCTAssertFalse(isOpen(a), "a row swipe doesn't open Settings")

        // A row's swipe to the left still shows its actions (Archive for an owner, Leave otherwise).
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.swipeLeft()
        let action = a.buttons.matching(NSPredicate(format: "label IN {'Archive', 'Leave'}")).firstMatch
        XCTAssertTrue(action.waitForExistence(timeout: 3), "the row's swipe actions")
        XCTAssertFalse(isOpen(a))
    }
}
