// Report a bug from Settings (jxn #3336, #3337): the row is there; nothing is captured for you (jxn #4116), the paper
// clip adds a picture as a removable thumbnail; a note goes in, and Send answers inline: sent, or (on a server without
// a bug board, or before /api/bugs exists) that reports aren't set up yet.

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
        // Nothing is captured for you (jxn #4116): no screenshot, no toggle; pictures are yours to add.
        XCTAssertFalse(a.switches["bug-include-screenshot"].exists, "no auto-screenshot toggle")
        XCTAssertFalse(a.descendants(matching: .any)["attachments"].exists, "no picture until you add one")
        XCTAssertFalse(a.buttons["bug-send"].isEnabled, "nothing to send yet: no note")
        let attach = a.buttons["bug-attach"]
        XCTAssertTrue(attach.waitForExistence(timeout: 5), "the paper clip is there")
        XCTAssertEqual(attach.label, "Add a picture")
        attach.tap()
        // The picker runs in another process (as the message box's test does it): wait for its grid, tap the first
        // photo, then Add (the simulator's library has the stock photos, or ones added with simctl addmedia).
        if a.scrollViews.images.firstMatch.waitForExistence(timeout: 10) {
            sleep(1)
            a.coordinate(withNormalizedOffset: CGVector(dx: 0.17, dy: 0.47)).tap()
            sleep(1)
            // Several may be picked here, so the picker confirms with its ✓ at the top right (not "Add").
            let add = a.buttons.matching(NSPredicate(format: "label IN {'Add', 'Done'} OR identifier IN {'Add', 'Done'}")).firstMatch
            let check = a.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.165))
            if add.waitForExistence(timeout: 3) { add.tap() } else { check.press(forDuration: 0.15) }
            let chip = a.descendants(matching: .any)["attachment-chip"].firstMatch
            if !chip.waitForExistence(timeout: 4) { check.press(forDuration: 0.15) } // the picker sometimes misses the first
            XCTAssertTrue(chip.waitForExistence(timeout: 10), "the picked picture shows as a thumbnail")
            shot("report-bug-picture")
            a.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Remove '")).firstMatch.tap()
            XCTAssertTrue(eventually(chip, "exists == false"), "and comes off again")
        } else {
            XCTFail("the photo library opens")
        }
        XCTAssertTrue(a.navigationBars["Report a bug"].waitForExistence(timeout: 5), "back on the report")
        shot("report-bug-sheet")

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
