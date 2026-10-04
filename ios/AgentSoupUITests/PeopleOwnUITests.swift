// QA for people and private messages in a chat (like the web): the People filter (jxn #1731, vedu #1060) hides
// agents' posts for you on a board, keeps people's (their replies too) and is remembered; the composer's lock
// (jxn #1748/#1749) sends People only or Just mine, starting at People only each time it's turned on (#1866/#1881),
// and a Just mine message is "own" on the server and wears its 🔒 note. People first in the chat list.

import XCTest

final class PeopleOwnUITests: AtteoUITestCase {
    private var theoAgent: String { env["AGENT_SOUP_OTHER_TOKEN"] ?? "" }
    private var n: Int { Int(Date().timeIntervalSince1970) % 100000 }
    /// Copies of the screenshots go here too when set (TEST_RUNNER_AGENT_SOUP_SHOTS=<dir>); they're always in the result bundle.
    private var shots: String? { env["AGENT_SOUP_SHOTS"] }

    private func seq(_ r: [String: Any]) -> Int { (r["entry"] as? [String: Any])?["seq"] as? Int ?? 0 }

    /// The newest message on the board with these words, as maya sees it (0: none).
    private func seqOf(_ words: String, on board: String) -> Int {
        let list = call("GET", "/api/boards/\(board)/entries?after=0&limit=1000")["entries"] as? [[String: Any]] ?? []
        return list.last { ($0["text"] as? String) == words }?["seq"] as? Int ?? 0
    }

    /// An agent's tool call on a board (it reads first: a post is refused while it has unread messages).
    @discardableResult
    private func tool(_ token: String, board: String, _ name: String, _ args: [String: Any]) -> [String: Any] {
        call("POST", "/mcp?board=\(board)", json: ["jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": ["name": name, "arguments": args]], token: token)
    }

    /// A screenshot in the result bundle, and a copy for review.
    private func keep(_ name: String) {
        shot(name)
        guard let shots, !shots.isEmpty else { return }
        try? FileManager.default.createDirectory(atPath: shots, withIntermediateDirectories: true)
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(shots)/\(name).png"))
    }

    private func text(_ a: XCUIApplication, _ s: String) -> XCUIElement {
        // (BEGINSWITH: a person's reply quotes the agent's words in its bar, "Reply to theo's agent: …", which stays.)
        a.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", s)).firstMatch
    }

    /// The chat's People filter, through the top bar's menu.
    private func toggleFilter(_ a: XCUIApplication, shot: String? = nil) {
        let menu = a.buttons["work-menu"].firstMatch
        XCTAssertTrue(menu.waitForExistence(timeout: 5))
        menu.tap()
        let item = a.descendants(matching: .any).matching(identifier: "people-filter").firstMatch
        let byLabel = a.buttons["Hide agents"].firstMatch
        if let shot { _ = item.waitForExistence(timeout: 3); sleep(1); keep(shot) }
        if item.waitForExistence(timeout: 3) { item.tap() } else { XCTAssertTrue(byLabel.waitForExistence(timeout: 2), "Hide agents is in the menu"); byLabel.tap() }
    }

