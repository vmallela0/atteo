// QA for "Invite an agent" (vedu #1812, InviteAgent.swift): from Checkout bug's Info, Your own assistant copies a join
// message with the board's id and never its title (board review #1920: the title is anyone's text, and the message is
// pasted to your assistant as your own instruction), with the exact developer lines folded under it; Invite a friend
// comes first and takes a name or any email (vedu #5192); and a board with nothing said yet offers the same from its
// empty chat. Same harness as the others (ios/qa/run.sh against a local server, seeded by
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
        XCTAssertTrue(a.buttons["invite-agent-friend"].exists, "Invite a friend")
        XCTAssertLessThan(a.buttons["invite-agent-friend"].frame.minY, own.frame.minY, "a friend first (vedu #5192)")
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

        // For developers (folded): the exact CLI command, MCP call, MCP URL and Claude Code line, each to copy.
        let cli = a.descendants(matching: .any)["invite-agent-dev-cli"].firstMatch
        XCTAssertFalse(cli.exists, "folded at first")
        let dev = a.buttons["For developers"].firstMatch
        for _ in 0..<4 where !(dev.exists && dev.isHittable) { a.swipeUp(velocity: .slow); sleep(1) }
        XCTAssertTrue(dev.isHittable, "For developers, under the assistants")
        dev.tap()
        XCTAssertTrue(cli.waitForExistence(timeout: 5), "the CLI command")
        XCTAssertEqual(cli.label, "atteo join \(id)")
        XCTAssertEqual(a.descendants(matching: .any)["invite-agent-dev-mcp-call"].firstMatch.label, "join_board(\"\(id)\")")
        let url = a.descendants(matching: .any)["invite-agent-dev-mcp-url"].firstMatch.label
        XCTAssertTrue(url.hasPrefix("http") && url.hasSuffix("/mcp"), "the MCP URL: \(url)")
        XCTAssertEqual(a.descendants(matching: .any)["invite-agent-dev-mcp-cc"].firstMatch.label, "claude mcp add --transport http --scope user atteo \(url)")
        a.swipeUp(velocity: .slow)
        let copyCC = a.buttons["invite-agent-dev-copy-mcp-cc"]
        XCTAssertTrue(copyCC.waitForExistence(timeout: 3) && copyCC.isHittable, "each line has Copy")
        save("invite-agent-own-dev")

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

    /// Info → Invite an agent → Invite a friend: a friend's name or anyone's email (they and their agents join once they
    /// accept). Nothing is sent.
    func testFriendPathTakesNameOrEmail() {
        continueAfterFailure = false
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        openInviteRow(a).tap()
        let friend = a.buttons["invite-agent-friend"]
        XCTAssertTrue(friend.waitForExistence(timeout: 5), "Invite a friend")
        friend.tap()
        let name = a.textFields["invite-agent-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5), "the friend's name or email field")
        XCTAssertEqual(name.placeholderValue, "A friend's name or email")
        XCTAssertTrue(a.navigationBars["Invite a friend"].exists, "titled Invite a friend")
        XCTAssertTrue(a.staticTexts["By name or email. They and their agents join once they accept."].exists, "what happens next")
        name.tap()
        name.typeText("priya@example.com")
        XCTAssertTrue(a.buttons["invite-agent-send"].waitForExistence(timeout: 3), "Invite shows once there's a name or email")
        save("invite-agent-friend")
    }

    /// Invite a friend by name, end to end on a fresh board (jules is maya's friend): one button, and the reply names
    /// them without their email.
    func testInviteFriendByName() throws {
        continueAfterFailure = false
        let title = "Friends welcome \(Int.random(in: 1000...9999))"
        // theo's board (maya's Free plan is full of seeded ones), maya in it as a contributor: viewers don't invite.
        let made = call("POST", "/api/boards", json: ["title": title, "encrypted": false], token: otherApp)
        let id = try XCTUnwrap((made["board"] as? [String: Any])?["id"] as? String, "theo makes a board: \(made)")
        defer { call("POST", "/api/boards/\(id)/archive", json: ["archived": true], token: otherApp) }
        let invited = call("POST", "/api/boards/\(id)/invites", json: ["to": "maya@example.com", "role": "contributor"], token: otherApp)
        XCTAssertEqual(call("POST", "/api/invitations/\(id)/accept")["_status"] as? Int, 200, "maya joins: \(invited)")
        let a = app()
        a.launch()
        openChat(a, title)
        let invite = a.buttons["invite-agent"].firstMatch
        XCTAssertTrue(invite.waitForExistence(timeout: 8), "the empty chat offers Invite an agent")
        invite.tap()
        let friend = a.buttons["invite-agent-friend"]
        XCTAssertTrue(friend.waitForExistence(timeout: 5))
        friend.tap()
        let name = a.textFields["invite-agent-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap()
        name.typeText("jules")
        a.buttons["invite-agent-send"].tap()
        let sent = a.staticTexts["invite-agent-sent"]
        XCTAssertTrue(sent.waitForExistence(timeout: 8), "the invite went out")
        XCTAssertTrue(sent.label.contains("jules") && !sent.label.contains("@"), "names them, never their email: \(sent.label)")
        save("invite-agent-friend-sent")
    }

    /// A board nobody has written on yet (theo's, maya invited): its empty chat offers Invite an agent.
    func testEmptyChatOffersInviteAgent() throws {
        continueAfterFailure = false
        let title = "Fresh start \(Int.random(in: 1000...9999))"
        let made = call("POST", "/api/boards", json: ["title": title, "encrypted": false], token: otherApp)
        let id = try XCTUnwrap((made["board"] as? [String: Any])?["id"] as? String, "theo makes a board: \(made)")
        defer { call("POST", "/api/boards/\(id)/archive", json: ["archived": true], token: otherApp) } // theo's Free plan has room next run
        let invited = call("POST", "/api/boards/\(id)/invites", json: ["to": "maya@example.com", "role": "contributor"], token: otherApp) // viewers don't invite
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
