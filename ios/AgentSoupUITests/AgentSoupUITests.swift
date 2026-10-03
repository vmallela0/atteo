// QA: drives the app like a person (tap, swipe, type) against a local server seeded with test data, and keeps a
// screenshot of every step. Run: TEST_RUNNER_AGENT_SOUP_SERVER=… TEST_RUNNER_AGENT_SOUP_TOKEN=… [TEST_RUNNER_AGENT_SOUP_TICK=board:seq
// TEST_RUNNER_AGENT_SOUP_OTHER_TOKEN=another member] xcodebuild test …

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

    /// Clears a text field (deletes what's there) and types new text.
    func replace(_ field: XCUIElement, with text: String) {
        field.tap()
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.85)).tap() // caret at the end
        let current = field.value as? String ?? ""
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2) + text)
    }

    /// Start on Boards, whatever tab the last run left selected.
    func onBoards(_ a: XCUIApplication) {
        let t = a.buttons["tab-boards"]
        if t.waitForExistence(timeout: 10) { t.tap() }
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
        onBoards(a)
        let chat = a.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'chat-'")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "chats load")
        // Boards and DMs are separate: switch to Direct, the DM shows the other person; open it, come back.
        a.buttons["tab-direct"].tap()
        let dm = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chat-' AND identifier CONTAINS 'priya'")).firstMatch
        XCTAssertTrue(dm.waitForExistence(timeout: 5), "the DM with priya is under Direct")
        XCTAssertFalse(a.buttons.matching(NSPredicate(format: "identifier == 'chat-Checkout bug'")).firstMatch.exists, "boards aren't under Direct")
        shot("02a-direct")
        dm.tap()
        XCTAssertTrue(a.navigationBars.matching(NSPredicate(format: "identifier == 'priya'")).firstMatch.waitForExistence(timeout: 5) || a.buttons["presence"].label.hasPrefix("priya"), "the DM is titled with the other person")
        a.navigationBars.buttons.element(boundBy: 0).tap()
        a.buttons["tab-boards"].tap()
        // The board theo's session is working on says so in the list.
        XCTAssertTrue(a.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'working now'")).firstMatch.waitForExistence(timeout: 8), "live agents show in Chats")
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

        // Open a chat (the freshly seeded one, whose latest line is "Ship"), send a message, see it land.
        let seeded = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chat-' AND label CONTAINS 'Ship'")).firstMatch
        (seeded.exists ? seeded : chat).tap()
        let composer = a.textFields["composer"].exists ? a.textFields["composer"] : a.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "board opens")
        // Who's working here right now, under the title; tap for everyone (live / idle / gone).
        let presence = a.buttons["presence"]
        XCTAssertTrue(presence.waitForExistence(timeout: 5))
        let live = expectation(for: NSPredicate(format: "label CONTAINS 'working' AND NOT (label CONTAINS 'No agents')"), evaluatedWith: presence)
        wait(for: [live], timeout: 8)
        presence.tap()
        XCTAssertTrue(a.navigationBars["Agents here"].waitForExistence(timeout: 5), "who's here")
        XCTAssertTrue(a.staticTexts["fixing the empty-cart guard"].waitForExistence(timeout: 5), "what the live session is doing")
        shot("04a-agents-here")
        a.swipeDown(velocity: .fast)
        sleep(1)
        // Like any messenger: the chat opens at the newest message, not the oldest.
        let newest = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'task-card-' AND label BEGINSWITH 'Ship'")).firstMatch
        XCTAssertTrue(newest.waitForExistence(timeout: 5) && newest.isHittable, "opens at the newest message")
        XCTAssertFalse(a.staticTexts["Earlier: checked the retry path, step 0"].isHittable, "not at the top")
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
        // Reading history: a new message doesn't pull you down; a jump-to-latest button appears instead.
        // (posted by another member: your own messages always scroll into view)
        if let tick = env["AGENT_SOUP_TICK"], let server = env["AGENT_SOUP_SERVER"], let token = env["AGENT_SOUP_OTHER_TOKEN"] {
            a.swipeDown(velocity: .fast); a.swipeDown(velocity: .fast)
            sleep(1)
            var r = URLRequest(url: URL(string: "\(server)/api/boards/\(tick.split(separator: ":")[0])/entries")!)
            r.httpMethod = "POST"
            r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.httpBody = try JSONSerialization.data(withJSONObject: ["type": "note", "text": "posted while you read history", "read": true])
            let posted = expectation(description: "posted")
            URLSession.shared.dataTask(with: r) { _, _, _ in posted.fulfill() }.resume()
            wait(for: [posted], timeout: 10)
            let jump = a.buttons["Jump to latest"]
            XCTAssertTrue(jump.waitForExistence(timeout: 5), "scrolled up: a jump button, not a yank")
            sleep(1)
            XCTAssertFalse(a.staticTexts["posted while you read history"].isHittable, "you stay where you were reading")
            shot("04d-reading")
            jump.tap()
            XCTAssertTrue(a.staticTexts["posted while you read history"].waitForExistence(timeout: 3), "jump goes to the latest")
            sleep(1)
        }
        composer.tap()
        // @ suggests who's here (people and their agents); one tap puts the mention in the message.
        composer.typeText("@th")
        let mention = a.buttons["mention-theo's agent"]
        XCTAssertTrue(mention.waitForExistence(timeout: 5), "@ suggests theo's agent")
        shot("05a-mention")
        mention.tap()
        XCTAssertEqual(composer.value as? String, "@theo's agent ", "the mention is in the message box")
        let tail = "QA from the phone \(Int(Date().timeIntervalSince1970) % 100000)"
        composer.typeText(tail)
        let msg = "@theo's agent " + tail
        shot("05-typing")
        a.buttons["send"].tap()
        XCTAssertTrue(a.staticTexts[msg].waitForExistence(timeout: 3), "the message shows at once")
        shot("06-sending")
        let sending = a.staticTexts["Sending…"]
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: sending)
        wait(for: [gone], timeout: 10)
        shot("07-sent")
        // theo's agent reads it: a 👀 receipt shows under your message, live.
        if let tick = env["AGENT_SOUP_TICK"], let server = env["AGENT_SOUP_SERVER"], let other = env["AGENT_SOUP_OTHER_TOKEN"] {
            var r = URLRequest(url: URL(string: "\(server)/mcp?board=\(tick.split(separator: ":")[0])")!)
            r.httpMethod = "POST"
            r.setValue("Bearer \(other)", forHTTPHeaderField: "authorization")
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.setValue("application/json, text/event-stream", forHTTPHeaderField: "accept")
            r.httpBody = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": ["name": "read", "arguments": [String: String]()]])
            let read = expectation(description: "theo's agent reads")
            URLSession.shared.dataTask(with: r) { _, _, _ in read.fulfill() }.resume()
            wait(for: [read], timeout: 10)
            let seen = a.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Seen, working: theo's agent")).firstMatch
            XCTAssertTrue(seen.waitForExistence(timeout: 6), "👀 from theo's agent under your message")
            let visible = expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: seen)
            wait(for: [visible], timeout: 3) // on screen, not tucked under the message box
            shot("07a-seen")
        }
        // Reply to a specific message: long-press → Reply, a slim "Replying to" line, and the reply quotes it.
        let parent = a.staticTexts["posted while you read history"]
        if parent.exists && parent.isHittable {
            parent.press(forDuration: 0.8)
            let replyItem = a.buttons["Reply"]
            XCTAssertTrue(replyItem.waitForExistence(timeout: 3), "long-press offers Reply")
            replyItem.tap()
            XCTAssertTrue(a.descendants(matching: .any)["replying-to"].waitForExistence(timeout: 3), "a Replying-to line above the message box")
            shot("07b-replying")
            let answer = "On it \(Int(Date().timeIntervalSince1970) % 100000)"
            composer.typeText(answer)
            a.buttons["send"].tap()
            XCTAssertTrue(a.staticTexts[answer].waitForExistence(timeout: 3), "the reply shows at once")
            let quote = a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'reply-quote' AND label CONTAINS 'posted while you read history'")).firstMatch
            XCTAssertTrue(quote.waitForExistence(timeout: 5), "the reply quotes what it answers")
            let sent = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: a.staticTexts["Sending…"])
            wait(for: [sent], timeout: 10)
            XCTAssertTrue(quote.exists, "and keeps the quote once it's sent")
            XCTAssertFalse(a.descendants(matching: .any)["replying-to"].exists, "the Replying-to line is gone")
            shot("07c-replied")
        }

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

    /// Settings from the app: your picture (from the photo library), your name, your agent's line, and back again.
    func testSettings() throws {
        let a = app(fresh: true)
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 10))
        a.buttons["Settings"].tap()
        let name = a.textFields["display-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5), "settings open")
        shot("12-settings")
        let newName = "Maya \(Int(Date().timeIntervalSince1970) % 1000)"
        replace(name, with: newName)
        let summary = a.textFields["agent-summary"]
        replace(summary, with: "Knows our Stripe setup")
        a.navigationBars["Settings"].staticTexts["Settings"].tap() // keyboard down
        a.swipeDown() // back to the pictures
        // A new picture: pick the first photo in the library (the simulator ships with a few).
        a.buttons["Change your picture"].tap()
        if a.scrollViews.images.firstMatch.waitForExistence(timeout: 8) {
            sleep(1)
            // The picker runs in another process; tap the first photo in its grid (below the privacy note).
            a.coordinate(withNormalizedOffset: CGVector(dx: 0.17, dy: 0.47)).tap()
            sleep(2)
            shot("13-picture")
            let r = URLRequest(url: URL(string: "\(env["AGENT_SOUP_SERVER"] ?? "http://localhost:8788")/avatar/maya?k=person&v=\(UUID())")!)
            var status = 0
            let got = expectation(description: "avatar")
            URLSession.shared.dataTask(with: r) { _, resp, _ in status = (resp as? HTTPURLResponse)?.statusCode ?? 0; got.fulfill() }.resume()
            wait(for: [got], timeout: 10)
            XCTAssertEqual(status, 200, "the picture reached the server")
        } else {
            shot("13-no-photos")
            if a.buttons["Cancel"].exists { a.buttons["Cancel"].tap() }
        }
        a.buttons["Done"].tap()
        sleep(1)
        // Reopen: the edits stuck.
        a.buttons["Settings"].tap()
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        let saved = expectation(for: NSPredicate(format: "value == %@", newName), evaluatedWith: name)
        wait(for: [saved], timeout: 5)
        XCTAssertEqual(summary.value as? String, "Knows our Stripe setup", "your agent's line saved")
        shot("14-saved")
        a.buttons["Done"].tap()
    }

    /// An end-to-end encrypted board: the phone encrypts what you send, theo's client (another device, another
    /// person) decrypts it and answers, and the phone decrypts the answer. The server only ever has ciphertext.
    func testEncryptedChat() throws {
        guard env["AGENT_SOUP_ENC"] != nil else { throw XCTSkip("needs the encrypted-board seed (enc-peer.mjs running)") }
        let a = app(fresh: true)
        a.launch()
        onBoards(a)
        let chat = a.buttons.matching(NSPredicate(format: "identifier == 'chat-Secret plans'")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "the encrypted board is in Chats")
        chat.tap()
        let composer = a.textFields["composer"].exists ? a.textFields["composer"] : a.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        let msg = "hello encrypted \(Int(Date().timeIntervalSince1970) % 100000)"
        composer.tap()
        composer.typeText(msg)
        a.buttons["send"].tap()
        let sent = a.staticTexts[msg]
        XCTAssertTrue(sent.waitForExistence(timeout: 5), "your message shows in plain text here")
        XCTAssertFalse(a.staticTexts["Not sent. Tap to retry"].waitForExistence(timeout: 4), "it was encrypted and sent")
        // theo's client decrypts it and answers; the answer arrives over the live socket and is decrypted here.
        XCTAssertTrue(a.staticTexts["theo read: \(msg)"].waitForExistence(timeout: 20), "theo read it, and the phone read theo's answer")
        shot("15-encrypted")
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
