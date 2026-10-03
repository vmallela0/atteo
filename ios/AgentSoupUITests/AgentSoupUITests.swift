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

    /// Back, inside a sheet: its navigation bar is the last one (the chat's own sits underneath).
    func sheetBack(_ a: XCUIApplication) {
        let bars = a.navigationBars
        bars.element(boundBy: bars.count - 1).buttons.element(boundBy: 0).tap()
        sleep(1)
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
        // Boards and DMs are separate: switch to DMs, the DM shows the other person; open it, come back.
        a.buttons["tab-direct"].tap()
        let dm = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chat-' AND identifier CONTAINS 'priya'")).firstMatch
        XCTAssertTrue(dm.waitForExistence(timeout: 5), "the DM with priya is under DMs")
        XCTAssertFalse(a.buttons.matching(NSPredicate(format: "identifier == 'chat-Checkout bug'")).firstMatch.exists, "boards aren't under DMs")
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
        // Reply to a specific message: swipe it right (like any messenger) or long-press → Reply; a slim
        // "Replying to" line (✕ cancels), and the reply quotes what it answers.
        let parent = a.staticTexts["posted while you read history"]
        if parent.exists && parent.isHittable {
            let from = parent.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
            from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 140, dy: 0)), withVelocity: .fast, thenHoldForDuration: 0)
            XCTAssertTrue(a.descendants(matching: .any)["replying-to"].waitForExistence(timeout: 3), "swiping a message right starts a reply")
            shot("07b-swiped")
            a.buttons["Cancel reply"].tap()
            XCTAssertFalse(a.descendants(matching: .any)["replying-to"].waitForExistence(timeout: 1), "✕ cancels it")
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

    /// The web's features in the app (#508): an approval in full (approve with a note), act on tasks (claim, status,
    /// tick a checklist line, add one, remove it), read a file and an older version, the board's info, then New
    /// message → a friend → Message opens your DM, and New board makes one and opens it.
    func testWebParity() throws {
        continueAfterFailure = false
        let a = app(fresh: true)
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 10))
        onBoards(a)
        let any = a.descendants(matching: .any)

        // 1. An approval, in full: tap the row (not the quick ✓), read it, add a note, approve.
        let row = any["approval-row"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "an approval is waiting")
        let neededBefore = a.staticTexts["needs-you"].label // "Needs you · 3"
        row.tap()
        let approve = a.buttons["approval-approve"]
        XCTAssertTrue(approve.waitForExistence(timeout: 5), "the approval opens in full")
        let title = any["approval-title"].firstMatch.label
        XCTAssertTrue(a.staticTexts["What will happen"].exists)
        shot("p01-approval")
        let note = any["approval-note"].firstMatch
        note.tap()
        note.typeText("OK, after 6pm")
        approve.tap()
        let closed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: approve)
        wait(for: [closed], timeout: 8)
        // Approved: it left Needs you ("· 3" → "· 2", or the section goes when it was the last thing).
        XCTAssertFalse(title.isEmpty)
        let before = Int(neededBefore.split(separator: " ").last ?? "") ?? 0
        let header = a.staticTexts["needs-you"]
        let answered = expectation(for: before > 1 ? NSPredicate(format: "label == %@", "Needs you · \(before - 1)") : NSPredicate(format: "exists == false"), evaluatedWith: header)
        wait(for: [answered], timeout: 5)

        // 2. Tasks you can act on.
        let chat = a.buttons["chat-Checkout bug"].firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 5))
        chat.tap()
        let strip = a.buttons["work-strip"]
        XCTAssertTrue(strip.waitForExistence(timeout: 10))
        strip.tap()
        XCTAssertTrue(a.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH 'Work on'")).firstMatch.waitForExistence(timeout: 5))
        a.swipeUp() // the sheet to full height
        let task = any["task-row-Write the incident note"].firstMatch
        XCTAssertTrue(task.waitForExistence(timeout: 5), "the task is in the list")
        task.tap()
        let claim = a.buttons["task-claim"]
        XCTAssertTrue(claim.waitForExistence(timeout: 5))
        XCTAssertEqual(claim.label, "Claim")
        claim.tap()
        let held = expectation(for: NSPredicate(format: "label == 'Release'"), evaluatedWith: claim)
        wait(for: [held], timeout: 5)
        // Tick a checklist line by tapping it; the server has the tick.
        let line = a.buttons["check-timeline of the outage"]
        XCTAssertTrue(line.exists)
        XCTAssertEqual(line.value as? String, "not done")
        line.tap()
        let ticked = expectation(for: NSPredicate(format: "value == 'done'"), evaluatedWith: line)
        wait(for: [ticked], timeout: 5)
        if let tick = env["AGENT_SOUP_TICK"], let server = env["AGENT_SOUP_SERVER"], let token = env["AGENT_SOUP_TOKEN"] {
            let board = String(tick.split(separator: ":")[0])
            var body = ""
            for _ in 0..<10 {
                var r = URLRequest(url: URL(string: "\(server)/api/boards/\(board)/tasks")!)
                r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
                let got = expectation(description: "tasks")
                URLSession.shared.dataTask(with: r) { d, _, _ in body = String(data: d ?? Data(), encoding: .utf8) ?? ""; got.fulfill() }.resume()
                wait(for: [got], timeout: 10)
                if body.contains("- [x] timeline of the outage") { break }
                sleep(1)
            }
            XCTAssertTrue(body.contains("- [x] timeline of the outage"), "the tick reached the server")
        }
        // Where it stands, from a compact menu.
        a.buttons["task-status"].tap()
        a.buttons["In progress"].firstMatch.tap()
        let moved = expectation(for: NSPredicate(format: "value == 'In progress'"), evaluatedWith: a.buttons["task-status"])
        wait(for: [moved], timeout: 5)
        shot("p02-task-acted")
        sheetBack(a) // back to the list

        // Add a task (with one checklist step), then remove it.
        a.buttons["New task"].tap()
        let newTitle = "Draft the postmortem \(Int(Date().timeIntervalSince1970) % 100000)"
        let field = any["new-task-title"].firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText(newTitle + "\n")
        a.typeText("Collect the graphs")
        shot("p03-new-task")
        a.buttons["new-task-add"].tap()
        let added = any["task-row-\(newTitle)"].firstMatch
        XCTAssertTrue(added.waitForExistence(timeout: 8), "the new task is in the list")
        added.tap()
        XCTAssertTrue(a.buttons["check-Collect the graphs"].waitForExistence(timeout: 5), "with its checklist")
        a.buttons["More"].tap()
        a.buttons["Remove task"].firstMatch.tap()
        let confirm = a.sheets.buttons["Remove task"].exists ? a.sheets.buttons["Remove task"] : a.buttons.matching(NSPredicate(format: "label == 'Remove task'")).element(boundBy: 0)
        XCTAssertTrue(confirm.waitForExistence(timeout: 3), "asks first")
        shot("p04-remove-task")
        confirm.tap()
        XCTAssertTrue(a.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH 'Work on'")).firstMatch.waitForExistence(timeout: 8), "back to the list")
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: any["task-row-\(newTitle)"].firstMatch)
        wait(for: [gone], timeout: 8)

        // 3. Files: a doc, read; an older version from the picker.
        a.buttons["Files"].tap()
        let file = a.buttons["file-rollout-plan.md"].exists ? a.buttons["file-rollout-plan.md"] : any["file-rollout-plan.md"].firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 8), "the board's files")
        shot("p05-files")
        file.tap()
        XCTAssertTrue(a.staticTexts["Rollout plan"].waitForExistence(timeout: 8), "the doc, as text")
        XCTAssertTrue(a.staticTexts["Rollback"].exists, "its latest version")
        shot("p06-doc")
        let picker = a.buttons["doc-version"]
        XCTAssertTrue(picker.waitForExistence(timeout: 5))
        picker.tap()
        a.buttons.matching(NSPredicate(format: "label BEGINSWITH 'v1'")).firstMatch.tap()
        XCTAssertTrue(a.staticTexts["Older version"].waitForExistence(timeout: 5), "an older version")
        XCTAssertFalse(a.staticTexts["Rollback"].exists, "as it was then")
        shot("p07-doc-v1")
        sheetBack(a)
        sheetBack(a)
        a.buttons["Done"].tap()

        // 4. The board's info: members, invite, files, rename / archive (from who's here).
        let presence = a.buttons["presence"]
        XCTAssertTrue(presence.waitForExistence(timeout: 5))
        presence.tap()
        XCTAssertTrue(a.navigationBars["Agents here"].waitForExistence(timeout: 5))
        a.buttons["Board info"].tap()
        XCTAssertTrue(any["board-info-title"].firstMatch.waitForExistence(timeout: 5))
        if a.buttons["invite-link"].exists {
            a.buttons["invite-link"].tap()
            XCTAssertTrue(a.buttons["Copy link"].waitForExistence(timeout: 5), "an invite link")
        }
        XCTAssertTrue(a.staticTexts["theo"].waitForExistence(timeout: 5), "members")
        shot("p08-board-info")
        a.buttons["Done"].firstMatch.tap()
        sleep(1)
        if a.navigationBars["Agents here"].exists { a.swipeDown(velocity: .fast); sleep(1) }
        a.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 5))

        // 5. New message → a friend → Message: your DM opens.
        a.buttons["New"].tap()
        a.buttons["New message"].tap()
        let search = any["people-search"].firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.typeText("jul")
        let jules = any["person-jules"].firstMatch
        XCTAssertTrue(jules.waitForExistence(timeout: 8), "search finds jules")
        shot("p09-new-message")
        jules.tap()
        let message = a.buttons["person-message"]
        XCTAssertTrue(message.waitForExistence(timeout: 5), "a friend: Message")
        shot("p10-person")
        message.tap()
        let dm = expectation(for: NSPredicate(format: "label BEGINSWITH 'jules'"), evaluatedWith: a.buttons["presence"])
        wait(for: [dm], timeout: 10)
        shot("p11-dm")
        a.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chat-' AND identifier CONTAINS 'jules'")).firstMatch.waitForExistence(timeout: 5), "the DM is under DMs")

        // 6. Archive a board from its info (it closes and leaves the list), which makes room on the Free plan for…
        a.buttons["tab-boards"].tap()
        let q4 = a.buttons["chat-Q4 data migration"].firstMatch
        XCTAssertTrue(q4.waitForExistence(timeout: 5))
        q4.tap()
        XCTAssertTrue(a.buttons["presence"].waitForExistence(timeout: 5))
        a.buttons["presence"].tap()
        XCTAssertTrue(a.buttons["Board info"].waitForExistence(timeout: 5))
        a.buttons["Board info"].tap()
        let archive = a.buttons["board-archive"]
        XCTAssertTrue(archive.waitForExistence(timeout: 5), "the board's owner can archive it")
        archive.tap()
        let sure = a.buttons.matching(NSPredicate(format: "label == 'Archive' AND identifier != 'board-archive'")).firstMatch
        XCTAssertTrue(sure.waitForExistence(timeout: 3), "asks first")
        sure.tap()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 10), "an archived board closes")
        let left = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: a.buttons["chat-Q4 data migration"].firstMatch)
        wait(for: [left], timeout: 8)

        // 7. …a new board: a title, encrypted by default; it opens.
        a.buttons["New"].tap()
        a.buttons["New board"].tap()
        let bt = any["new-board-title"].firstMatch
        XCTAssertTrue(bt.waitForExistence(timeout: 5))
        let boardTitle = "Launch week \(Int(Date().timeIntervalSince1970) % 100000)"
        bt.typeText(boardTitle)
        shot("p12-new-board")
        a.buttons["new-board-create"].tap()
        let opened = expectation(for: NSPredicate(format: "label BEGINSWITH %@", boardTitle), evaluatedWith: a.buttons["presence"])
        wait(for: [opened], timeout: 10)
        shot("p13-new-board-open")
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
