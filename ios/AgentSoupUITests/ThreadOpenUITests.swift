// Opening a thread every way, with Replies on "Only in threads" and "In the chat" (vedu #2449: "opening threads in app
// seems to have some really weird bug"): the thread opens once, stays open, shows its message and every answer once,
// and sending, a live answer and closing behave.

import XCTest

final class ThreadOpenUITests: AtteoUITestCase {
    private var n: Int { Int(Date().timeIntervalSince1970) % 100000 }
    private func seq(_ r: [String: Any]) -> Int { (r["entry"] as? [String: Any])?["seq"] as? Int ?? 0 }
    private func texts(_ a: XCUIApplication, _ s: String) -> XCUIElementQuery {
        a.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", s))
    }

    /// theo: a message, three answers and an answer to an answer.
    private func seed(_ board: String, _ n: Int) -> (root: Int, rootText: String, answers: [String], nestedText: String) {
        let rootText = "Thread root \(n): ship it tonight?"
        let root = seq(call("POST", "/api/boards/\(board)/entries", json: ["type": "note", "text": rootText], token: otherApp))
        var answers: [String] = []
        var first = 0
        for i in 1...3 {
            let t = "answer \(i) of \(n)"
            let s = seq(call("POST", "/api/boards/\(board)/entries", json: ["type": "note", "text": t, "reply_to": root], token: otherApp))
            if i == 1 { first = s }
            answers.append(t)
        }
        let nestedText = "nested under answer 1 of \(n)"
        _ = call("POST", "/api/boards/\(board)/entries", json: ["type": "note", "text": nestedText, "reply_to": first], token: otherApp)
        return (root, rootText, answers, nestedText)
    }

