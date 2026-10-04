// QA for Everyday mode (board decision #1272; ios/qa/design/everyday): the first run's skip path, For you answering an
// OK inline, Everyday's words in a chat (no "#N", a To-dos tab, a result card instead of a change card), and the
// Developer mode switch bringing back today's app. Every other test runs in Developer mode (the harness's
// AGENT_SOUP_MODE=developer); these opt into Everyday.

import XCTest

final class EverydayUITests: AtteoUITestCase {
    private var mayaAgent: String { env["AGENT_SOUP_MAYA_AGENT"] ?? "" }
    private var julesApp: String { env["AGENT_SOUP_JULES_APP"] ?? "" }

    private func everyday(token: String? = nil, extra: [String: String] = [:]) -> XCUIApplication {
        let a = app(extra: ["AGENT_SOUP_MODE": "everyday"].merging(extra) { _, b in b })
        if let token { a.launchEnvironment["AGENT_SOUP_TOKEN"] = token }
        return a
    }

    private func forYou(_ a: XCUIApplication) {
        XCTAssertTrue(a.navigationBars["For you"].waitForExistence(timeout: 15), "For you is the first screen")
    }

    /// Scrolls until `e` is on screen (up: toward the top).
    private func reveal(_ a: XCUIApplication, _ e: XCUIElement, up: Bool = false, tries: Int = 10) {
        for _ in 0..<tries where !(e.exists && e.isHittable) { up ? a.swipeDown(velocity: .slow) : a.swipeUp(velocity: .slow) }
    }

    /// One of maya's agent's tools, on a board (the MCP endpoint, as ios/qa/seed.mjs calls it).
    @discardableResult
    private func tool(_ name: String, board: String, _ args: [String: Any]) -> [String: Any] {
        call("POST", "/mcp?board=\(board)", json: ["jsonrpc": "2.0", "id": Int.random(in: 1...999_999), "method": "tools/call", "params": ["name": name, "arguments": args]], token: mayaAgent)
    }

    // MARK: - First run

    /// Someone with no assistant connected (jules) signs in: "Bring your assistant", with a tile per provider; a tile
    /// opens its steps; Skip lands on For you, and the first run doesn't come back on the next launch.
    func testFirstRunSkip() throws {
        continueAfterFailure = false
        guard !julesApp.isEmpty else { throw XCTSkip("needs the seed (JULES_APP)") }
        let sessions = call("GET", "/api/sessions", token: julesApp)["sessions"] as? [Any] ?? []
        guard sessions.isEmpty else { throw XCTSkip("jules has an agent connected") }

        let a = everyday(token: julesApp, extra: ["AGENT_SOUP_FIRST_RUN": "1"])
        a.launch()
        XCTAssertTrue(a.staticTexts["bring-title"].waitForExistence(timeout: 20), "Bring your assistant")
        for p in ["grok", "muse", "chatgpt", "claude"] { XCTAssertTrue(a.buttons["connect-\(p)"].exists, "\(p) tile") }
        XCTAssertTrue(a.buttons["atteo-assistant"].exists, "Use Atteo's assistant")
        shot("everyday-01-first-run")

        // Muse has no one-tap path: its message to paste.
        a.buttons["connect-muse"].tap()
        XCTAssertTrue(a.navigationBars["Connect Muse"].waitForExistence(timeout: 5), "Muse's steps")
        XCTAssertTrue(a.staticTexts.matching(NSPredicate(format: "label CONTAINS '/mcp'")).firstMatch.exists, "the message carries Atteo's link")
        shot("everyday-02-connect-muse")
        a.navigationBars["Connect Muse"].buttons["Done"].tap()

        a.buttons["first-run-skip"].tap()
        forYou(a)
        XCTAssertFalse(a.staticTexts["bring-title"].exists, "skipped")
        shot("everyday-03-skipped")

        a.terminate()
        let b = everyday(token: julesApp)
        b.launch()
        forYou(b)
        sleep(3)
        XCTAssertFalse(b.staticTexts["bring-title"].exists, "the first run doesn't come back")
    }

    // MARK: - For you

