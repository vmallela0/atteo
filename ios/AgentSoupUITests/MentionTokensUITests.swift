// jxn #2551: the app's @ menu names each live agent session ("@theo/scout"), like the web's, and a mention in the
// message box is one unit: one Backspace removes it whole. What's sent reaches that one session.

import XCTest

final class MentionTokensUITests: AtteoUITestCase {
    private var theoAgent: String { env["AGENT_SOUP_OTHER_TOKEN"] ?? "" }

    func testMentionALiveSessionAsOneToken() throws {
        guard let b = boardId(titled: "Checkout bug"), !theoAgent.isEmpty else { throw XCTSkip("needs the seed") }
        // A session of theo's agent working on the board now, with a name you can mention.
        let name = "scout\(Int.random(in: 1000...9999))"
        let made = call("POST", "/api/sessions", json: ["name": name, "client": "Claude Code"], token: theoAgent)
        guard let sid = (made["session"] as? [String: Any])?["id"] as? String else { return XCTFail("session: \(made)") }
        defer { call("DELETE", "/api/sessions/\(sid)", token: theoAgent) }
        call("POST", "/api/sessions/\(sid)/boards", json: ["board": b], token: theoAgent)
        call("POST", "/api/sessions/\(sid)", json: ["status": "triaging the alerts"], token: theoAgent)

        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let box = composer(a)
        box.tap()

        // "@theo/" offers theo's sessions, each with what it's doing.
        box.typeText("@theo/sc")
        let option = a.buttons["mention-theo/\(name)"]
        XCTAssertTrue(option.waitForExistence(timeout: 10), "the live session is in the @ menu")
        XCTAssertTrue(option.label.contains("triaging the alerts") || a.staticTexts["triaging the alerts"].exists, "with its status: \(option.label)")
        shot("mt-01-at-session")
        option.tap()
        XCTAssertTrue(eventually(box, "value == '@theo/\(name) '"), "the web's text: @theo/\(name) and a space")

        // The space goes with one Backspace; the mention with one more, whole.
        box.typeText(XCUIKeyboardKey.delete.rawValue)
        XCTAssertTrue(eventually(box, "value == '@theo/\(name)'"))
        box.typeText(XCUIKeyboardKey.delete.rawValue)
        XCTAssertTrue(eventually(box, "value == '' || value == nil || value == 'Message'"), "one Backspace removed the whole mention: \(String(describing: box.value))")
        shot("mt-02-removed-whole")

        // And sent, it reaches that session.
        box.typeText("@theo/sc")
        XCTAssertTrue(option.waitForExistence(timeout: 5))
        option.tap()
        let marker = "check the alert \(name)"
        box.typeText(marker)
        // Read after where the board is now: a page from 0 is the oldest 500, and Checkout bug passes that in a full run.
        let since = (call("GET", "/api/boards/\(b)/entries?after=999999999")["last"] as? Int) ?? 0
        a.buttons["send"].tap()
        var mention: [String: Any]?
        for _ in 0..<20 where mention == nil {
            let entries = call("GET", "/api/boards/\(b)/entries?after=\(since)&limit=500")["entries"] as? [[String: Any]] ?? []
            let e = entries.last { ($0["text"] as? String)?.contains(marker) == true }
            mention = (e?["mentions"] as? [[String: Any]])?.first { $0["session"] as? String == name }
            if mention == nil { sleep(1) }
        }
        XCTAssertEqual(mention?["user"] as? String, "theo", "the post mentions theo's session")
        XCTAssertEqual(mention?["agent"] as? Bool, true)
    }
}
