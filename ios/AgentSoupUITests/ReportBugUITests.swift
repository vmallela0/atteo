// Report a bug from Settings (jxn #3336, #3337): the row is there; the screenshot is opt-in (#3356), off by default and
// previewed only once ticked; a note goes in, and Send answers inline: sent, or (on a server without a bug board, or
// before /api/bugs exists) that reports aren't set up yet.

import XCTest

final class ReportBugUITests: AtteoUITestCase {
    func testReportABugFromSettings() throws {
        let a = app()
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 20), "Chats")
        a.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(a.navigationBars["Settings"].waitForExistence(timeout: 5), "Settings opens")

        let row = a.buttons["settings-report-bug"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Report a bug is in Settings")
        XCTAssertTrue(row.isHittable, "near the top: visible without scrolling")
        row.tap()

        XCTAssertTrue(a.navigationBars["Report a bug"].waitForExistence(timeout: 5), "the report opens")
        // Opt-in (#3356): no screenshot until you tick it, and then you see it.
        let include = a.switches["bug-include-screenshot"]
        XCTAssertTrue(include.waitForExistence(timeout: 5), "Include screenshot is offered")
        XCTAssertEqual(include.value as? String, "0", "off by default")
        XCTAssertFalse(a.images["bug-screenshot"].exists, "no preview while it's off")
        XCTAssertFalse(a.buttons["bug-send"].isEnabled, "nothing to send yet: no note, no screenshot")
        include.switches.firstMatch.tap()
        let screenshot = a.images["bug-screenshot"]
        XCTAssertTrue(screenshot.waitForExistence(timeout: 3), "ticked: the screenshot of the screen under Settings shows")
        XCTAssertGreaterThan(screenshot.frame.height, 100)
        XCTAssertTrue(a.staticTexts["It may show private messages."].exists, "with the warning")
        shot("report-bug-sheet")
        include.switches.firstMatch.tap()
        XCTAssertFalse(a.images["bug-screenshot"].waitForExistence(timeout: 1), "unticked: gone again")

        let note = a.descendants(matching: .any)["bug-note"].firstMatch
        XCTAssertTrue(note.waitForExistence(timeout: 3))
        note.tap()
        note.typeText("Tapping Send in a thread did nothing")
        XCTAssertTrue(a.buttons["bug-send"].isEnabled, "a note is enough")
        a.buttons["bug-send"].tap()

        let sent = a.descendants(matching: .any)["bug-sent"].firstMatch
        let failed = a.descendants(matching: .any)["bug-error"].firstMatch
        let deadline = Date().addingTimeInterval(20)
        while !sent.exists && !failed.exists && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.25)) }
        XCTAssertTrue(sent.exists || failed.exists, "Send answers inline")
        if failed.exists {
            // Until the server has /api/bugs and a bug board (#3341), the honest answer is that reports aren't set up.
            XCTAssertTrue(failed.label.contains("aren't set up"), "a server without a bug board says so, got: \(failed.label)")
        }
        shot("report-bug-result")
    }
}