    /// Hide agents: an agent's post leaves the chat, a person's (and a person's reply to that agent) stay; the strip says
    /// so; it's remembered for the board after a relaunch; Show all brings everything back.
    func testPeopleFilterHidesAgentsKeepsPeople() throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, !theoAgent.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let n = n
        tool(theoAgent, board: b1, "read", [:])
        let agentText = "Agent status \(n): the empty-cart guard is green"
        let r = tool(theoAgent, board: b1, "post", ["type": "note", "text": agentText, "reply_to": 0])
        XCTAssertNotNil(r["result"], "theo's agent posted (\(r))")
        let agentSeq = seqOf(agentText, on: b1)
        XCTAssertGreaterThan(agentSeq, 0, "the agent's post is on the board")
        let personText = "Person note \(n): let's ship Monday"
        XCTAssertGreaterThan(seq(call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": personText], token: otherApp)), 0)

        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        // (an earlier run may have left the filter on for this board)
        if a.buttons["people-filter-show-all"].waitForExistence(timeout: 2) { a.buttons["people-filter-show-all"].tap() }
        XCTAssertTrue(text(a, agentText).waitForExistence(timeout: 10), "the agent's post is in the chat")
        XCTAssertTrue(text(a, personText).exists, "and the person's")

        toggleFilter(a, shot: "people-filter-00-menu")
        let strip = a.descendants(matching: .any).matching(identifier: "people-filter-strip").firstMatch
        XCTAssertTrue(strip.waitForExistence(timeout: 5), "the strip says the filter is on")
        XCTAssertTrue(text(a, "Showing people only").exists)
        XCTAssertTrue(text(a, agentText).waitForNonExistence(timeout: 5), "the agent's post is hidden")
        XCTAssertTrue(text(a, personText).exists, "the person's stays")
        keep("people-filter-01-on")

        // A person's reply (theo answering his agent, live) shows; another agent post doesn't.
        let replyText = "Person reply \(n): nice, merging"
        XCTAssertGreaterThan(seq(call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": replyText, "reply_to": agentSeq], token: otherApp)), 0)
        XCTAssertTrue(text(a, replyText).waitForExistence(timeout: 10), "a person's reply shows with the filter on")
        tool(theoAgent, board: b1, "read", [:])
        let agentText2 = "Agent follow-up \(n): deploy queued"
        tool(theoAgent, board: b1, "post", ["type": "note", "text": agentText2, "reply_to": 0])
        sleep(3)
        XCTAssertFalse(text(a, agentText2).exists, "a new agent post stays hidden")
        keep("people-filter-02-strip")

        // Remembered for this board on this phone.
        a.terminate()
        let b = app(fresh: false)
        b.launch()
        openChat(b, "Checkout bug")
        XCTAssertTrue(b.descendants(matching: .any).matching(identifier: "people-filter-strip").firstMatch.waitForExistence(timeout: 5), "still on after a relaunch")
        XCTAssertFalse(text(b, agentText).exists)

        // Show all: everything again.
        b.buttons["people-filter-show-all"].tap()
        XCTAssertTrue(b.descendants(matching: .any).matching(identifier: "people-filter-strip").firstMatch.waitForNonExistence(timeout: 5), "the strip goes")
        XCTAssertTrue(text(b, agentText2).waitForExistence(timeout: 5), "agents' posts are back")
    }

    /// Show agents in a thread (jxn #2191): off, an agent's answer leaves the thread and a person's stays (the message
    /// it's about too); the strip says so; it's remembered for the next time a thread opens; Show all brings agents back.
    func testThreadShowAgentsHidesAgentAnswers() throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, !theoAgent.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let n = n
        let rootText = "Thread root \(n): which flag gates checkout?"
        let root = seq(call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": rootText], token: otherApp))
        XCTAssertGreaterThan(root, 0)
        tool(theoAgent, board: b1, "read", [:])
        let agentText = "Agent answer \(n): PAYMENTS_V2"
        let r = tool(theoAgent, board: b1, "post", ["type": "note", "text": agentText, "reply_to": root])
        XCTAssertNotNil(r["result"], "theo's agent answered (\(r))")
        XCTAssertGreaterThan(seqOf(agentText, on: b1), 0, "the agent's answer is on the board")
        let personText = "Person answer \(n): agreed, PAYMENTS_V2"
        XCTAssertGreaterThan(seq(call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": personText, "reply_to": root], token: otherApp)), 0)

        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        if a.buttons["people-filter-show-all"].waitForExistence(timeout: 2) { a.buttons["people-filter-show-all"].tap() }
        let replies = a.buttons["replies-\(root)"]
        XCTAssertTrue(replies.waitForExistence(timeout: 10), "the message says it has replies")
        replies.tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 5), "its thread opens")
        // (an earlier run may have left agents hidden)
        if a.buttons["thread-agents-show-all"].waitForExistence(timeout: 2) { a.buttons["thread-agents-show-all"].tap() }
        let thread = a.scrollViews["thread-list"]
        func inThread(_ s: String) -> XCUIElement { thread.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", s)).firstMatch }
        XCTAssertTrue(inThread(agentText).waitForExistence(timeout: 10), "the agent's answer is in the thread")
        XCTAssertTrue(inThread(personText).exists, "and the person's")

        a.buttons["thread-menu"].tap()
        let item = a.descendants(matching: .any).matching(identifier: "thread-show-agents").firstMatch
        if item.waitForExistence(timeout: 3) { sleep(1); keep("thread-agents-00-menu"); item.tap() }
        else { XCTAssertTrue(a.buttons["Show agents"].waitForExistence(timeout: 2), "Show agents is in the menu"); a.buttons["Show agents"].tap() }
        let strip = a.descendants(matching: .any).matching(identifier: "thread-agents-strip").firstMatch
        XCTAssertTrue(strip.waitForExistence(timeout: 5), "the strip says only people show")
        XCTAssertTrue(inThread(agentText).waitForNonExistence(timeout: 5), "the agent's answer is hidden")
        XCTAssertTrue(inThread(personText).exists, "the person's stays")
        XCTAssertTrue(inThread(rootText).exists, "and the message it's about")
        keep("thread-agents-01-people-only")

        // Remembered: the next time the thread opens, agents are still hidden.
        a.buttons["thread-close"].tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForNonExistence(timeout: 5))
        a.buttons["replies-\(root)"].tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 5))
        XCTAssertTrue(a.descendants(matching: .any).matching(identifier: "thread-agents-strip").firstMatch.waitForExistence(timeout: 5), "still people only")
        XCTAssertTrue(inThread(personText).waitForExistence(timeout: 5))
        XCTAssertFalse(inThread(agentText).exists, "the agent's answer stays hidden")

        // Show all: agents again.
        a.buttons["thread-agents-show-all"].tap()
        XCTAssertTrue(inThread(agentText).waitForExistence(timeout: 5), "the agent's answer is back")
        XCTAssertFalse(a.descendants(matching: .any).matching(identifier: "thread-agents-strip").firstMatch.exists, "the strip goes")
        a.buttons["thread-close"].tap()
    }

    /// The lock: a tap turns it on at People only; Just mine is picked; the message is "own" on the server, wears the
    /// 🔒 Just mine note, and the lock is off again after sending.
    func testJustMinePostsOwnEntry() throws {
        continueAfterFailure = false
        guard let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server") }
        let n = n

        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let lock = a.buttons["composer-lock"]
        XCTAssertTrue(lock.waitForExistence(timeout: 5), "the lock is in the chat's box")
        lock.tap()
        XCTAssertTrue(a.buttons["lock-people"].waitForExistence(timeout: 3))
        XCTAssertTrue(a.buttons["lock-people"].isSelected, "it starts at People only")
        a.buttons["lock-own"].tap()
        XCTAssertTrue(eventually(a.buttons["lock-own"], "selected == true"), "Just mine picked")
        let box = composer(a)
        box.tap()
        let words = "Note to self \(n): check the Stripe dashboard"
        box.typeText(words)
        keep("people-own-01-lock-menu")
        a.buttons["send"].tap()

        let badge = a.descendants(matching: .any).matching(identifier: "own-badge").firstMatch
        XCTAssertTrue(badge.waitForExistence(timeout: 10), "the 🔒 Just mine note shows")
        XCTAssertTrue(badge.label.contains("Just mine"), badge.label)
        XCTAssertTrue(a.staticTexts["Sending…"].waitForNonExistence(timeout: 10), "sent")
        XCTAssertFalse(a.buttons["lock-own"].exists, "the lock is off again after sending")
        keep("people-own-02-just-mine-message")

        // The server: audience "own" (GET the entry as maya).
        let s = seqOf(words, on: b1)
        XCTAssertGreaterThan(s, 0, "the message is on the board")
        let got = call("GET", "/api/boards/\(b1)/entries/\(s)")["entry"] as? [String: Any]
        XCTAssertEqual(got?["audience"] as? String, "own", "the server keeps it Just mine (\(got ?? [:]))")
    }

    /// Each tap of the lock starts at People only; People only needs an @person; it's not offered in a DM, "Your agent"
    /// or an encrypted board.
    func testLockStartsAtPeopleOnlyEachTap() throws {
        continueAfterFailure = false
        guard let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server") }
        let n = n
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let lock = a.buttons["composer-lock"]
        XCTAssertTrue(lock.waitForExistence(timeout: 5))
        for round in 1...2 {
            lock.tap()
            XCTAssertTrue(a.buttons["lock-people"].waitForExistence(timeout: 3), "round \(round): the choices show")
            XCTAssertTrue(a.buttons["lock-people"].isSelected, "round \(round): People only first")
            XCTAssertFalse(a.buttons["lock-own"].isSelected)
            XCTAssertTrue(a.buttons["lock-everyone"].exists)
            a.buttons["lock-own"].tap()
            XCTAssertTrue(eventually(a.buttons["lock-own"], "selected == true"))
            lock.tap() // off
            XCTAssertTrue(a.buttons["lock-people"].waitForNonExistence(timeout: 3), "round \(round): off")
        }
        // Everyone turns it off too.
        lock.tap()
        XCTAssertTrue(a.buttons["lock-everyone"].waitForExistence(timeout: 3))
        a.buttons["lock-everyone"].tap()
        XCTAssertTrue(a.buttons["lock-people"].waitForNonExistence(timeout: 3), "Everyone: the lock is off")

        // People only without an @person: it says who it needs and keeps the words.
        lock.tap()
        let box = composer(a)
        box.tap()
        box.typeText("Just between us \(n)")
        a.buttons["send"].tap()
        let why = a.staticTexts["lock-why"]
        XCTAssertTrue(eventually(why, "label BEGINSWITH '@ the people'"), "asks for an @person (\(why.label))")
        XCTAssertTrue(eventually(box, "value CONTAINS 'Just between us'"), "nothing was sent")
        // With @theo: sent People only, marked so.
        box.typeText(" @theo ")
        a.buttons["send"].tap()
        let badge = a.descendants(matching: .any).matching(identifier: "people-badge").firstMatch
        XCTAssertTrue(badge.waitForExistence(timeout: 10), "the People only mark shows")
        XCTAssertTrue(a.staticTexts["Sending…"].waitForNonExistence(timeout: 10), "sent")
        let last = seqOf("Just between us \(n) @theo", on: b1)
        XCTAssertGreaterThan(last, 0, "the message is on the board")
        let got = call("GET", "/api/boards/\(b1)/entries/\(last)")["entry"] as? [String: Any]
        XCTAssertEqual(got?["audience"] as? String, "people", "\(got ?? [:])")
        XCTAssertEqual(Set(got?["to_people"] as? [String] ?? []), ["maya", "theo"])
        keep("people-own-03-people-only")

        // Not in a DM, nor on "Your agent", nor on an encrypted board.
        a.navigationBars.buttons.element(boundBy: 0).tap()
        a.buttons["tab-direct"].tap()
        let dm = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chat-' AND identifier CONTAINS 'priya'")).firstMatch
        XCTAssertTrue(dm.waitForExistence(timeout: 5), "the DM with priya")
        dm.tap()
        XCTAssertTrue(composer(a).waitForExistence(timeout: 10))
        XCTAssertFalse(a.buttons["composer-lock"].exists, "no lock in a DM")
        a.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(a.buttons["chat-your-agent"].waitForExistence(timeout: 5))
        a.buttons["chat-your-agent"].tap()
        XCTAssertTrue(composer(a).waitForExistence(timeout: 10))
        XCTAssertFalse(a.buttons["composer-lock"].exists, "no lock on Your agent")
        a.navigationBars.buttons.element(boundBy: 0).tap()
        openChat(a, "Secret plans")
        XCTAssertFalse(a.buttons["composer-lock"].exists, "no lock on an encrypted board")
    }

    /// People first in the chat list: a switch beside Boards / DMs.
    func testPeopleFirstInChatList() throws {
        let a = app()
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15))
        let pf = a.buttons["people-first"]
        XCTAssertTrue(pf.waitForExistence(timeout: 5))
        if pf.isSelected { pf.tap() }
        XCTAssertFalse(pf.isSelected)
        pf.tap()
        XCTAssertTrue(eventually(pf, "selected == true"), "on")
        XCTAssertTrue(a.buttons["chat-Checkout bug"].firstMatch.waitForExistence(timeout: 5), "chats with people stay")
        keep("people-first-01-on")
        pf.tap()
        XCTAssertTrue(eventually(pf, "selected == false"), "off")
    }
}
