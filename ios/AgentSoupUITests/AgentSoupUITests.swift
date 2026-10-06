// QA: drives the app like a person (tap, swipe, type) against a local server seeded with test data, and keeps a
// screenshot of every step. Run: TEST_RUNNER_AGENT_SOUP_SERVER=… TEST_RUNNER_AGENT_SOUP_TOKEN=… [TEST_RUNNER_AGENT_SOUP_TICK=board:seq
// TEST_RUNNER_AGENT_SOUP_OTHER_TOKEN=another member] xcodebuild test …

import UIKit
import UniformTypeIdentifiers
import XCTest

final class AgentSoupUITests: XCTestCase {
    let env = ProcessInfo.processInfo.environment

    func app(fresh: Bool) -> XCUIApplication {
        let a = XCUIApplication()
        a.launchEnvironment["AGENT_SOUP_LANG"] = "en" // English words whatever the simulator speaks (Language.swift)
        a.launchEnvironment["AGENT_SOUP_MODE"] = "developer" // today's app (Everyday.swift); Everyday tests opt in with "everyday"
        a.launchEnvironment["AGENT_SOUP_SERVER"] = env["AGENT_SOUP_SERVER"] ?? "http://localhost:8788"
        a.launchEnvironment["AGENT_SOUP_STILL"] = "1" // no endless animations: they keep the app from ever being idle for the test
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

    /// A text box by its identifier, whichever kind it is (a one-line field, or a text view that grows).
    func field(_ a: XCUIApplication, _ id: String) -> XCUIElement {
        a.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ AND (elementType == %d OR elementType == %d)", id,
                                                           XCUIElement.ElementType.textView.rawValue, XCUIElement.ElementType.textField.rawValue)).firstMatch
    }

    /// Start on Boards, whatever tab the last run left selected.
    func onBoards(_ a: XCUIApplication) {
        let t = a.buttons["tab-boards"]
        if t.waitForExistence(timeout: 10) { t.tap() }
    }

    /// Back, inside a sheet: its navigation bar is the last one (the chat's own sits underneath).
    /// Back one step in the top sheet: its back button, if it has one (at a sheet's root there's none, and its first
    /// button is something else, like Files' sort menu).
    func sheetBack(_ a: XCUIApplication) {
        let bars = a.navigationBars
        let back = bars.element(boundBy: bars.count - 1).buttons["BackButton"]
        if back.exists { back.tap() }
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
        XCTAssertTrue(a.navigationBars["Info"].waitForExistence(timeout: 5), "the board's info, with who's here")
        let doing = a.staticTexts["fixing the empty-cart guard"]
        // (Under the board's SOUL and MEMORY, it can be just below the fold.)
        if !doing.waitForExistence(timeout: 3) { a.swipeUp(velocity: .slow) }
        XCTAssertTrue(doing.waitForExistence(timeout: 5), "what the live session is doing")
        shot("04a-agents-here")
        a.navigationBars["Info"].buttons["Done"].tap()
        XCTAssertTrue(a.navigationBars["Info"].waitForNonExistence(timeout: 5), "the sheet closes")
        sleep(1)
        // Like any messenger: the chat opens at the newest message, not the oldest.
        let newest = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'task-card-' AND label BEGINSWITH 'Ship'")).firstMatch
        // (Settled, not just there: the sheet closing and the chat's refresh can still be moving the list for a moment.)
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND hittable == true"), object: newest)
        XCTAssertEqual(XCTWaiter().wait(for: [settled], timeout: 10), .completed, "opens at the newest message")
        XCTAssertFalse(a.staticTexts["Earlier: checked the retry path, step 0"].isHittable, "not at the top")
        shot("04-board")
        // Who's doing what: the Tasks tab under the title, and back to Chat.
        XCTAssertTrue(a.openBoardTab("tab-tasks"), "the Tasks tab")
        shot("04b-tasks")
        XCTAssertTrue(a.openBoardTab("tab-chat"), "back to Chat")
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
        // (theo as a person, from his phone: an agent's post would go into the thread it answers)
        if let tick = env["AGENT_SOUP_TICK"], let server = env["AGENT_SOUP_SERVER"], let token = env["AGENT_SOUP_OTHER_APP"].flatMap({ $0.isEmpty ? nil : $0 }) ?? env["AGENT_SOUP_OTHER_TOKEN"] {
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
            let jump = a.buttons["new-messages-pill"] // "1 new message ↓" (jxn #1367)
            XCTAssertTrue(jump.waitForExistence(timeout: 5), "scrolled up: the new-messages pill, not a yank")
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
        // The @mention is highlighted, as the server resolved it.
        let mentions = expectation(for: NSPredicate(format: "value CONTAINS %@", "@theo's agent"), evaluatedWith: a.staticTexts[msg])
        wait(for: [mentions], timeout: 5)
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
        // Reply to a specific message: swipe it right (like any messenger) or long-press → Reply; its thread opens over
        // the chat (like iMessage), the box starting with who you're answering; the answer lands in the chat too.
        let parent = a.staticTexts["posted while you read history"]
        if parent.exists && parent.isHittable {
            let from = parent.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
            from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 140, dy: 0)), withVelocity: .fast, thenHoldForDuration: 0)
            XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 3), "swiping a message right opens its thread")
            shot("07b-swiped")
            a.navigationBars["Thread"].buttons.element(boundBy: 0).tap()
            XCTAssertTrue(a.navigationBars["Thread"].waitForNonExistence(timeout: 5), "back in the chat")
            for _ in 0..<4 where !(parent.exists && parent.isHittable) { a.swipeDown(velocity: .slow); sleep(1) }
            XCTAssertTrue(parent.waitForExistence(timeout: 5))
            parent.press(forDuration: 0.8)
            let replyItem = a.buttons["Reply"]
            XCTAssertTrue(replyItem.waitForExistence(timeout: 3), "long-press offers Reply")
            replyItem.tap()
            XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 3), "Reply opens the thread")
            let tbox = field(a, "thread-composer")
            XCTAssertTrue(tbox.waitForExistence(timeout: 3))
            wait(for: [expectation(for: NSPredicate(format: "value BEGINSWITH '@theo'"), evaluatedWith: tbox)], timeout: 3) // the reply names theo (#538)
            shot("07b-replying")
            let answer = "On it \(Int(Date().timeIntervalSince1970) % 100000)"
            tbox.typeText(answer)
            a.buttons["thread-send"].tap()
            XCTAssertTrue(a.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", answer)).firstMatch.waitForExistence(timeout: 3), "the reply shows at once")
            let sent = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: a.staticTexts["Sending…"])
            wait(for: [sent], timeout: 10)
            shot("07c-replied")
            a.navigationBars["Thread"].buttons.element(boundBy: 0).tap()
            XCTAssertTrue(a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'replies-'")).firstMatch.waitForExistence(timeout: 5), "the message shows its reply")
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
        // Pictures and files aren't encrypted yet: the + is dimmed and says why.
        a.buttons["attach"].tap()
        XCTAssertTrue(a.descendants(matching: .any)["attach-unavailable"].waitForExistence(timeout: 5), "+ explains attachments aren't on encrypted boards yet")
        XCTAssertFalse(a.buttons["Photos"].exists, "no picker here")
        shot("15a-encrypted-attach")
        a.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap() // dismiss
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

    /// GETs a JSON path on the local server as the person (to check what really landed).
    func serverJSON(_ path: String) -> [String: Any]? {
        guard let server = env["AGENT_SOUP_SERVER"], let token = env["AGENT_SOUP_TOKEN"] else { return nil }
        var r = URLRequest(url: URL(string: server + path)!)
        r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        var out: [String: Any]?
        let got = expectation(description: "GET \(path)")
        URLSession.shared.dataTask(with: r) { d, _, _ in out = d.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }; got.fulfill() }.resume()
        wait(for: [got], timeout: 10)
        return out
    }

    /// Pictures from the phone (#501): + → Photos, pick one from the library; it waits as a chip in the message box,
    /// goes with a note, shows in the chat at once (a ring while it uploads), then as the server's picture. Tap it:
    /// full screen. (On a board no other test reads, so their "latest line" checks don't change.)
    func testAttachments() throws {
        continueAfterFailure = false
        let a = app(fresh: true)
        a.launch()
        onBoards(a)
        let chat = a.buttons.matching(NSPredicate(format: "identifier == 'chat-Q4 data migration'")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "the board is in Chats")
        chat.tap()
        let composer = a.textFields["composer"].exists ? a.textFields["composer"] : a.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "board opens")
        // A file someone shared: a compact chip; tap opens it in Quick Look.
        let file = a.buttons.matching(NSPredicate(format: "identifier == 'chat-file' AND label CONTAINS 'backfill-report.csv'")).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 5), "a shared file shows as a chip")
        file.tap()
        // Quick Look titles it without the extension.
        XCTAssertTrue(a.descendants(matching: .any).matching(NSPredicate(format: "label == 'backfill-report'")).firstMatch.waitForExistence(timeout: 10), "it opens in Quick Look")
        sleep(2)
        shot("16-quick-look")
        let close = a.buttons.matching(NSPredicate(format: "label IN {'Done', 'Close', 'Dismiss'} OR identifier IN {'Done', 'Close', 'QLOverlayDoneButtonAccessibilityIdentifier'}")).firstMatch
        if close.waitForExistence(timeout: 3) { close.tap() } else { a.swipeDown(velocity: .fast) }
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        // + opens Photos / Files (no camera on the simulator).
        a.buttons["attach"].tap()
        let photos = a.buttons["Photos"]
        XCTAssertTrue(photos.waitForExistence(timeout: 5), "+ offers Photos")
        XCTAssertTrue(a.buttons["Files"].exists, "and Files")
        shot("16a-attach-menu")
        photos.tap()
        // The picker runs in another process: wait for its grid, tap the first photo, then Add.
        XCTAssertTrue(a.scrollViews.images.firstMatch.waitForExistence(timeout: 10), "the photo library opens")
        sleep(1)
        a.coordinate(withNormalizedOffset: CGVector(dx: 0.17, dy: 0.47)).tap()
        sleep(1)
        let add = a.buttons.matching(NSPredicate(format: "label == 'Add' OR identifier == 'Add' OR label == 'Done'")).firstMatch
        if add.waitForExistence(timeout: 3) { add.tap() } else { a.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.08)).tap() }
        let chip = a.descendants(matching: .any)["attachment-chip"]
        XCTAssertTrue(chip.waitForExistence(timeout: 10), "the photo waits as a chip in the message box")
        let caption = "@theo's agent staging after the backfill \(Int(Date().timeIntervalSince1970) % 100000)"
        composer.tap()
        composer.typeText(caption)
        shot("16b-attached")
        a.buttons["send"].tap()
        // At once: the picture (sending) and the note under it.
        XCTAssertTrue(a.staticTexts[caption].waitForExistence(timeout: 3), "the note shows at once")
        XCTAssertFalse(chip.exists, "the message box is empty again")
        let sent = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: a.staticTexts["Sending…"])
        wait(for: [sent], timeout: 20)
        // What landed on the server: a picture entry with the note, its bytes stored as an image.
        guard let boards = serverJSON("/api/me/boards")?["boards"] as? [[String: Any]],
              let board = boards.filter({ $0["title"] as? String == "Q4 data migration" }).max(by: { ($0["last_activity"] as? Double ?? 0) < ($1["last_activity"] as? Double ?? 0) }),
              let id = board["id"] as? String,
              let entries = serverJSON("/api/boards/\(id)/entries?after=0&limit=200")?["entries"] as? [[String: Any]],
              let entry = entries.last(where: { $0["text"] as? String == caption }) else { return XCTFail("the picture reached the server") }
        let media = entry["media"] as? [String: Any]
        XCTAssertTrue((media?["mime"] as? String ?? "").hasPrefix("image/"), "stored as a picture, not a download")
        XCTAssertLessThanOrEqual(media?["size"] as? Int ?? .max, 1_500_000, "within the server's limit")
        let name = entry["artifact_name"] as? String ?? ""
        // In the chat: the server's picture (by its stored name), shown.
        let image = a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'chat-image' AND label == %@", name)).firstMatch
        XCTAssertTrue(image.waitForExistence(timeout: 5), "the picture is in the chat")
        let shown = expectation(for: NSPredicate(format: "value == 'shown'"), evaluatedWith: image)
        wait(for: [shown], timeout: 10)
        XCTAssertTrue(image.isHittable, "on screen, above the message box")
        let mention = expectation(for: NSPredicate(format: "value CONTAINS %@", "@theo's agent"), evaluatedWith: a.staticTexts[caption])
        wait(for: [mention], timeout: 5) // the note's @mention is highlighted
        shot("16c-attachment-sent")
        // Tap: full screen, with Share; ✕ closes.
        image.tap()
        XCTAssertTrue(a.descendants(matching: .any)["image-viewer"].waitForExistence(timeout: 5), "tap opens it full screen")
        XCTAssertTrue(a.buttons["Share"].waitForExistence(timeout: 5), "it can be shared")
        shot("16d-full-screen")
        a.buttons["Close"].tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "back in the chat")
        XCTAssertTrue(image.waitForExistence(timeout: 5), "the picture is still there")
        // Keyboard down (drag the chat into it, like a person would), for a clean look at the chat.
        image.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1, thenDragTo: a.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.97)), withVelocity: .slow, thenHoldForDuration: 0.1)
        sleep(1)
        shot("16e-attachments") // the chat, keyboard down: the file someone shared, your picture and its note
    }

    /// The chat's second layer (#508/#538), on the Q4 board: a reply starts with the @mention, "1 reply" opens the
    /// thread, 👍 from the long-press row shows as a chip, "Seen by" under your latest, unsending shows "Unsent",
    /// "On it" on a question for you, older messages load at the top, and the title opens the board's info (search).
    func testThreadsReactionsAndInfo() throws {
        continueAfterFailure = false
        let a = app(fresh: true)
        a.launch()
        onBoards(a)
        let chat = a.buttons.matching(NSPredicate(format: "identifier == 'chat-Q4 data migration'")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10), "the board is in Chats")
        chat.tap()
        let composer = a.textFields["composer"].exists ? a.textFields["composer"] : a.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "board opens")
        let n = Int(Date().timeIntervalSince1970) % 100000
        func sent() { wait(for: [expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: a.staticTexts["Sending…"])], timeout: 10) }

        // Reply: long-press theo's agent's message → Reply; its thread opens over the chat, the box starting
        // with "@theo's agent " (#538).
        let theirs = a.staticTexts["Backfill finished on staging: 4.2M rows, 0 errors. Ready for prod tonight."]
        XCTAssertTrue(theirs.waitForExistence(timeout: 5))
        theirs.press(forDuration: 0.8)
        XCTAssertTrue(a.buttons["Reply"].waitForExistence(timeout: 3), "long-press offers Reply")
        shot("20a-long-press")
        a.buttons["Reply"].tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 5), "Reply opens the thread")
        let tbox = field(a, "thread-composer")
        XCTAssertTrue(tbox.waitForExistence(timeout: 5))
        wait(for: [expectation(for: NSPredicate(format: "value BEGINSWITH %@", "@theo's agent "), evaluatedWith: tbox)], timeout: 3)
        shot("20b-reply-prefilled")
        let answer = "after the freeze \(n)"
        tbox.typeText(answer)
        a.buttons["thread-send"].tap()
        let inThread = a.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", answer)).firstMatch
        XCTAssertTrue(inThread.waitForExistence(timeout: 5), "the answer shows in the thread at once")
        sent()
        XCTAssertTrue(a.descendants(matching: .any)["thread-count"].waitForExistence(timeout: 5), "under a replies divider")
        sleep(1)
        shot("21-thread")
        a.navigationBars["Thread"].buttons.element(boundBy: 0).tap()

        // Back in the chat: the answer is in the chat too, at the bottom under its quote bar (jxn #1040); the message
        // it answers says "1 reply".
        XCTAssertTrue(a.navigationBars["Thread"].waitForNonExistence(timeout: 5), "back")
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        let replies = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'replies-'")).firstMatch
        XCTAssertTrue(replies.waitForExistence(timeout: 5), "the parent shows its replies")
        XCTAssertTrue(a.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '@' AND label ENDSWITH %@", answer)).firstMatch.waitForExistence(timeout: 5), "the answer is in the chat")
        XCTAssertTrue(a.buttons.matching(NSPredicate(format: "identifier == 'reply-quote' AND label CONTAINS 'Backfill finished'")).firstMatch.exists, "under a bar quoting what it answers")
        shot("21a-replies-chip")
        for _ in 0..<4 where !replies.isHittable { a.swipeDown(velocity: .slow); sleep(1) }
        replies.tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 5), "the thread opens again")
        XCTAssertTrue(inThread.waitForExistence(timeout: 5), "with the answer in it")
        a.navigationBars["Thread"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForNonExistence(timeout: 5), "closed")

        // Every thread here (the top bar's Threads, like Lark): theo answers in the thread while you look, and its
        // row gets a dot; open it (pushed), back to the list (the dot's gone), back to the chat.
        let rootSeq = replies.identifier.replacingOccurrences(of: "replies-", with: "")
        a.openThreadsList()
        XCTAssertTrue(a.navigationBars["Threads"].waitForExistence(timeout: 5), "the threads list")
        let threadRow = a.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@", "thread-row-\(rootSeq)")).firstMatch
        XCTAssertTrue(threadRow.waitForExistence(timeout: 5), "this thread is listed")
        XCTAssertNotEqual(threadRow.value as? String, "new replies", "seen: no dot")
        guard let boards = serverJSON("/api/me/boards")?["boards"] as? [[String: Any]],
              let q4 = boards.filter({ $0["title"] as? String == "Q4 data migration" }).max(by: { ($0["last_activity"] as? Double ?? 0) < ($1["last_activity"] as? Double ?? 0) }),
              let q4id = q4["id"] as? String, let server = env["AGENT_SOUP_SERVER"], let theo = env["AGENT_SOUP_OTHER_APP"], !theo.isEmpty else { return XCTFail("seed") }
        var post = URLRequest(url: URL(string: "\(server)/api/boards/\(q4id)/entries")!)
        post.httpMethod = "POST"
        post.setValue("Bearer \(theo)", forHTTPHeaderField: "authorization")
        post.setValue("application/json", forHTTPHeaderField: "content-type")
        post.httpBody = try JSONSerialization.data(withJSONObject: ["type": "note", "text": "theo, in the thread \(n)", "reply_to": Int(rootSeq) ?? 0])
        let posted = expectation(description: "theo answers")
        URLSession.shared.dataTask(with: post) { _, _, _ in posted.fulfill() }.resume()
        wait(for: [posted], timeout: 10)
        wait(for: [expectation(for: NSPredicate(format: "value == 'new replies'"), evaluatedWith: threadRow)], timeout: 8) // live, with a dot
        shot("21b-threads-unread")
        threadRow.tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 5), "the thread, pushed")
        XCTAssertTrue(a.staticTexts["theo, in the thread \(n)"].waitForExistence(timeout: 5), "with theo's answer")
        a.navigationBars["Thread"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(a.navigationBars["Threads"].waitForExistence(timeout: 5), "back to the list")
        wait(for: [expectation(for: NSPredicate(format: "value != 'new replies'"), evaluatedWith: threadRow)], timeout: 5) // read now
        shot("21c-threads-read")
        a.navigationBars["Threads"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "back to the chat")

        // React: long-press → 👍 in the quick row; a chip shows under the message, yours. (Scroll it into view first:
        // after the other tests the chat has more under it, like testAttachments' picture.)
        XCTAssertTrue(theirs.waitForExistence(timeout: 5))
        let screen = a.windows.firstMatch.frame
        func onScreen(_ e: XCUIElement) -> Bool { e.exists && e.frame.minY > screen.minY + 140 && e.frame.maxY < screen.maxY - 140 }
        /// Scrolls the chat until it's well on screen: down to reveal what's above, up for what's below.
        func bringIntoView(_ e: XCUIElement) {
            for _ in 0..<8 where !onScreen(e) {
                if e.exists && e.frame.maxY >= screen.maxY - 140 { a.swipeUp(velocity: .slow) } else { a.swipeDown(velocity: .slow) }
                sleep(1)
            }
        }
        bringIntoView(theirs)
        theirs.press(forDuration: 0.8)
        let thumbs = a.buttons["👍"].firstMatch
        XCTAssertTrue(thumbs.waitForExistence(timeout: 3), "the quick reactions")
        thumbs.tap()
        let chip = a.buttons["reaction-👍"]
        XCTAssertTrue(chip.waitForExistence(timeout: 5), "👍 shows as a chip")
        wait(for: [expectation(for: NSPredicate(format: "value == 'yours'"), evaluatedWith: chip)], timeout: 5)
        wait(for: [expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: chip)], timeout: 5) // the menu has gone
        sleep(1)
        shot("22-reaction")
        // Long-press the chip: who reacted.
        chip.press(forDuration: 0.8)
        XCTAssertTrue(a.descendants(matching: .any).matching(NSPredicate(format: "label == 'You'")).firstMatch.waitForExistence(timeout: 3), "who reacted")
        shot("22a-who-reacted")
        a.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap() // close it
        // Any other emoji: long-press → More reactions → the picker.
        theirs.press(forDuration: 0.8)
        XCTAssertTrue(a.buttons["More reactions"].waitForExistence(timeout: 3))
        a.buttons["More reactions"].tap()
        let rocket = a.buttons["emoji-🚀"]
        XCTAssertTrue(rocket.waitForExistence(timeout: 3), "the emoji picker")
        shot("22b-emoji-picker")
        rocket.tap()
        XCTAssertTrue(a.buttons["reaction-🚀"].waitForExistence(timeout: 5), "🚀 shows as a chip too")

        // Your latest message says who's seen it.
        if a.buttons["Jump to latest"].exists { a.buttons["Jump to latest"].tap(); sleep(1) }
        XCTAssertTrue(a.descendants(matching: .any)["seen-by"].waitForExistence(timeout: 5), "Seen by / Delivered under your latest")
        // Tap it: who's seen it, as a list ("Seen by 1 of 3": people, then agents, each Seen or Not yet) (#692).
        let seenLine = a.descendants(matching: .any)["seen-by"].firstMatch
        if !seenLine.isHittable { a.swipeUp(); sleep(1) }
        seenLine.tap()
        let seenTitle = a.navigationBars.matching(NSPredicate(format: "identifier BEGINSWITH 'Seen by'")).firstMatch
        XCTAssertTrue(seenTitle.waitForExistence(timeout: 5), "who's seen it")
        XCTAssertTrue(a.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'reader-'")).firstMatch.exists, "each reader")
        sleep(1)
        shot("22c-seen-by-list")
        a.swipeDown(velocity: .fast)
        XCTAssertTrue(seenTitle.waitForNonExistence(timeout: 5))

        // Unsend: long-press your message → Unsend → confirm; it reads "Unsent".
        let oops = "wrong chat, sorry \(n)"
        composer.tap()
        composer.typeText(oops)
        a.buttons["send"].tap()
        sent()
        let mineMsg = a.staticTexts[oops]
        XCTAssertTrue(mineMsg.waitForExistence(timeout: 5))
        shot("23a-seen-by")
        mineMsg.press(forDuration: 0.8)
        XCTAssertTrue(a.buttons["Unsend"].waitForExistence(timeout: 3), "yours can be unsent")
        a.buttons["Unsend"].tap()
        let confirm = a.buttons["Unsend"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 3), "asks first")
        confirm.tap()
        XCTAssertTrue(a.descendants(matching: .any)["unsent"].waitForExistence(timeout: 5), "it reads Unsent")
        shot("23-unsent")

        // "On it": theo's agent asked maya a question; one tap says she's handling it.
        let onIt = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'on-it-'")).firstMatch
        if onIt.waitForExistence(timeout: 3) {
            if a.keyboards.count > 0 { a.swipeDown(velocity: .slow); sleep(1) } // keyboard down
            // That swipe also scrolls the chat up, and the lazy list drops the question below the fold: bringIntoView
            // reads a missing element as "above" and would scroll the wrong way, so back to the latest first (the
            // question is a few messages up from there).
            let latest = a.buttons["Jump to latest"]
            if !onIt.exists && latest.exists { latest.tap(); sleep(1) }
            XCTAssertTrue(onIt.waitForExistence(timeout: 5), "On it, near the latest")
            bringIntoView(onIt)
            onIt.tap()
            XCTAssertTrue(a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'handling' AND label CONTAINS 'on it'")).firstMatch.waitForExistence(timeout: 5), "who's on it")
            shot("24-on-it")
        }

        // Older messages: scroll up past what's loaded and the earlier ones come in above.
        let oldest = a.staticTexts["Migration log: batch 1"]
        for _ in 0..<16 where !oldest.exists { a.swipeDown(velocity: .fast); usleep(400_000) }
        XCTAssertTrue(oldest.waitForExistence(timeout: 5), "the start of the chat loaded")
        shot("25-earlier")

        // The title: the board's info (open questions, agents, members, files) and search.
        a.buttons["presence"].tap()
        XCTAssertTrue(a.navigationBars["Info"].waitForExistence(timeout: 5), "the board's info opens")
        XCTAssertTrue(a.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Open questions'")).firstMatch.waitForExistence(timeout: 5), "what's open")
        sleep(1)
        shot("26-info")
        let membersHeader = a.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Members'")).firstMatch
        for _ in 0..<4 where !membersHeader.exists { a.swipeUp(); sleep(1) }
        XCTAssertTrue(membersHeader.exists, "its members")
        shot("26b-info-members")
        let search = a.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 3))
        search.tap()
        search.typeText("backfill")
        let hit = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'search-hit-'")).firstMatch
        XCTAssertTrue(hit.waitForExistence(timeout: 8), "search finds it")
        shot("27-search")
        hit.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5), "back in the chat, at the hit")
        sleep(2)
        shot("28-jumped")
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
        XCTAssertTrue(a.openBoardTab("tab-tasks"), "the Tasks tab")
        let task = any["task-row-Write the incident note"].firstMatch
        XCTAssertTrue(task.waitForExistence(timeout: 5), "the task is in the list")
        task.tap()
        // Who's on it shows in the task; an available task also offers Claim.
        XCTAssertTrue(any["task-owner"].firstMatch.waitForExistence(timeout: 5), "the task says who's on it")
        XCTAssertTrue(a.buttons["task-claim"].exists, "the available task can be claimed")
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
        XCTAssertTrue(a.boardTab("tab-tasks").waitForExistence(timeout: 8), "back to the list")
        XCTAssertTrue(a.boardTab("tab-tasks").isSelected, "on the Tasks tab")
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: any["task-row-\(newTitle)"].firstMatch)
        wait(for: [gone], timeout: 8)

        // 3. Files: a doc, read; an older version from the picker.
        XCTAssertTrue(a.openBoardTab("tab-files"), "the Files tab")
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
        XCTAssertTrue(a.openBoardTab("tab-chat"), "back to Chat")

        // 4. The board's info (the title): members, invite, files, rename / archive.
        let presence = a.buttons["presence"]
        XCTAssertTrue(presence.waitForExistence(timeout: 5))
        presence.tap()
        XCTAssertTrue(a.navigationBars["Info"].waitForExistence(timeout: 5))
        XCTAssertTrue(any["board-info-title"].firstMatch.waitForExistence(timeout: 5))
        // Who can read this board (E2E Phase 0, vedu #5452): the badge says which kind it is; one tap explains it.
        let privacy = a.buttons["privacy-badge"]
        XCTAssertTrue(privacy.waitForExistence(timeout: 5), "the board says who can read it")
        XCTAssertTrue(privacy.label.contains("Readable by Atteo's servers") || privacy.label.contains("End-to-end encrypted"), "…which kind it is (\(privacy.label))")
        privacy.tap()
        XCTAssertTrue(any["privacy-explainer"].firstMatch.waitForExistence(timeout: 5), "one tap explains it")
        shot("p08a-privacy")
        privacy.tap()
        for _ in 0..<4 where !a.buttons["invite-link"].exists { a.swipeUp(); sleep(1) }
        if a.buttons["invite-link"].exists {
            a.buttons["invite-link"].tap()
            XCTAssertTrue(a.buttons["Copy link"].waitForExistence(timeout: 5), "an invite link")
        }
        for _ in 0..<4 where !a.staticTexts["theo"].exists { a.swipeUp(); sleep(1) }
        XCTAssertTrue(a.staticTexts["theo"].waitForExistence(timeout: 5), "members")
        shot("p08-board-info")
        a.navigationBars["Info"].buttons["Done"].tap()
        XCTAssertTrue(a.navigationBars["Info"].waitForNonExistence(timeout: 5))
        sleep(1)
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
        let dm = expectation(for: NSPredicate(format: "label BEGINSWITH[c] 'jules'"), evaluatedWith: a.buttons["presence"])
        wait(for: [dm], timeout: 10)
        shot("p11-dm")
        a.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chat-' AND identifier CONTAINS[c] 'jules'")).firstMatch.waitForExistence(timeout: 5), "the DM is under DMs")

        // 6. Archive a board from its info (it closes and leaves the list), which makes room on the Free plan for…
        a.buttons["tab-boards"].tap()
        let q4 = a.buttons["chat-Q4 data migration"].firstMatch
        XCTAssertTrue(q4.waitForExistence(timeout: 5))
        q4.tap()
        XCTAssertTrue(a.buttons["presence"].waitForExistence(timeout: 5))
        a.buttons["presence"].tap()
        XCTAssertTrue(a.navigationBars["Info"].waitForExistence(timeout: 5))
        let archive = a.buttons["board-archive"]
        for _ in 0..<8 where !archive.exists || !archive.isHittable { a.swipeUp(); sleep(1) }
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

    /// POSTs a message to a board as theo, from his phone (a person: it stays where it's posted).
    func postAsTheo(board: String, _ body: [String: Any]) throws {
        guard let server = env["AGENT_SOUP_SERVER"], let theo = env["AGENT_SOUP_OTHER_APP"], !theo.isEmpty else { throw XCTSkip("needs theo's phone token") }
        var r = URLRequest(url: URL(string: "\(server)/api/boards/\(board)/entries")!)
        r.httpMethod = "POST"
        r.setValue("Bearer \(theo)", forHTTPHeaderField: "authorization")
        r.setValue("application/json", forHTTPHeaderField: "content-type")
        r.httpBody = try JSONSerialization.data(withJSONObject: body)
        let done = expectation(description: "posted")
        URLSession.shared.dataTask(with: r) { _, _, _ in done.fulfill() }.resume()
        wait(for: [done], timeout: 10)
    }

    /// Mentions in blue boxes (#538 b): theo's "@maya" (you: solid) and "@theo's agent" (others: soft). Paste (#538 c):
    /// a picture and words on the clipboard; long-press the message box → Paste: the picture waits as an attachment
    /// and the words go in the box.
    func testPasteAndMentions() throws {
        continueAfterFailure = false
        guard let boards = serverJSON("/api/me/boards")?["boards"] as? [[String: Any]],
              let b1 = boards.filter({ $0["title"] as? String == "Checkout bug" }).max(by: { ($0["last_activity"] as? Double ?? 0) < ($1["last_activity"] as? Double ?? 0) }),
              let id = b1["id"] as? String else { return XCTFail("seed") }
        let n = Int(Date().timeIntervalSince1970) % 100000
        try postAsTheo(board: id, ["type": "note", "text": "Heads-up @agents and @humans: @maya can you check the rollout plan? @theo's agent has the numbers \(n)"])
        let a = app(fresh: true)
        a.launch()
        onBoards(a)
        let chat = a.buttons["chat-Checkout bug"].firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10))
        chat.tap()
        let composer = a.textFields["composer"].exists ? a.textFields["composer"] : a.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "board opens")
        let theirs = a.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", "has the numbers \(n)")).firstMatch
        XCTAssertTrue(theirs.waitForExistence(timeout: 20), "theo's message") // a fresh launch loads the whole chat first
        wait(for: [expectation(for: NSPredicate(format: "value CONTAINS '@maya' AND value CONTAINS %@", "@theo's agent"), evaluatedWith: theirs)], timeout: 5) // both boxed
        sleep(1)
        shot("30-mention-boxes")

        // Profiles (#538 f): theo's picture opens his card; his agent's @mention opens it on his agent, and
        // "Ask theo's agent" starts a message to it here.
        let avatar = a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'avatar-theo'")).element(boundBy: max(0, a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'avatar-theo'")).count - 1))
        XCTAssertTrue(avatar.waitForExistence(timeout: 5), "theo's picture")
        avatar.tap()
        XCTAssertTrue(a.staticTexts["@theo"].waitForExistence(timeout: 5), "theo's card")
        sleep(1)
        shot("30a-profile")
        a.swipeDown(velocity: .fast)
        XCTAssertTrue(a.staticTexts["@theo"].waitForNonExistence(timeout: 5))
        let link = a.links.matching(NSPredicate(format: "label CONTAINS %@", "theo's agent")).allElementsBoundByIndex.last
        XCTAssertNotNil(link, "the @mention is a link")
        link?.tap()
        let ask = a.buttons["profile-ask-agent"]
        XCTAssertTrue(ask.waitForExistence(timeout: 8), "his agent's card")
        sleep(1)
        shot("30b-profile-agent")
        ask.tap()
        wait(for: [expectation(for: NSPredicate(format: "value BEGINSWITH %@", "@theo's agent"), evaluatedWith: composer)], timeout: 5)
        composer.typeText("hello")
        // As you type, a mention sits in its blue box already (#824).
        let typed = a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'composer-mention' AND label CONTAINS %@", "theo's agent")).firstMatch
        XCTAssertTrue(typed.waitForExistence(timeout: 5), "the typed @mention is boxed")
        shot("30c-composer-mention")
        for _ in 0..<12 { composer.typeText(XCUIKeyboardKey.delete.rawValue) } // leave the box empty for the paste
        let cleared = composer.value as? String ?? ""
        if !cleared.isEmpty { composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: cleared.count + 2)) }

        // "@agents" and "@humans" (#828): who they reach, as lists.
        let agentsLink = a.links.matching(NSPredicate(format: "label CONTAINS '@agents'")).allElementsBoundByIndex.last
        XCTAssertNotNil(agentsLink, "@agents is a link")
        agentsLink?.tap()
        XCTAssertTrue(a.navigationBars["Agents on this board"].waitForExistence(timeout: 5), "the board's agents")
        // (grouped: working now / idle; which, depends on how long ago the seeded sessions last checked in)
        XCTAssertTrue(a.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Working now' OR label BEGINSWITH 'Idle'")).firstMatch.waitForExistence(timeout: 5), "grouped by what they're doing")
        sleep(1)
        shot("30d-agents-here")
        a.swipeDown(velocity: .fast)
        XCTAssertTrue(a.navigationBars["Agents on this board"].waitForNonExistence(timeout: 5))
        let humansLink = a.links.matching(NSPredicate(format: "label CONTAINS '@humans'")).allElementsBoundByIndex.last
        humansLink?.tap()
        XCTAssertTrue(a.navigationBars["People on this board"].waitForExistence(timeout: 5), "the board's people")
        XCTAssertTrue(a.descendants(matching: .any)["group-person-theo"].waitForExistence(timeout: 5), "theo is here")
        sleep(1)
        shot("30e-people-here")
        a.swipeDown(velocity: .fast)
        XCTAssertTrue(a.navigationBars["People on this board"].waitForNonExistence(timeout: 5))

        // A picture and words on the clipboard; Paste from the message box's menu.
        let size = CGSize(width: 160, height: 100)
        let png = UIGraphicsImageRenderer(size: size).image { c in
            UIColor(red: 0.85, green: 0.47, blue: 0.34, alpha: 1).setFill(); c.fill(CGRect(origin: .zero, size: size))
        }.pngData()!
        UIPasteboard.general.items = [[UTType.png.identifier: png, UTType.utf8PlainText.identifier: "pasted words \(n)"]]
        composer.tap()
        sleep(1)
        composer.press(forDuration: 1.0)
        let paste = a.descendants(matching: .any).matching(NSPredicate(format: "label == 'Paste' AND (elementType == %d OR elementType == %d)",
                                                                        XCUIElement.ElementType.menuItem.rawValue, XCUIElement.ElementType.button.rawValue)).firstMatch
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "Paste is offered with a picture on the clipboard")
        paste.tap()
        XCTAssertTrue(a.descendants(matching: .any)["attachment-chip"].waitForExistence(timeout: 10), "the picture waits as an attachment")
        wait(for: [expectation(for: NSPredicate(format: "value CONTAINS %@", "pasted words \(n)"), evaluatedWith: composer)], timeout: 5) // and the words
        shot("31-pasted")
        a.buttons["send"].tap()
        wait(for: [expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: a.staticTexts["Sending…"])], timeout: 20)
        XCTAssertTrue(a.staticTexts["pasted words \(n)"].waitForExistence(timeout: 5), "sent with the picture")
        shot("32-pasted-sent")

        // A long message (#765): paste 60 lines; the box grows to about six lines, then scrolls inside itself, and
        // typing at the end still lands (the caret stays in view, send stays in reach).
        let long = (1...60).map { "line \($0) of a long note" }.joined(separator: "\n")
        UIPasteboard.general.string = long
        composer.tap()
        sleep(1)
        composer.press(forDuration: 1.0)
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "Paste")
        paste.tap()
        wait(for: [expectation(for: NSPredicate(format: "value CONTAINS 'line 60 of a long note'"), evaluatedWith: composer)], timeout: 5)
        composer.typeText(" and the end \(n)")
        wait(for: [expectation(for: NSPredicate(format: "value ENDSWITH %@", "and the end \(n)"), evaluatedWith: composer)], timeout: 5) // typing at the end works
        let screen = a.windows.firstMatch.frame
        XCTAssertLessThanOrEqual(composer.frame.height, screen.height * 0.32, "the box stops growing (about 6 lines)")
        XCTAssertTrue(a.buttons["send"].isHittable, "send stays in reach")
        shot("32a-long-message")
    }

    /// Search (#538 d): from Chats, the server's search across your boards finds an old message the phone hasn't
    /// loaded; tapping it opens that chat at the message (loading older ones). An encrypted board's Info search
    /// says it only covers what's on the phone.
    func testSearch() throws {
        continueAfterFailure = false
        let a = app(fresh: true)
        a.launch()
        onBoards(a)
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 10))
        let field = a.searchFields.firstMatch
        if !field.exists { a.swipeDown() }
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("batch 7")
        let hit = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'search-hit-' AND label CONTAINS 'batch 7'")).firstMatch
        XCTAssertTrue(hit.waitForExistence(timeout: 10), "the whole board's messages are searched")
        shot("33-search-chats")
        hit.tap()
        let old = a.staticTexts["Migration log: batch 7"]
        XCTAssertTrue(old.waitForExistence(timeout: 15), "the chat opens at the old message")
        wait(for: [expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: old)], timeout: 8)
        sleep(1)
        shot("34-search-jumped")
        // An encrypted board: the server can't read it, so its search covers what's on this phone, and says so.
        a.terminate()
        a.launch()
        onBoards(a)
        let enc = a.buttons.matching(NSPredicate(format: "identifier == 'chat-Secret plans'")).firstMatch
        XCTAssertTrue(enc.waitForExistence(timeout: 10), "the encrypted board")
        do {
            enc.tap()
            XCTAssertTrue(a.buttons["presence"].waitForExistence(timeout: 10))
            a.buttons["presence"].tap()
            XCTAssertTrue(a.navigationBars["Info"].waitForExistence(timeout: 5))
            let s = a.searchFields.firstMatch
            s.tap()
            s.typeText("zzqx")
            let empty = a.descendants(matching: .any)["search-empty"]
            XCTAssertTrue(empty.waitForExistence(timeout: 5))
            XCTAssertTrue(empty.label.contains("encrypted"), "says only what's on the phone is searched")
            shot("35-search-encrypted")
        }
    }

    /// A change card (#538 e): "Shipped to production (v42)" as a card (title, version chip, 3 commits · 3 files with
    /// +/−, commits, files with bars), never the raw text; the diff opens behind "Show diff".
    func testShippedChangeCard() throws {
        continueAfterFailure = false
        let a = app(fresh: true)
        a.launch()
        onBoards(a)
        let chat = a.buttons["chat-Checkout bug"].firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10))
        chat.tap()
        XCTAssertTrue(a.buttons["presence"].waitForExistence(timeout: 10))
        let card = a.descendants(matching: .any)["change-card"].firstMatch
        sleep(2) // a fresh launch: let the chat settle at its newest before scrolling back
        for _ in 0..<16 where !(card.exists && card.isHittable) { a.swipeDown(); usleep(500_000) }
        XCTAssertTrue(card.waitForExistence(timeout: 10), "the change shows as a card")
        XCTAssertTrue(a.staticTexts["Shipped to production"].exists, "its title")
        XCTAssertTrue(a.staticTexts["v42"].exists, "the version chip")
        XCTAssertTrue(a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'change-stats' AND label CONTAINS '3 commits'")).firstMatch.exists, "commits · files")
        XCTAssertFalse(a.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Shipped to production (v42)'")).firstMatch.exists, "not the raw text")
        sleep(1)
        shot("36-change-card")
        let toggle = a.buttons["change-diff-toggle"].firstMatch
        XCTAssertTrue(toggle.exists)
        toggle.tap()
        XCTAssertTrue(a.descendants(matching: .any)["change-diff"].firstMatch.waitForExistence(timeout: 8), "the diff opens")
        XCTAssertTrue(a.staticTexts.matching(NSPredicate(format: "label BEGINSWITH '@@'")).firstMatch.waitForExistence(timeout: 5), "with its hunks")
        sleep(1)
        shot("37-change-diff")
    }

    /// A long message typed in (#833): past the box's full height it scrolls inside itself, what you type stays in
    /// view at the end, and you can scroll up and edit the middle.
    func testLongMessageTyping() throws {
        continueAfterFailure = false
        let a = app(fresh: true)
        a.launch()
        onBoards(a)
        let chat = a.buttons["chat-Checkout bug"].firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10))
        chat.tap()
        let composer = a.textFields["composer"].exists ? a.textFields["composer"] : a.textViews["composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        // Reading history, then tapping into the box (#842): the chat goes to the latest and stays there.
        a.swipeDown(velocity: .fast); a.swipeDown(velocity: .fast)
        XCTAssertTrue(a.buttons["Jump to latest"].waitForExistence(timeout: 5), "scrolled up")
        composer.tap()
        XCTAssertTrue(a.buttons["Jump to latest"].waitForNonExistence(timeout: 5), "focusing the box goes to the latest")
        shot("37b-focus-latest")
        let paragraph = "sign in screen on the app opens a new page and it doesn't look all that great. if possible please rewire it to be a more native experience that looks like ours, ideally in the app. "
        for i in 1...4 { composer.typeText("\(i). " + paragraph) }
        let tail = "and this is the end"
        composer.typeText(tail)
        wait(for: [expectation(for: NSPredicate(format: "value ENDSWITH %@", tail), evaluatedWith: composer)], timeout: 5)
        let screen = a.windows.firstMatch.frame
        XCTAssertLessThanOrEqual(composer.frame.height, screen.height * 0.32, "it stops growing")
        XCTAssertTrue(a.buttons["send"].isHittable, "send stays in reach")
        XCTAssertFalse(a.buttons["Jump to latest"].exists, "still at the latest as the box grew")
        sleep(1)
        shot("38-long-typed") // the end of what you typed is in view, the caret after it
        // Scroll up inside the box and edit the middle.
        let box = composer.frame
        a.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: box.midX, dy: box.minY + 20))
            .press(forDuration: 0.05, thenDragTo: a.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: box.midX, dy: box.maxY - 6)))
        sleep(1)
        a.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: box.minX + 40, dy: box.minY + 24)).tap()
        composer.typeText("EDITED ")
        let value = composer.value as? String ?? ""
        XCTAssertTrue(value.contains("EDITED "), "typing in the middle works")
        XCTAssertTrue(value.hasSuffix(tail), "in the middle, not at the end")
        shot("39-long-edited")
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
