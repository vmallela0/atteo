// QA for a board's Work: its tasks (grouped by where they stand, filtered by whose they are, ticked from the phone,
// ticking live when an agent ticks them) and its files (searched, read, a picture in Quick Look). Same harness as
// AgentSoupUITests: a local server seeded by ios/qa/seed.mjs, run by ios/qa/run.sh. Tests leave the board as they
// found it where they can.

import XCTest

final class WorkUITests: XCTestCase {
    let env = ProcessInfo.processInfo.environment

    func app() -> XCUIApplication {
        let a = XCUIApplication()
        a.launchEnvironment["AGENT_SOUP_SERVER"] = env["AGENT_SOUP_SERVER"] ?? "http://localhost:8788"
        a.launchEnvironment["AGENT_SOUP_TOKEN"] = env["AGENT_SOUP_TOKEN"] ?? ""
        a.launchEnvironment["AGENT_SOUP_FRESH"] = "1"
        return a
    }

    func shot(_ name: String) {
        let s = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        s.name = name
        s.lifetime = .keepAlways
        add(s)
    }

    /// The seeded board (Checkout bug), from AGENT_SOUP_TICK ("board:seq").
    var board: String? { env["AGENT_SOUP_TICK"].map { String($0.split(separator: ":")[0]) } }

