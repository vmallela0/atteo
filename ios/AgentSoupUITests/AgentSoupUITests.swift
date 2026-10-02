// QA: drives the app like a person (tap, swipe, type) against a local server seeded with test data, and keeps a
// screenshot of every step. Run: TEST_RUNNER_AGENT_SOUP_SERVER=… TEST_RUNNER_AGENT_SOUP_TOKEN=… xcodebuild test …

import XCTest

final class AgentSoupUITests: XCTestCase {
    let env = ProcessInfo.processInfo.environment

    func app(fresh: Bool) -> XCUIApplication {
        let a = XCUIApplication()
        a.launchEnvironment["AGENT_SOUP_SERVER"] = env["AGENT_SOUP_SERVER"] ?? "http://localhost:8788"
        a.launchEnvironment["AGENT_SOUP_TOKEN"] = env["AGENT_SOUP_TOKEN"] ?? ""
        if fresh { a.launchEnvironment["AGENT_SOUP_FRESH"] = "1" }
        return a
    }

    func shot(_ name: String) {
        let s = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        s.name = name
        s.lifetime = .keepAlways
        add(s)
    }

    func testEverydayFlow() throws {
        continueAfterFailure = false
        let a = app(fresh: true)
        a.launch()
        shot("01-launch")
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 10))
        let chat = a.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'chat-'")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "chats load")
        shot("02-chats")

        // Approve the first thing that needs you (one tap).
        let yes = a.buttons["Yes"].firstMatch
        let header = a.staticTexts["needs-you"]
        if yes.waitForExistence(timeout: 3), header.exists {
            let before = header.label
            yes.tap()
            let changed = expectation(for: NSPredicate(format: "label != %@", before), evaluatedWith: header)
            wait(for: [changed], timeout: 5) // "Needs you · 4" → "· 3": the answered item left
            shot("03-approved")
        }

        // Open a chat, send a message, see it land.
        chat.tap()
        let composer = a.textFields["composer"].exists ? a.textFields["composer"] : a.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "board opens")
        shot("04-board")
        // Who's doing what: the strip at the top opens the board's task list.
        let strip = a.buttons["work-strip"]
        if strip.waitForExistence(timeout: 5) {
            strip.tap()
            XCTAssertTrue(a.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH 'Work on'")).firstMatch.waitForExistence(timeout: 5), "task list opens")
            shot("04b-tasks")
            a.buttons["Done"].tap()
        }
        // A task card ticks live: another member finishes a sub-task and its card here says Done, no refresh.
        let env = ProcessInfo.processInfo.environment
        if let tick = env["AGENT_SOUP_TICK"], let server = env["AGENT_SOUP_SERVER"], let token = env["AGENT_SOUP_TOKEN"] {
            let card = a.buttons["task-card-\(tick.split(separator: ":")[1])"]
            XCTAssertTrue(card.waitForExistence(timeout: 5), "the sub-task's card is in the chat")
            XCTAssertFalse((card.value as? String ?? "").hasPrefix("Done"), "not done yet")
            let parts = tick.split(separator: ":")
            var r = URLRequest(url: URL(string: "\(server)/api/boards/\(parts[0])/tasks/\(parts[1])")!)
            r.httpMethod = "POST"
            r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.httpBody = try JSONSerialization.data(withJSONObject: ["action": "update", "status": "done"])
            let posted = expectation(description: "done posted")
            URLSession.shared.dataTask(with: r) { _, _, _ in posted.fulfill() }.resume()
            wait(for: [posted], timeout: 10)
            let ticked = expectation(for: NSPredicate(format: "value BEGINSWITH 'Done'"), evaluatedWith: card)
            wait(for: [ticked], timeout: 5)
            shot("04c-ticked")
        }
        composer.tap()
        let msg = "QA from the phone \(Int(Date().timeIntervalSince1970) % 100000)"
        composer.typeText(msg)
        shot("05-typing")
        a.buttons["send"].tap()
        XCTAssertTrue(a.staticTexts[msg].waitForExistence(timeout: 3), "the message shows at once")
        shot("06-sending")
        let sending = a.staticTexts["Sending…"]
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: sending)
        wait(for: [gone], timeout: 10)
        shot("07-sent")

        // Back to the list, then Agents: flip a session to read-only.
        a.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 5))
        shot("08-back")
        a.buttons["Your agents"].tap()
        XCTAssertTrue(a.navigationBars["Your agents"].waitForExistence(timeout: 5))
        shot("09-agents")
        let toggle = a.switches.firstMatch
        if toggle.waitForExistence(timeout: 5) {
            let was = toggle.value as? String
            toggle.switches.firstMatch.exists ? toggle.switches.firstMatch.tap() : toggle.tap()
            sleep(1)
            shot("10-read-only")
            XCTAssertNotEqual(toggle.value as? String, was, "the switch flips")
            toggle.tap() // put it back
        }
    }

    func testInstantRelaunchFromCache() throws {
        let a = app(fresh: false)
        a.launch()
        _ = a.navigationBars["Chats"].waitForExistence(timeout: 10)
        sleep(2)
        a.terminate()
        // Second launch: the list is on screen straight away, from the cache (before the network answers).
        let b = app(fresh: false)
        b.launch()
        let chat = b.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'chat-'")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 1.5), "cached chats show instantly")
        shot("11-relaunch-instant")
    }
}
