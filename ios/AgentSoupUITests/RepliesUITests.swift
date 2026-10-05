// QA for the chat's batch 4, matching the web: a reply lands in the chat with a quote bar and its thread opens over
// the chat (jxn #1040, vedu #1051) with the chat's own message box (jxn #1094); "#N" never shows in a quote (#675);
// replying to your own agent's post names it (#975); a chat opens at your first unread with a "New" line (jxn #1011);
// a change card opens on GitHub (vedu #1097).

import XCTest

final class RepliesUITests: AtteoUITestCase {
    private var mayaAgent: String { env["AGENT_SOUP_MAYA_AGENT"] ?? "" }
    private var theoAgent: String { env["AGENT_SOUP_OTHER_TOKEN"] ?? "" }
    private var n: Int { Int(Date().timeIntervalSince1970) % 100000 }

    private func seq(_ r: [String: Any]) -> Int { (r["entry"] as? [String: Any])?["seq"] as? Int ?? 0 }

    /// An agent's tool call on a board (it reads first: a post is refused while it has unread messages).
    @discardableResult
    private func tool(_ token: String, board: String, _ name: String, _ args: [String: Any]) -> [String: Any] {
        call("POST", "/mcp?board=\(board)", json: ["jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": ["name": name, "arguments": args]], token: token)
    }

    private func field(_ a: XCUIApplication, _ id: String) -> XCUIElement { composer(a, id) }

