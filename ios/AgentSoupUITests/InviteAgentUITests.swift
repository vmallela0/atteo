// QA for "Invite an agent" (vedu #1812, InviteAgent.swift): from Checkout bug's Info, Your own assistant copies a join
// message with the board's id and never its title (board review #1920: the title is anyone's text, and the message is
// pasted to your assistant as your own instruction); A friend's agent asks for a name; and a board with nothing said yet
// offers the same from its empty chat. Same harness as the others (ios/qa/run.sh against a local server, seeded by
// ios/qa/seed.mjs). TEST_RUNNER_INVITE_SHOTS=<dir> also writes the screenshots there as PNGs.

import XCTest

final class InviteAgentUITests: AtteoUITestCase {
    func save(_ name: String) {
        shot(name)
        guard let dir = env["INVITE_SHOTS"], !dir.isEmpty else { return }
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
    }

    /// The chat's Info (from its title), scrolled to "Invite an agent".
    func openInviteRow(_ a: XCUIApplication) -> XCUIElement {
        a.buttons["presence"].tap()
        XCTAssertTrue(a.navigationBars["Info"].waitForExistence(timeout: 5), "the board's info opens")
        sleep(1)
        let row = a.buttons["invite-agent"].firstMatch
        for _ in 0..<6 where !(row.exists && row.isHittable) { a.swipeUp(velocity: .slow); sleep(1) }
        XCTAssertTrue(row.waitForExistence(timeout: 5) && row.isHittable, "Invite an agent is in Info, on screen")
        return row
    }

