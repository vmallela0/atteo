// The board's top bar and what's under it on a phone (vedu #5044, #5046, #5051): search and ⋯ are on the bar itself (not
// folded into the system's overflow ⋯, where Board details did nothing), ⋯ has the board's menu with Board details for
// the rail, and between the header and Chat · Tasks · Files there's no empty band: the board tabs, snug. Same harness
// as the other UI tests (ios/qa/run.sh).

import XCTest

final class FrameHeaderUITests: AtteoUITestCase {
    func testTopBarAndStrip() throws {
        continueAfterFailure = false
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        shot("frame-01-header")

        // Search and ⋯, on the bar.
        for id in ["board-search", "board-menu"] {
            XCTAssertTrue(a.navigationBars.buttons[id].firstMatch.waitForExistence(timeout: 5) && a.navigationBars.buttons[id].firstMatch.isHittable, "\(id) is on the top bar")
        }

        // Under the header: the board tabs, then the pills, with no empty band in between.
        let presence = a.buttons["presence"].firstMatch
        let chat = a.boardTab("tab-chat")
        XCTAssertTrue(presence.exists && chat.waitForExistence(timeout: 5))
        let tab = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'state-tab-'")).firstMatch
        XCTAssertTrue(tab.waitForExistence(timeout: 5) && tab.isHittable, "the board tabs show")
        XCTAssertGreaterThan(tab.frame.minY, presence.frame.maxY - 1, "the tabs are under the header")
        XCTAssertLessThan(chat.frame.minY - tab.frame.maxY, 20, "the pills follow the tabs (\(tab.frame) → \(chat.frame))")
        XCTAssertLessThan(tab.frame.minY - presence.frame.maxY, 40, "no empty band between the header and the tabs (\(presence.frame) → \(tab.frame))")

        // ⋯: the board's menu, with Board details opening the rail.
        a.openBoardMenu()
        XCTAssertTrue(a.buttons["threads"].firstMatch.waitForExistence(timeout: 5), "⋯ has All threads")
        shot("frame-02-menu")
        let details = a.buttons["board-rail"].firstMatch
        XCTAssertTrue(details.waitForExistence(timeout: 3), "⋯ has Board details")
        details.tap()
        XCTAssertTrue(a.buttons["rail-menu"].firstMatch.waitForExistence(timeout: 5), "Board details opens the rail")
        shot("frame-03-rail")
    }

}