    /// Reply → the thread over the chat, with the chat's box (+ and send); the reply lands in the chat under a quote bar
    /// that reads the parent's "#N" as its title; the bar and "1 reply" both open the thread.
    func testReplyLandsInChatWithQuoteBar() throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let n = n
        let target = seq(call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": "Rollback plan \(n): flip PAYMENTS_V2 off"], token: otherApp))
        let parent = seq(call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": "Quote me \(n), see #\(target)"], token: otherApp))
        XCTAssertGreaterThan(parent, 0)

        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let msg = a.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Quote me \(n)")).firstMatch
        XCTAssertTrue(msg.waitForExistence(timeout: 10), "the message is here")
        msg.press(forDuration: 0.8)
        XCTAssertTrue(a.buttons["Reply"].waitForExistence(timeout: 3), "long-press offers Reply")
        a.buttons["Reply"].tap()

        // The thread, over the chat: the same box as the chat (+, the field, send), starting with "@theo ".
        XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 5), "Reply opens the thread")
        let tbox = field(a, "thread-composer")
        XCTAssertTrue(tbox.waitForExistence(timeout: 5))
        XCTAssertTrue(eventually(tbox, "value BEGINSWITH '@theo '"), "the reply names theo (\(tbox.value ?? ""))")
        XCTAssertTrue(a.buttons["thread-attach"].exists, "the chat's + is in the thread's box too")
        XCTAssertTrue(a.buttons["thread-send"].exists)
        shot("replies-01-thread-sheet")
        let answer = "answer \(n)"
        tbox.typeText(answer)
        a.buttons["thread-send"].tap()
        let inThread = a.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", answer)).firstMatch
        XCTAssertTrue(inThread.waitForExistence(timeout: 5), "the answer shows in the thread")
        XCTAssertTrue(a.staticTexts["Sending…"].waitForNonExistence(timeout: 10), "sent")
        shot("replies-02-answered")
        a.buttons["thread-close"].tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForNonExistence(timeout: 5), "closed: back in the chat")

        // In the chat: the answer at the bottom, under a bar quoting what it answers (no "#N" in it).
        let inChat = a.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", answer)).firstMatch
        XCTAssertTrue(inChat.waitForExistence(timeout: 5), "the reply is in the chat")
        XCTAssertTrue(eventually(inChat, "hittable == true"), "at the bottom, in view")
        let quote = a.buttons.matching(NSPredicate(format: "identifier == 'reply-quote' AND label CONTAINS %@", "Quote me \(n)")).firstMatch
        XCTAssertTrue(quote.waitForExistence(timeout: 5), "with its quote bar")
        XCTAssertTrue(quote.label.hasPrefix("Reply to theo"), quote.label)
        XCTAssertFalse(quote.label.contains("#\(target)"), "no message number in the quote (\(quote.label))")
        XCTAssertTrue(quote.label.contains("↗ Rollback plan"), "the number reads as its title (\(quote.label))")
        XCTAssertTrue(a.buttons["replies-\(parent)"].exists, "the parent says it has a reply")
        shot("replies-03-in-chat")

        // The quote bar opens the thread, on that reply.
        quote.tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 5), "the quote bar opens the thread")
        XCTAssertTrue(a.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", answer)).firstMatch.waitForExistence(timeout: 5))
        // (the chat under the sheet still has its quote bar: only what's on the sheet counts)
        XCTAssertFalse(a.buttons.matching(NSPredicate(format: "identifier == 'reply-quote' AND label CONTAINS %@", "Quote me \(n)")).allElementsBoundByIndex.contains { $0.isHittable },
                       "inside its thread a direct answer doesn't quote the message above it")
        a.buttons["thread-close"].tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForNonExistence(timeout: 5))

        // "1 reply" opens it too, the box starting with who wrote the message.
        let replies = a.buttons["replies-\(parent)"]
        for _ in 0..<4 where !replies.isHittable { a.swipeDown(velocity: .slow); sleep(1) }
        XCTAssertEqual(replies.label, "1 reply")
        replies.tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 5), "1 reply opens the thread")
        XCTAssertTrue(eventually(field(a, "thread-composer"), "value BEGINSWITH '@theo '"))
        a.navigationBars["Thread"].buttons.element(boundBy: 0).tap() // (Close is the bar's first button, as older tests use it)
        XCTAssertTrue(a.navigationBars["Thread"].waitForNonExistence(timeout: 5))
    }

    /// Replying to your own agent's post names it: "@maya's agent " (#975).
    func testReplyToYourOwnAgentNamesIt() throws {
        continueAfterFailure = false
        guard !mayaAgent.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (MAYA_AGENT)") }
        let n = n
        tool(mayaAgent, board: b1, "read", [:])
        tool(mayaAgent, board: b1, "post", ["type": "note", "text": "My agent here \(n): the guard is in"])
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let post = a.staticTexts["My agent here \(n): the guard is in"]
        XCTAssertTrue(post.waitForExistence(timeout: 10), "your agent's post is here")
        post.press(forDuration: 0.8)
        XCTAssertTrue(a.buttons["Reply"].waitForExistence(timeout: 3))
        a.buttons["Reply"].tap()
        let tbox = field(a, "thread-composer")
        XCTAssertTrue(tbox.waitForExistence(timeout: 5))
        XCTAssertTrue(eventually(tbox, "value BEGINSWITH \"@maya's agent \""), "replying to your own agent names it (\(tbox.value ?? ""))")
        shot("replies-04-own-agent")
        a.buttons["thread-close"].tap()
    }

    /// A chat opens at your first unread message, under a "New" line, with Jump to latest; that goes to the newest.
    func testOpensAtFirstUnread() throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, let q4 = boardId(titled: "Q4 data migration") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let n = n
        // maya has read everything there…
        let read = seq(call("POST", "/api/boards/\(q4)/entries", json: ["type": "note", "text": "Read up to here \(n)"], token: otherApp))
        call("POST", "/api/boards/\(q4)/seen", json: ["seq": read])
        // …then theo says a lot more.
        // 30, not 24: with the new look's shorter rows, 24 one-line messages overflowed the screen by less than the
        // chat's 80-point "at the latest" slack, so it was rightly treated as at the latest (no Jump to latest).
        for i in 1...30 { call("POST", "/api/boards/\(q4)/entries", json: ["type": "note", "text": "Unread \(n) number \(i)"], token: otherApp) }

        let a = app()
        a.launch()
        openChat(a, "Q4 data migration")
        let line = a.descendants(matching: .any)["new-divider"]
        XCTAssertTrue(line.waitForExistence(timeout: 10), "a New line")
        let first = a.staticTexts["Unread \(n) number 1"]
        XCTAssertTrue(eventually(first, "hittable == true", timeout: 6), "opens at the first unread")
        XCTAssertTrue(eventually(line, "hittable == true"), "with the New line above it in view")
        XCTAssertFalse(a.staticTexts["Unread \(n) number 30"].isHittable, "not at the newest")
        let jump = a.buttons["Jump to latest"]
        XCTAssertTrue(jump.waitForExistence(timeout: 5), "Jump to latest")
        sleep(2)
        XCTAssertTrue(first.isHittable, "it stays there while the layout settles")
        shot("unread-01-new-line")
        jump.tap()
        XCTAssertTrue(eventually(a.staticTexts["Unread \(n) number 30"], "hittable == true"), "Jump to latest goes to the newest")
        shot("unread-02-latest")

        // Read now: opening it again lands on the latest, no New line.
        a.navigationBars.buttons.element(boundBy: 0).tap()
        sleep(2)
        openChat(a, "Q4 data migration")
        XCTAssertTrue(eventually(a.staticTexts["Unread \(n) number 30"], "hittable == true"), "everything read: the latest")
        XCTAssertFalse(line.exists, "no New line")
    }

    /// A change card opens on GitHub: its commits' compare view (several commits).
    func testChangeCardOpensGitHub() throws {
        continueAfterFailure = false
        guard !theoAgent.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_TOKEN)") }
        let n = n
        tool(theoAgent, board: b1, "read", [:])
        tool(theoAgent, board: b1, "post", ["type": "change", "title": "Card \(n)", "text": "Card \(n): 2 commits",
                                           "card": ["repo": "octocat/Hello-World", "branch": "main", "ci": "passing",
                                                    "commits": [["sha": "7fd1a60b01f9", "title": "Merge pull request #6"], ["sha": "553c2077f0ed", "title": "first commit"]],
                                                    "files": [["path": "README", "added": 1, "removed": 0]]]])
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let title = a.staticTexts.matching(NSPredicate(format: "identifier == 'change-title' AND label == %@", "Card \(n)")).firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 10), "the card is here")
        let card = a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'change-card' AND value == %@",
                                                                       "https://github.com/octocat/Hello-World/compare/553c2077f0ed~1...7fd1a60b01f9")).firstMatch
        XCTAssertTrue(card.exists, "it goes to the compare view, oldest's parent to newest")
        shot("change-01-card")
        title.tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 10), "tapping the card opens it in Safari")
        a.activate()
    }
}
