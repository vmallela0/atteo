// The alignment pass's camera (#722): every screen of the app, in light and dark, S / M / L text and compact density,
// written as PNGs for side-by-side review (ios/qa/design/alignment/<before|after>/). Only runs when asked:
// TEST_RUNNER_ALIGN_SHOTS=<dir> (and optionally TEST_RUNNER_ALIGN_SPECS="m,comfortable,light;l,compact,dark").

import XCTest

final class ScreensTourUITests: AtteoUITestCase {
    var dir: String { env["ALIGN_SHOTS"] ?? "" }

    func save(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    /// Closes the top sheet: its Done / Cancel, else a swipe down.
    func closeSheet(_ a: XCUIApplication) {
        let bars = a.navigationBars
        let bar = bars.element(boundBy: max(0, bars.count - 1))
        for t in ["Done", "Cancel"] where bar.buttons[t].exists { bar.buttons[t].tap(); sleep(1); return }
        a.swipeDown(velocity: .fast)
        sleep(1)
    }

    func back(_ a: XCUIApplication) {
        let bars = a.navigationBars
        let b = bars.element(boundBy: max(0, bars.count - 1)).buttons.element(boundBy: 0)
        if b.exists { b.tap() }
        sleep(1)
    }

    func testEveryScreen() throws {
        guard !dir.isEmpty else { throw XCTSkip("TEST_RUNNER_ALIGN_SHOTS=<dir> to take the tour") }
        let specs = (env["ALIGN_SPECS"].map { $0.split(separator: ";").map(String.init) }) ??
            ["m,comfortable,light", "m,comfortable,dark", "s,comfortable,light", "l,comfortable,light", "l,comfortable,dark", "m,compact,light", "m,compact,dark"]
        for spec in specs {
            let p = spec.split(separator: ",")
            let tag = "\(p[2])-\(p[0])\(p[1] == "compact" ? "-compact" : "")"
            tour(spec: spec, tag: tag)
        }
    }

    func tour(spec: String, tag: String) {
        let a = app(extra: ["AGENT_SOUP_DISPLAY": spec])
        a.launch()
        guard a.navigationBars["Chats"].waitForExistence(timeout: 15) else { return XCTFail("Chats (\(tag))") }
        a.buttons["tab-boards"].firstMatch.tap()
        sleep(2)
        save("01-chats-\(tag)")
        a.buttons["tab-direct"].firstMatch.tap()
        sleep(1)
        save("02-dms-\(tag)")
        a.buttons["tab-boards"].firstMatch.tap()

        // A board, a thread, the Threads list, Info, Tasks, Files, a document.
        let board = a.buttons["chat-Checkout bug"].firstMatch
        if board.waitForExistence(timeout: 10) {
            board.tap()
            // A fresh launch loads the whole chat: let it settle (the newest message on screen) before looking.
            let newest = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'task-card-' AND label BEGINSWITH 'Ship'")).firstMatch
            _ = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND hittable == true"), object: newest)], timeout: 20)
            sleep(2)
            save("03-board-\(tag)")
            a.buttons["threads"].firstMatch.tap(); sleep(2)
            save("05-threads-\(tag)")
            let row = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'thread-row-'")).firstMatch
            if row.waitForExistence(timeout: 3) {
                row.tap(); sleep(2)
                save("04-thread-\(tag)")
                back(a)
            }
            back(a)
            a.buttons["presence"].firstMatch.tap(); sleep(2)
            save("06-info-\(tag)")
            closeSheet(a)
            a.buttons["work-menu"].firstMatch.tap(); sleep(1)
            a.buttons["Tasks"].firstMatch.tap(); sleep(2)
            save("07-tasks-\(tag)")
            let seg = a.segmentedControls["work-pane"].buttons["Files"]
            if seg.waitForExistence(timeout: 3) {
                seg.tap(); sleep(2); save("08-files-\(tag)")
                let doc = a.buttons["file-rollout-plan.md"].firstMatch
                if doc.waitForExistence(timeout: 3) { doc.tap(); sleep(2); save("09-doc-\(tag)"); back(a) }
            }
            closeSheet(a)
            back(a)
        }

        // People (New message), a profile card.
        a.buttons["New"].firstMatch.tap(); sleep(1)
        a.buttons["New message"].firstMatch.tap(); sleep(2)
        save("10-people-\(tag)")
        let jules = a.buttons["person-jules"].firstMatch
        if jules.waitForExistence(timeout: 5) { jules.tap(); sleep(2); save("11-profile-\(tag)"); back(a) }
        let cancel = a.navigationBars["New message"].buttons["Cancel"]
        if cancel.waitForExistence(timeout: 3) { cancel.tap(); sleep(1) } else { closeSheet(a) }

        // Settings, Your agents.
        a.buttons["Settings"].firstMatch.tap(); sleep(2)
        save("12-settings-\(tag)")
        closeSheet(a)
        a.buttons["Your agents"].firstMatch.tap(); sleep(2)
        save("13-your-agents-\(tag)")
        closeSheet(a)
        a.terminate()

        // Sign-in.
        let s = app(fresh: false, extra: ["AGENT_SOUP_DISPLAY": spec, "AGENT_SOUP_SIGNED_OUT": "1"])
        s.launch()
        sleep(2)
        save("14-signin-\(tag)")
        s.terminate()
    }
}