    /// A call to the local server, as maya's app (or as theo, `other`), waited for.
    @discardableResult
    func call(_ method: String, _ path: String, other: Bool = false, body: [String: Any]? = nil) -> [String: Any] {
        guard let server = env["AGENT_SOUP_SERVER"], let token = env[other ? "AGENT_SOUP_OTHER_TOKEN" : "AGENT_SOUP_TOKEN"], let url = URL(string: server + path) else { return [:] }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        var out: [String: Any] = [:]
        let done = expectation(description: "\(method) \(path)")
        URLSession.shared.dataTask(with: r) { d, _, _ in
            out = (d.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        return out
    }

    /// Opens Checkout bug's Work sheet (from the strip at the top of the chat), full height.
    func openWork(_ a: XCUIApplication) {
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 10))
        let tab = a.buttons["tab-boards"]
        if tab.waitForExistence(timeout: 5) { tab.tap() }
        let chat = a.buttons["chat-Checkout bug"].firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10))
        chat.tap()
        let strip = a.buttons["work-strip"]
        XCTAssertTrue(strip.waitForExistence(timeout: 10), "the work strip")
        strip.tap()
        XCTAssertTrue(a.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH 'Work on'")).firstMatch.waitForExistence(timeout: 5), "Work opens")
        // The sheet to full height: drag its grabber (just above its navigation bar) up.
        let bar = a.navigationBars.element(boundBy: a.navigationBars.count - 1).frame
        let origin = a.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: bar.midX, dy: bar.minY - 8)).press(forDuration: 0.1, thenDragTo: origin.withOffset(CGVector(dx: bar.midX, dy: 60)))
        sleep(1)
    }

    /// Back one step: the top bar's back button, if there is one (a sheet's root has none; its first button is
    /// something else, like Files' sort menu).
    func back(_ a: XCUIApplication) {
        let bar = a.navigationBars.element(boundBy: a.navigationBars.count - 1)
        let b = bar.buttons["BackButton"]
        if b.exists { b.tap() } else if bar.buttons.element(boundBy: 0).label == "Back" { bar.buttons.element(boundBy: 0).tap() }
        sleep(1)
    }

    func row(_ a: XCUIApplication, _ title: String) -> XCUIElement { a.descendants(matching: .any)["task-row-\(title)"].firstMatch }

    func testTasks() throws {
        continueAfterFailure = false
        let a = app()
        openWork(a)
        let any = a.descendants(matching: .any)

        // Grouped by where they stand, with counts; sub-tasks under their parent.
        let doing = any["group-doing"].firstMatch, open = any["group-open"].firstMatch
        XCTAssertTrue(doing.waitForExistence(timeout: 8), "In progress group")
        XCTAssertTrue(open.exists, "Open group")
        XCTAssertTrue(doing.label.hasPrefix("In progress, "), doing.label)
        let parent = row(a, "Guard empty carts in charge()"), sub = row(a, "Ship")
        XCTAssertTrue(parent.waitForExistence(timeout: 5) && sub.exists, "the parent and its sub-task")
        XCTAssertGreaterThan(sub.frame.minY, parent.frame.minY, "the sub-task sits under its parent")
        XCTAssertLessThan(sub.frame.minY, open.frame.minY, "…in the parent's group")
        // Blocked, waiting on your approval, how far along, at a glance.
        let blocked = row(a, "Rotate the Stripe webhook secret")
        XCTAssertTrue(blocked.exists)
        XCTAssertTrue(blocked.label.contains("Blocked"), blocked.label)
        XCTAssertTrue(blocked.label.contains("1 of 3 checked"), "checklist progress: \(blocked.label)")
        // (The everyday-flow tests may have answered its approval already; then it's rightly gone.)
        // (Earlier seeds leave look-alikes on archived boards: match this board and this task.)
        let blockedSeq = (call("GET", "/api/boards/\(board ?? "")/tasks")["tasks"] as? [[String: Any]] ?? []).first { $0["title"] as? String == "Rotate the Stripe webhook secret" }?["seq"] as? Int
        let pending = (call("GET", "/api/approvals")["approvals"] as? [[String: Any]] ?? []).contains { $0["board_id"] as? String == board && $0["seq"] as? Int == blockedSeq }
        if pending {
            // Approvals load with the inbox, alongside the boards: give them a moment.
            let tagged = expectation(for: NSPredicate(format: "label CONTAINS 'Needs approval'"), evaluatedWith: blocked)
            wait(for: [tagged], timeout: 10)
        } else {
            XCTAssertFalse(blocked.label.contains("Needs approval"), blocked.label)
        }
        XCTAssertTrue(parent.label.contains("theo's agent is on it"), "who's on it: \(parent.label)")
        shot("w01-tasks")

        // A group folds away and comes back.
        open.tap()
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: blocked)
        wait(for: [gone], timeout: 3)
        XCTAssertEqual(open.value as? String, "collapsed")
        shot("w02-collapsed")
        open.tap()
        XCTAssertTrue(blocked.waitForExistence(timeout: 3), "expanded again")

        // Filters: yours, your agent's, nobody's.
        a.buttons["filter-Mine"].tap()
        XCTAssertTrue(blocked.waitForExistence(timeout: 3), "maya's own task is Mine")
        XCTAssertFalse(parent.exists, "theo's agent's task isn't")
        shot("w03-mine")
        a.buttons["filter-My agent's"].tap()
        XCTAssertTrue(row(a, "Add a regression test for empty carts").waitForExistence(timeout: 3), "her agent's task")
        XCTAssertFalse(blocked.exists)
        a.buttons["filter-Unassigned"].tap()
        XCTAssertTrue(row(a, "Ship").waitForExistence(timeout: 3), "nobody's on Ship")
        XCTAssertFalse(row(a, "Add a regression test for empty carts").exists)
        shot("w04-unassigned")
        a.buttons["filter-All"].tap()
        XCTAssertTrue(parent.waitForExistence(timeout: 3))

        // No claiming from the phone (agents claim through their tools): a swipe left offers Remove, not Claim.
        row(a, "Add a regression test for empty carts").swipeLeft()
        XCTAssertTrue(a.buttons["Remove"].firstMatch.waitForExistence(timeout: 3), "swipe offers Remove")
        XCTAssertFalse(a.buttons["Claim"].exists, "and no Claim")
        shot("w05-swipe")
        // Swipe it shut (an open swipe swallows the next touch on the list).
        let regressionRow = row(a, "Add a regression test for empty carts")
        regressionRow.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.5)).press(forDuration: 0.05, thenDragTo: regressionRow.coordinate(withNormalizedOffset: CGVector(dx: 0.6, dy: 0.5)))
        let shut = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: a.buttons["Remove"].firstMatch)
        wait(for: [shut], timeout: 3)
        sleep(1)

        // Who's on it, read-only, in the detail: theo's agent holds the seeded task.
        parent.tap()
        let owner = any["task-owner"].firstMatch
        XCTAssertTrue(owner.waitForExistence(timeout: 5))
        XCTAssertTrue(owner.label.contains("theo's agent is on it"), owner.label)
        XCTAssertFalse(a.buttons["task-claim"].exists, "no Claim button")
        XCTAssertTrue(a.buttons["sub-task-Ship"].exists, "the parent lists its sub-tasks")
        shot("w09-parent")
        back(a)

        // The detail: tap a checklist line to tick it (and again to untick); the approval it's waiting on is there.
        blocked.tap()
        let line = a.buttons["check-rotate the secret"]
        XCTAssertTrue(line.waitForExistence(timeout: 5), "its checklist")
        XCTAssertEqual(a.buttons["task-approval"].exists, pending, "the approval it's waiting on")
        XCTAssertEqual(a.buttons["task-status"].value as? String, "Blocked")
        shot("w06-detail")
        let was = line.value as? String ?? ""
        line.tap()
        let flipped = expectation(for: NSPredicate(format: "value != %@", was), evaluatedWith: line)
        wait(for: [flipped], timeout: 6)
        shot("w07-ticked")
        sleep(1)
        line.tap() // back as it was
        let restored = expectation(for: NSPredicate(format: "value == %@", was), evaluatedWith: line)
        wait(for: [restored], timeout: 6)

        // Live: theo's agent ticks a line on its side; it ticks here and in the list, no pull-to-refresh.
        if let board {
            let other = a.buttons["check-redeploy checkout-service"]
            XCTAssertTrue(other.exists)
            let before = other.value as? String ?? ""
            let tasks = call("GET", "/api/boards/\(board)/tasks")["tasks"] as? [[String: Any]] ?? []
            let n = tasks.first { $0["title"] as? String == "Rotate the Stripe webhook secret" }?["seq"] as? Int ?? 0
            let (from, to) = before == "done" ? ("- [x] redeploy checkout-service", "- [ ] redeploy checkout-service") : ("- [ ] redeploy checkout-service", "- [x] redeploy checkout-service")
            call("POST", "/api/boards/\(board)/tasks/\(n)", other: true, body: ["action": "edit", "old_str": from, "new_str": to, "summary": "QA: live tick"])
            let live = expectation(for: NSPredicate(format: "value != %@", before), evaluatedWith: other)
            wait(for: [live], timeout: 8)
            shot("w07a-live-tick")
            back(a)
            let ticked = blocked.label
            call("POST", "/api/boards/\(board)/tasks/\(n)", other: true, body: ["action": "edit", "old_str": to, "new_str": from, "summary": "QA: live untick"])
            let relabeled = expectation(for: NSPredicate(format: "label != %@", ticked), evaluatedWith: blocked)
            wait(for: [relabeled], timeout: 8)
        } else {
            back(a)
        }

        // Long-press: everything you can do to a task (status, done, remove), no Claim. (Settle first: a press while
        // the list is still animating the live change lands as a tap.)
        sleep(2)
        parent.press(forDuration: 1.0)
        XCTAssertTrue(a.buttons["Open"].waitForExistence(timeout: 3), "a context menu")
        XCTAssertTrue(a.buttons["Status"].exists)
        XCTAssertFalse(a.buttons["Claim"].exists)
        shot("w08-menu")
        a.buttons["Open"].tap()
        XCTAssertTrue(any["task-owner"].firstMatch.waitForExistence(timeout: 5), "Open opens it")
    }

    func testFiles() throws {
        continueAfterFailure = false
        let a = app()
        openWork(a)
        let any = a.descendants(matching: .any)
        a.buttons["Files"].tap()

        // Every file, most recently updated first, with its type and version.
        let png = any["file-checkout-flow.png"].firstMatch, code = any["file-charge.ts"].firstMatch, plan = any["file-rollout-plan.md"].firstMatch
        XCTAssertTrue(png.waitForExistence(timeout: 8), "the board's files")
        XCTAssertTrue(code.exists && plan.exists)
        XCTAssertLessThan(png.frame.minY, plan.frame.minY, "newest first")
        XCTAssertTrue(plan.label.contains("v2"), plan.label)
        shot("w10-files")

        // Search.
        let search = any["files-search"].firstMatch
        search.tap()
        search.typeText("roll")
        let narrowed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: code)
        wait(for: [narrowed], timeout: 3)
        XCTAssertTrue(plan.exists, "the match stays")
        shot("w11-search")
        a.buttons["Clear search"].tap()
        XCTAssertTrue(code.waitForExistence(timeout: 3), "all again")

        // A Markdown doc, as text, with its version picker and Share.
        plan.tap()
        XCTAssertTrue(a.staticTexts["Rollout plan"].waitForExistence(timeout: 8), "the doc, as text")
        XCTAssertTrue(a.buttons["doc-version"].waitForExistence(timeout: 5), "version picker")
        XCTAssertTrue(a.buttons["doc-share"].waitForExistence(timeout: 5), "share")
        shot("w12-doc")
        a.buttons["doc-version"].tap()
        a.buttons.matching(NSPredicate(format: "label BEGINSWITH 'v1'")).firstMatch.tap()
        XCTAssertTrue(a.staticTexts["Older version"].waitForExistence(timeout: 5), "an older version")
        shot("w13-doc-v1")
        back(a)

        // Code, in monospace, numbered.
        code.tap()
        XCTAssertTrue(any["code-block"].firstMatch.waitForExistence(timeout: 8), "code, as code")
        shot("w14-code")
        back(a)

        // A picture opens in Quick Look.
        png.tap()
        let ql = any.matching(NSPredicate(format: "label CONTAINS 'checkout-flow' AND NOT (identifier BEGINSWITH 'file-')")).firstMatch
        XCTAssertTrue(ql.waitForExistence(timeout: 10), "Quick Look shows the picture")
        sleep(1)
        shot("w15-quicklook")
    }

    /// Out of a doc and closed: back from the doc lands on Files (still in the sheet), Done closes it, the chat is there.
    /// (Files is a pane now, not a pushed screen, so there's no second back between the doc and Done.)
    func testCloseFromFiles() throws {
        continueAfterFailure = false
        let a = app()
        openWork(a)
        a.buttons["Files"].tap()
        let plan = a.descendants(matching: .any)["file-rollout-plan.md"].firstMatch
        XCTAssertTrue(plan.waitForExistence(timeout: 8))
        plan.tap()
        XCTAssertTrue(a.staticTexts["Rollout plan"].waitForExistence(timeout: 8))
        back(a)
        XCTAssertTrue(plan.waitForExistence(timeout: 5), "back on Files")
        XCTAssertEqual(a.descendants(matching: .any)["work-pane"].firstMatch.exists, true, "still in the sheet")
        a.buttons["Done"].tap()
        sleep(1)
        XCTAssertTrue(a.buttons["presence"].waitForExistence(timeout: 5), "back in the chat")
        XCTAssertFalse(a.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH 'Work on'")).firstMatch.exists, "the sheet closed")
    }
}