    /// The thread is open, once, and still open a moment later; its message and answers show exactly once.
    private func assertThread(_ a: XCUIApplication, _ expect: [String], _ step: String) {
        XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 6), "\(step): the thread opens")
        Thread.sleep(forTimeInterval: 2.5)
        XCTAssertEqual(a.navigationBars.matching(identifier: "Thread").count, 1, "\(step): one thread, not two")
        XCTAssertTrue(a.navigationBars["Thread"].exists, "\(step): still open after a moment")
        // (Counted in the thread's own list: the chat under the sheet and quote bars carry the same words.)
        let inThread = a.scrollViews.matching(identifier: "thread-list").firstMatch
        for t in expect {
            let q = inThread.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", t))
            XCTAssertTrue(q.firstMatch.waitForExistence(timeout: 6), "\(step): \(t) is in the thread")
            XCTAssertEqual(q.count, 1, "\(step): \(t) shows once (\(q.count))")
        }
        shot("thread-open-\(step)")
    }

    private func close(_ a: XCUIApplication, _ step: String) {
        a.buttons["thread-close"].firstMatch.tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForNonExistence(timeout: 6), "\(step): closes")
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertFalse(a.navigationBars["Thread"].exists, "\(step): stays closed")
    }

    private func sendInThread(_ a: XCUIApplication, _ text: String, _ step: String) {
        let box = composer(a, "thread-composer")
        XCTAssertTrue(box.waitForExistence(timeout: 5), "\(step): the thread's box")
        box.tap()
        box.typeText(text)
        a.buttons["thread-send"].tap()
        XCTAssertTrue(texts(a, text).firstMatch.waitForExistence(timeout: 6), "\(step): the answer shows")
        XCTAssertTrue(a.staticTexts["Sending…"].waitForNonExistence(timeout: 10), "\(step): sent")
        Thread.sleep(forTimeInterval: 2)
        let mine = a.scrollViews.matching(identifier: "thread-list").firstMatch.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text))
        XCTAssertEqual(mine.count, 1, "\(step): the answer shows once (\(mine.count))")
        XCTAssertTrue(a.navigationBars["Thread"].exists, "\(step): the thread stays open after sending")
    }

    private func run(mode: String) throws {
        continueAfterFailure = true
        guard !otherApp.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let n = n
        let t = seed(b1, n)
        let all = [t.rootText] + t.answers + [t.nestedText]
        let a = app(extra: ["AGENT_SOUP_DISPLAY": "m,comfortable,system,auto,eve,\(mode)"])
        a.launch()
        openChat(a, "Checkout bug")
        XCTAssertTrue(texts(a, t.rootText).firstMatch.waitForExistence(timeout: 10), "the message is in the chat")
        shot("thread-open-\(mode)-00-chat")

        // 1. "N replies".
        let count = a.buttons["replies-\(t.root)"]
        XCTAssertTrue(count.waitForExistence(timeout: 6), "N replies")
        count.tap()
        assertThread(a, all, "\(mode)-01-count")
        // 2. Answer in it.
        sendInThread(a, "mine \(mode) \(n)", "\(mode)-02-send")
        // 3. A live answer from theo while it's open.
        let live = "live \(mode) \(n)"
        _ = call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": live, "reply_to": t.root], token: otherApp)
        let liveHere = a.scrollViews.matching(identifier: "thread-list").firstMatch.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", live))
        XCTAssertTrue(liveHere.firstMatch.waitForExistence(timeout: 10), "\(mode): a live answer shows in the open thread")
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertEqual(liveHere.count, 1, "\(mode): the live answer shows once")
        close(a, "\(mode)-03")

        // 4. Long-press → Reply on the message (the chat came back drawn, not blank).
        // (In the chat, the answers are under the message, so the latest one is what's in view.)
        chatDrawn(a, mode == "thread" ? t.rootText : live, "\(mode)-03-after-close")
        let msg = texts(a, t.rootText).firstMatch
        msg.press(forDuration: 0.8)
        if a.buttons["Reply"].waitForExistence(timeout: 3) {
            a.buttons["Reply"].tap()
            assertThread(a, [t.rootText], "\(mode)-04-reply")
            sendInThread(a, "via reply \(mode) \(n)", "\(mode)-05-reply-send")
            close(a, "\(mode)-05")
        } else { XCTFail("\(mode): long-press offers Reply") }

        // 5. Long-press → View thread.
        msg.press(forDuration: 0.8)
        if a.buttons["View thread"].waitForExistence(timeout: 3) {
            a.buttons["View thread"].tap()
            assertThread(a, all, "\(mode)-06-view")
            close(a, "\(mode)-06")
        } else { XCTFail("\(mode): long-press offers View thread") }

        // 6. The Threads list, from the board's ⋯ menu (in the rail sheet).
        let menu = a.buttons["board-rail"].firstMatch
        if menu.waitForExistence(timeout: 4) {
            a.openThreadsList()
            let row = a.buttons.matching(NSPredicate(format: "label CONTAINS %@", t.rootText)).firstMatch
            if row.waitForExistence(timeout: 6) {
                row.tap()
                assertThread(a, all, "\(mode)-07-list") // pushed in the Threads sheet (a back button, not Close)
            } else { shot("thread-open-\(mode)-07-list-missing"); XCTFail("\(mode): the thread is in the Threads list") }
        }

        // 7. In the chat only: the nested answer's quote bar opens the thread at it.
        if mode == "chat" {
            a.terminate()
            a.launch()
            openChat(a, "Checkout bug")
            let quote = a.buttons.matching(NSPredicate(format: "identifier == 'reply-quote' AND label CONTAINS %@", "answer 1 of \(n)")).firstMatch
            if quote.waitForExistence(timeout: 8) {
                quote.tap()
                assertThread(a, all, "\(mode)-08-quote")
                close(a, "\(mode)-08")
            } else { XCTFail("chat: the nested answer's quote bar") }
        }
    }

    /// The chat still shows its messages (on screen, not a blank page) at the latest.
    private func chatDrawn(_ a: XCUIApplication, _ rootText: String, _ step: String) {
        let msg = texts(a, rootText).firstMatch
        XCTAssertTrue(msg.waitForExistence(timeout: 6), "\(step): the chat still shows the thread's message")
        XCTAssertTrue(eventually(msg, "hittable == true", timeout: 4), "\(step): on screen")
        shot("thread-open-drawn-\(step)")
    }

    /// Only in threads: open and close, send in it and close, a live answer while closed; the chat stays drawn.
    func testChatStaysDrawnAfterAThread() throws {
        continueAfterFailure = true
        guard !otherApp.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let n = n
        let t = seed(b1, n)
        let a = app(extra: ["AGENT_SOUP_DISPLAY": "m,comfortable,system,auto,eve,thread"])
        a.launch()
        openChat(a, "Checkout bug")
        chatDrawn(a, t.rootText, "a-start")
        let count = a.buttons["replies-\(t.root)"]
        XCTAssertTrue(count.waitForExistence(timeout: 6))
        count.tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 6))
        close(a, "b")
        chatDrawn(a, t.rootText, "b-open-close")
        _ = call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": "closed live \(n)", "reply_to": t.root], token: otherApp)
        Thread.sleep(forTimeInterval: 3)
        chatDrawn(a, t.rootText, "c-live-while-closed")
        count.tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 6))
        sendInThread(a, "mine drawn \(n)", "d")
        close(a, "d")
        chatDrawn(a, t.rootText, "d-send-close")
        // A live answer while the thread is open, then close.
        count.tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 6))
        let live = "open live \(n)"
        _ = call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": live, "reply_to": t.root], token: otherApp)
        XCTAssertTrue(texts(a, live).firstMatch.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 1.5)
        close(a, "e")
        chatDrawn(a, t.rootText, "e-live-open-close")
    }

    func testOpenThreadsOnlyInThreads() throws { try run(mode: "thread") }
    func testOpenThreadsInTheChat() throws { try run(mode: "chat") }
}