    /// An OK maya's assistant asks for shows first on For you, in plain words; Approve answers it right there.
    func testForYouApproveInline() throws {
        continueAfterFailure = false
        guard !mayaAgent.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seed (MAYA_AGENT)") }
        let title = "Pay $42 to Lisa for the field trip (\(Int(Date().timeIntervalSince1970) % 100000))"
        tool("request_approval", board: b1, ["title": title, "details": "Museum $30 + lunch $12, Fri Oct 10", "risk": "medium", "wait_seconds": 0])
        let pending = call("GET", "/api/approvals")["approvals"] as? [[String: Any]] ?? []
        XCTAssertTrue(pending.contains { $0["title"] as? String == title }, "the approval is waiting")

        let a = everyday()
        a.launch()
        forYou(a)
        XCTAssertTrue(a.staticTexts["greeting"].waitForExistence(timeout: 5), "a greeting")
        let card = a.descendants(matching: .any)["ok-card"].firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 15), "Needs your OK")
        XCTAssertEqual(card.staticTexts["ok-title"].label, title, "the latest ask first")
        XCTAssertTrue(card.staticTexts["Needs your OK"].exists)
        XCTAssertTrue(a.staticTexts["needs-count"].label.contains("need"), a.staticTexts["needs-count"].label)
        XCTAssertFalse(a.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'risk'")).firstMatch.exists, "no risk label in Everyday")
        shot("everyday-04-for-you")

        card.buttons["ok-approve"].tap()
        XCTAssertTrue(eventually(a.staticTexts.matching(NSPredicate(format: "label == %@", title)).firstMatch, "exists == false", timeout: 8), "answered, it leaves")
        var approved = false
        for _ in 0..<10 where !approved {
            let all = call("GET", "/api/approvals?all=1")["approvals"] as? [[String: Any]] ?? []
            approved = all.contains { $0["title"] as? String == title && ($0["status"] as? String ?? "") == "approved" }
            if !approved { sleep(1) }
        }
        XCTAssertTrue(approved, "approved on the server")
        shot("everyday-05-approved")

        // The Ask bar opens the Ask screen (typing), with suggestions.
        a.buttons["ask-bar"].tap()
        XCTAssertTrue(a.descendants(matching: .any)["ask-screen"].waitForExistence(timeout: 5), "Ask")
        XCTAssertTrue(a.buttons["ask-try"].firstMatch.exists, "suggestions")
        shot("everyday-06-ask")
        XCTAssertTrue(a.descendants(matching: .any)["ask-switch"].firstMatch.waitForExistence(timeout: 5), "Talk instead / Type instead")
        a.buttons["ask-close"].tap()
        forYou(a)
    }

    // MARK: - Words

    /// In a chat, Everyday's words: a To-dos tab (no work strip), assistants (not agents) in the header, a result card
    /// in place of the change card, and no message numbers anywhere.
    func testVocabulary() throws {
        continueAfterFailure = false
        let a = everyday()
        a.launch()
        forYou(a)
        a.buttons["open-chats"].tap()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 10), "Chats")
        XCTAssertTrue(a.buttons["for-you"].exists, "back to For you")
        XCTAssertEqual(a.buttons["tab-boards"].label.components(separatedBy: ",").first, "Groups", "Boards are group chats")
        XCTAssertFalse(a.buttons["Your agents"].exists, "no sessions button")
        sleep(2)
        XCTAssertEqual(a.buttons.matching(NSPredicate(format: "label CONTAINS %@", "'s agent")).count, 0, "chat rows say assistant")
        openChat(a, "Checkout bug")

        let todos = a.buttons["tab-todos"]
        XCTAssertTrue(todos.waitForExistence(timeout: 5), "a To-dos tab")
        XCTAssertTrue(todos.label.hasPrefix("To-dos"), todos.label)
        XCTAssertFalse(a.buttons["work-strip"].exists, "no work strip")
        let presence = a.buttons["presence"]
        XCTAssertFalse(presence.label.contains("agent"), "assistants, not agents (\(presence.label))")
        XCTAssertEqual(a.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "^#[0-9]+$")).count, 0, "no message numbers")

        // The seeded "Shipped to production" change: a result card, never the commits.
        let result = a.descendants(matching: .any)["result-card"].firstMatch
        reveal(a, result, up: true, tries: 25)
        XCTAssertTrue(result.exists, "a result card")
        XCTAssertFalse(a.descendants(matching: .any)["change-card"].exists, "no change card")
        shot("everyday-07-chat")

        todos.tap()
        XCTAssertTrue(a.segmentedControls["work-pane"].buttons["To-dos"].waitForExistence(timeout: 5), "To-dos, not Tasks")
        XCTAssertEqual(a.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '#'")).count, 0, "no numbers in To-dos")
        XCTAssertEqual(a.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "'s agent")).count, 0, "assistants, not agents, in To-dos")
        shot("everyday-08-todos")
        a.buttons["Done"].tap()
    }

    // MARK: - Developer mode

    /// Settings → Advanced (for developers) → Developer mode: today's app comes back (Chats first, Boards, your agents,
    /// the work strip); switching it off again goes back to For you.
    func testDeveloperModeToggle() throws {
        continueAfterFailure = false
        let a = everyday()
        a.launch()
        forYou(a)
        a.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(a.navigationBars["Settings"].waitForExistence(timeout: 5))
        XCTAssertTrue(a.buttons["your-assistant"].waitForExistence(timeout: 5), "Your assistant")
        let dev = a.switches["developer-mode"]
        reveal(a, dev)
        // "Hittable" can still mean under the home indicator; bring it well inside the screen before tapping.
        for _ in 0..<3 where dev.exists && dev.frame.maxY > a.frame.maxY - 120 { a.swipeUp(velocity: .slow) }
        XCTAssertTrue(dev.exists, "the Developer mode switch")
        XCTAssertEqual(dev.value as? String, "0", "off in Everyday")
        shot("everyday-09-settings")
        dev.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()

        // Today's app.
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 10), "Chats is home again")
        XCTAssertFalse(a.navigationBars["For you"].exists)
        XCTAssertTrue(a.buttons["Your agents"].exists, "your agents' button")
        XCTAssertEqual(a.buttons["tab-boards"].label.components(separatedBy: ",").first, "Boards")
        openChat(a, "Checkout bug")
        XCTAssertFalse(a.buttons["tab-todos"].exists, "no Everyday tabs")
        XCTAssertTrue(a.buttons["work-strip"].waitForExistence(timeout: 5), "the work strip")
        shot("everyday-10-developer")
        a.navigationBars.buttons.element(boundBy: 0).tap()

        // And back: the switch is at the bottom of today's Settings.
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 5))
        a.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(a.navigationBars["Settings"].waitForExistence(timeout: 5))
        let back = a.switches["developer-mode"]
        reveal(a, back, tries: 20)
        // As above: well inside the screen, not under the home indicator (Display's Language row moved it down).
        for _ in 0..<3 where back.exists && back.frame.maxY > a.frame.maxY - 120 { a.swipeUp(velocity: .slow) }
        XCTAssertEqual(back.value as? String, "1", "on")
        back.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        forYou(a)
    }
}
