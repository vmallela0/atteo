// QA for "… is typing" (#608, people only): theo types on his phone (POST /typing as him) and maya's chat shows
// "theo is typing" above the message box, in the chat and in a thread; it clears the moment his message lands. And
// the other way: maya typing in the app reaches theo's socket as {type:"typing", who:"maya"}.

import XCTest

final class TypingUITests: AtteoUITestCase {
    func testTypingIndicator() throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let row = a.descendants(matching: .any)["typing"]
        XCTAssertFalse(row.exists, "nobody's typing yet")

        // theo starts typing on his phone.
        XCTAssertEqual(call("POST", "/api/boards/\(b1)/typing", json: [:], token: otherApp)["_status"] as? Int, 204)
        XCTAssertTrue(row.waitForExistence(timeout: 6), "the row shows")
        XCTAssertEqual(row.label, "theo is typing")
        shot("typing-01-chat")

        // His message lands: the row goes at once (not when the ping runs out).
        call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": "Typing test: here it is"], token: otherApp)
        XCTAssertTrue(row.waitForNonExistence(timeout: 4), "cleared when his message arrived")
        shot("typing-02-cleared")

        // A ping runs out on its own (6 s) if no message follows.
        call("POST", "/api/boards/\(b1)/typing", json: [:], token: otherApp)
        XCTAssertTrue(row.waitForExistence(timeout: 6))
        XCTAssertTrue(row.waitForNonExistence(timeout: 10), "gone once it runs out")

        // In a thread: the reply box shows the board's typers too.
        let replies = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'replies-'")).firstMatch
        if replies.waitForExistence(timeout: 3) {
            replies.tap()
            XCTAssertTrue(composer(a, "thread-composer").waitForExistence(timeout: 6), "the thread opens")
            call("POST", "/api/boards/\(b1)/typing", json: [:], token: otherApp)
            XCTAssertTrue(row.waitForExistence(timeout: 6), "the thread's reply box shows it too")
            shot("typing-03-thread")
            a.navigationBars.buttons.element(boundBy: 0).tap()
        }

        // maya types: theo's socket hears "maya is typing".
        let heard = expectation(description: "theo hears maya typing")
        let server = env["AGENT_SOUP_SERVER"]!.replacingOccurrences(of: "http", with: "ws")
        var r = URLRequest(url: URL(string: "\(server)/api/boards/\(b1)/ws")!)
        r.setValue("Bearer \(otherApp)", forHTTPHeaderField: "authorization")
        let ws = URLSession.shared.webSocketTask(with: r)
        ws.resume()
        func listen() {
            ws.receive { result in
                if case .success(.string(let s)) = result, s.contains("\"typing\""), s.contains("\"maya\"") { heard.fulfill(); return }
                if case .success = result { listen() }
            }
        }
        listen()
        sleep(1)
        let box = composer(a)
        box.tap()
        box.typeText("Hello th")
        wait(for: [heard], timeout: 8)
        ws.cancel(with: .goingAway, reason: nil)
    }
}