    /// Info → Invite an agent → Your own assistant → Copy: the board's join message, with its id and not its title.
    func testOwnAssistantCopiesIdNotTitle() throws {
        continueAfterFailure = false
        let id = try XCTUnwrap(boardId(titled: "Checkout bug"), "the seeded Checkout bug")
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let row = openInviteRow(a)
        save("invite-agent-info-row")
        row.tap()

        let own = a.buttons["invite-agent-own"]
        XCTAssertTrue(own.waitForExistence(timeout: 5), "Your own assistant")
        XCTAssertTrue(a.buttons["invite-agent-friend"].exists, "A friend's agent")
        sleep(1)
        save("invite-agent-sheet")
        own.tap()

        let message = a.descendants(matching: .any)["invite-agent-message"].firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 5), "the join message")
        XCTAssertEqual(message.label, "Join the Atteo board \(id): run atteo join \(id), or call join_board with \"\(id)\" if you use the Atteo connector. Then read it.")
        XCTAssertFalse(message.label.contains("Checkout bug"), "never the board's title")
        XCTAssertTrue(a.buttons["invite-agent-open-claude"].exists, "Claude's chat is a tap away")
        XCTAssertTrue(a.buttons["invite-agent-open-muse"].exists, "and Muse's (vedu #2298)")
        a.buttons["invite-agent-copy"].tap()
        XCTAssertTrue(a.descendants(matching: .any)["invite-agent-copied"].firstMatch.waitForExistence(timeout: 5), "Copied. Now paste it.")
        save("invite-agent-own")

        // What was copied, read the way a person would: pasted into the chat's message box (reading the pasteboard from
        // the test runner would ask "Allow Paste?"), then cleared.
        a.buttons["invite-agent-done"].firstMatch.tap() // closes Invite an agent
        XCTAssertTrue(a.navigationBars["Info"].waitForExistence(timeout: 5))
        a.navigationBars["Info"].buttons["Done"].tap()
        let box = composer(a)
        XCTAssertTrue(box.waitForExistence(timeout: 5))
        box.tap()
        sleep(1)
        box.press(forDuration: 1.0)
        let paste = a.descendants(matching: .any).matching(NSPredicate(format: "label == 'Paste' AND (elementType == %d OR elementType == %d)",
                                                                        XCUIElement.ElementType.menuItem.rawValue, XCUIElement.ElementType.button.rawValue)).firstMatch
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "Paste in the edit menu")
        paste.tap()
        XCTAssertTrue(eventually(box, "value CONTAINS 'atteo join'"), "the join message pasted")
        let pasted = box.value as? String ?? ""
        XCTAssertTrue(pasted.contains("Join the Atteo board \(id):"), "the board's id: \(pasted)")
        XCTAssertFalse(pasted.contains("Checkout bug"), "not its title: \(pasted)")
        box.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: pasted.count + 4))
        XCTAssertTrue(eventually(box, "NOT (value CONTAINS 'atteo join')"), "the box is cleared")
    }

    /// Your own assistant → Grok's Open (vedu #2298): copies the join message and opens Grok's app, or grok.com without
    /// it (the simulator has no Grok app: Safari). Coming back to Atteo, the chat's sheets have closed (any trip out of
    /// the app does that, Home and back too), so this checks Safari came up and Atteo is back without a crash; the copy
    /// itself is testOwnAssistantCopiesIdNotTitle's, and ConnectAgentUITests sees "Copied." after a trip to Safari.
    func testOwnAssistantOpenGrok() throws {
        continueAfterFailure = false
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        openInviteRow(a).tap()
        let own = a.buttons["invite-agent-own"]
        XCTAssertTrue(own.waitForExistence(timeout: 5), "Your own assistant")
        own.tap()
        let open = a.buttons["invite-agent-open-grok"]
        XCTAssertTrue(open.waitForExistence(timeout: 5), "Grok's Open")
        save("invite-agent-open-grok")
        open.tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 15), "no Grok app here: grok.com, in Safari")
        a.activate()
        XCTAssertTrue(a.wait(for: .runningForeground, timeout: 10), "back in Atteo, no crash")

        let box = composer(a)
        XCTAssertTrue(box.waitForExistence(timeout: 10), "the chat")
    }

    /// Info → Invite an agent → A friend's agent: a name to invite (their agents join once they accept). Nothing is sent.
    func testFriendPathAsksForAName() {
        continueAfterFailure = false
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        openInviteRow(a).tap()
        let friend = a.buttons["invite-agent-friend"]
        XCTAssertTrue(friend.waitForExistence(timeout: 5), "A friend's agent")
        friend.tap()
        let name = a.textFields["invite-agent-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5), "the friend's name field")
        XCTAssertTrue(a.staticTexts["Invite the friend to this board. Their agents join once they accept."].exists, "what happens next")
        name.tap()
        name.typeText("priya")
        XCTAssertTrue(a.buttons["invite-agent-send"].waitForExistence(timeout: 3), "Invite shows once there's a name")
        save("invite-agent-friend")
    }

    /// A board nobody has written on yet (theo's, maya invited): its empty chat offers Invite an agent.
    func testEmptyChatOffersInviteAgent() throws {
        continueAfterFailure = false
        let title = "Fresh start \(Int.random(in: 1000...9999))"
        let made = call("POST", "/api/boards", json: ["title": title, "encrypted": false], token: otherApp)
        let id = try XCTUnwrap((made["board"] as? [String: Any])?["id"] as? String, "theo makes a board: \(made)")
        defer { call("POST", "/api/boards/\(id)/archive", json: ["archived": true], token: otherApp) } // theo's Free plan has room next run
        let invited = call("POST", "/api/boards/\(id)/invites", json: ["to": "maya@example.com"], token: otherApp)
        let joined = call("POST", "/api/invitations/\(id)/accept")
        XCTAssertEqual(joined["_status"] as? Int, 200, "maya joins: \(invited) \(joined)")

        let a = app()
        a.launch()
        openChat(a, title)
        let invite = a.buttons["invite-agent"]
        XCTAssertTrue(invite.waitForExistence(timeout: 8), "the empty chat offers Invite an agent")
        XCTAssertTrue(a.staticTexts["Nothing here yet"].exists)
        sleep(1)
        save("invite-agent-empty-chat")
        invite.tap()
        XCTAssertTrue(a.buttons["invite-agent-own"].waitForExistence(timeout: 5), "the same two choices")
        XCTAssertTrue(a.buttons["invite-agent-friend"].exists)
    }

    /// Going to another app and coming back (vedu: Invite an agent "closed" when he did): Your own assistant's page
    /// stays open, with Invite an agent and Info under it. Both ways out: the Home button, and Open
    /// Claude itself (Safari on the simulator), where the page used to go back to the two choices once the app redrew.
    func testSheetsSurviveBackground() throws {
        continueAfterFailure = false
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        openInviteRow(a).tap()
        XCTAssertTrue(a.buttons["invite-agent-own"].waitForExistence(timeout: 5), "Invite an agent is open")
        a.buttons["invite-agent-own"].tap()
        let message = a.descendants(matching: .any)["invite-agent-message"].firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 5), "Your own assistant's page")
        a.buttons["invite-agent-copy"].tap()
        XCTAssertTrue(a.descendants(matching: .any)["invite-agent-copied"].firstMatch.waitForExistence(timeout: 5))

        XCUIDevice.shared.press(.home)
        sleep(3)
        a.activate()
        XCTAssertTrue(message.waitForExistence(timeout: 5), "still on the page after Home and back")
        sleep(5) // the refresh on coming back lands
        XCTAssertTrue(message.exists, "still on the page once the app has refreshed")

        let open = a.buttons["invite-agent-open-claude"]
        XCTAssertTrue(open.waitForExistence(timeout: 5))
        open.tap()
        sleep(6)
        a.activate()
        sleep(5)
        XCTAssertTrue(message.exists, "still on the page after Open Claude and back")
        save("invite-agent-after-background")

        a.buttons["invite-agent-done"].firstMatch.tap()
        XCTAssertTrue(a.navigationBars["Info"].waitForExistence(timeout: 5), "Info is still under it")
    }
}
