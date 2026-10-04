// QA for Settings → Display → Replies (vedu #2360): "Only in threads" keeps replies out of the chat (the message they
// answer says "N replies", which opens the thread), "In the chat" is today's chat with every reply in it. The choice
// stays on the phone even against a server that doesn't keep it yet, and is sent to your account when it does.

import XCTest

final class ThreadsCollapseUITests: AtteoUITestCase {
    private var n: Int { Int(Date().timeIntervalSince1970) % 100000 }
    private func seq(_ r: [String: Any]) -> Int { (r["entry"] as? [String: Any])?["seq"] as? Int ?? 0 }

    /// theo writes a message and answers it; maya's chat as each setting shows it.
    private func seedThread(_ board: String) -> (parent: Int, parentText: String, reply: Int, replyText: String) {
        let n = n
        let parentText = "Fold me \(n): which region first?", replyText = "us-east first, folded \(n)"
        let parent = seq(call("POST", "/api/boards/\(board)/entries", json: ["type": "note", "text": parentText], token: otherApp))
        let reply = seq(call("POST", "/api/boards/\(board)/entries", json: ["type": "note", "text": replyText, "reply_to": parent], token: otherApp))
        return (parent, parentText, reply, replyText)
    }

    private func text(_ a: XCUIApplication, _ s: String) -> XCUIElement {
        a.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", s)).firstMatch
    }

    /// Only in threads: the message is in the chat with "1 reply", the reply isn't; "1 reply" opens the thread with it.
    /// A search hit on the reply opens its thread too. In the chat (the default): the reply is in the chat.
    func testOnlyInThreadsKeepsRepliesOutOfTheChat() throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let t = seedThread(b1)
        XCTAssertGreaterThan(t.reply, 0)

        var a = app(extra: ["AGENT_SOUP_DISPLAY": "m,comfortable,system,auto,eve,thread"])
        a.launch()
        openChat(a, "Checkout bug")
        XCTAssertTrue(text(a, t.parentText).waitForExistence(timeout: 10), "the message it answers is in the chat")
        let count = a.buttons["replies-\(t.parent)"]
        XCTAssertTrue(count.waitForExistence(timeout: 5), "with its reply count")
        XCTAssertFalse(text(a, t.replyText).exists, "the reply stays in its thread")
        shot("threads-collapse-01-chat")

        count.tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 5), "the count opens the thread")
        XCTAssertTrue(text(a, t.replyText).waitForExistence(timeout: 5), "the reply is in its thread")
        shot("threads-collapse-02-thread")
        a.buttons["thread-close"].tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForNonExistence(timeout: 5))
        XCTAssertFalse(text(a, t.replyText).exists, "closed: still not in the chat")

        // A reply arriving live bumps the count instead of landing in the chat.
        let live = "live answer \(n)"
        XCTAssertGreaterThan(seq(call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": live, "reply_to": t.parent], token: otherApp)), 0)
        XCTAssertTrue(eventually(count, "label CONTAINS '2 replies'", timeout: 15), "the count goes up (\(count.label))")
        XCTAssertFalse(text(a, live).exists, "the live reply isn't in the chat")
        a.terminate()

        // In the chat: the reply is in the chat, under its quote bar.
        a = app(extra: ["AGENT_SOUP_DISPLAY": "m,comfortable,system,auto,eve,chat"])
        a.launch()
        openChat(a, "Checkout bug")
        XCTAssertTrue(text(a, live).waitForExistence(timeout: 10), "in the chat, replies are in it")
        XCTAssertTrue(text(a, t.replyText).exists)
        shot("threads-collapse-03-inline")
    }

    /// The setting in Settings → Display: picked, it applies to the chat and survives a relaunch (kept on the phone
    /// even if the server doesn't keep it yet); the other display settings still save. Ends back at In the chat.
    func testRepliesSettingPersists() throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let t = seedThread(b1)
        var a = app()
        a.launch()
        openSettings(a)
        pick(a, "display-replies", "Only in threads")
        pick(a, "display-density", "Compact") // saved alongside, whether or not the server keeps replies yet
        shot("threads-collapse-04-settings")
        XCTAssertTrue(serverHas("density", "compact"), "the other settings still reach your account")
        if let th = serverDisplay()["replies"] { XCTAssertEqual(th, "thread", "a server that keeps it has it") }
        a.buttons["Done"].tap()
        openChat(a, "Checkout bug")
        XCTAssertTrue(text(a, t.parentText).waitForExistence(timeout: 10))
        XCTAssertFalse(text(a, t.replyText).exists, "the reply stays in its thread")
        a.terminate()

        // Relaunch: still Only in threads.
        a = app()
        a.launch()
        openSettings(a)
        XCTAssertTrue(control(a, "display-replies").buttons["Only in threads"].isSelected, "kept after a relaunch")
        // Back to how it was.
        pick(a, "display-replies", "In the chat")
        pick(a, "display-density", "Comfortable")
        XCTAssertTrue(serverHas("density", "comfortable"))
        a.buttons["Done"].tap()
        openChat(a, "Checkout bug")
        XCTAssertTrue(text(a, t.replyText).waitForExistence(timeout: 10), "In the chat: the reply is back in the chat")
    }

    // MARK: - Settings helpers (as DisplaySettingsUITests)

    private func openSettings(_ a: XCUIApplication) {
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15), "Chats")
        a.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(a.navigationBars["Settings"].waitForExistence(timeout: 5), "Settings opens")
    }

    /// A Display control, scrolled into view in small steps: down the list until it's there, back up if it went past
    /// (under the title bar), so a smaller phone doesn't overshoot it.
    private func control(_ a: XCUIApplication, _ id: String) -> XCUIElement {
        let c = a.segmentedControls[id]
        var tries = 0
        while !(c.exists && c.isHittable) && tries < 16 {
            if c.waitForExistence(timeout: tries == 0 ? 2 : 0.5), c.isHittable { break }
            let past = c.exists && c.frame.midY < a.frame.height * 0.3
            let from = a.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: past ? 0.35 : 0.7))
            from.press(forDuration: 0.05, thenDragTo: a.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: past ? 0.7 : 0.35)))
            tries += 1
        }
        XCTAssertTrue(c.exists && c.isHittable, "\(id) is on screen")
        return c
    }

    private func pick(_ a: XCUIApplication, _ id: String, _ label: String) {
        let b = control(a, id).buttons[label]
        b.tap()
        XCTAssertTrue(b.isSelected, "\(id) → \(label)")
    }

    private func serverDisplay() -> [String: String] {
        ((call("GET", "/api/me/profile")["profile"] as? [String: Any])?["display"] as? [String: String]) ?? [:]
    }

    private func serverHas(_ key: String, _ value: String, timeout: TimeInterval = 10) -> Bool {
        let until = Date().addingTimeInterval(timeout)
        repeat {
            if serverDisplay()[key] == value { return true }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < until
        return false
    }
}
