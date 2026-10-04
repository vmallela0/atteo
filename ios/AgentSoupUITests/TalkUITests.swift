// Talk to Grok (vedu #1318) against the local server's fake voice: DEV_FAKE_VOICE=1 in the local .dev.vars, and the
// app (ATTEO_FAKE_VOICE=1) sends x-dev-fake-voice and plays the scripted conversation in TalkFake.swift. The tools run
// for real against the local server; the session is settled at the end (its 10-minute cap goes back to the month).

import XCTest

final class TalkUITests: AtteoUITestCase {
    private func text(_ a: XCUIApplication, _ prefix: String) -> XCUIElement {
        a.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    func testTalkToGrokWithTheFake() {
        let before = (call("GET", "/api/app/voice/status")["minutes_used"] as? NSNumber)?.doubleValue ?? 0
        let a = app(extra: ["AGENT_SOUP_FAKE_VOICE": "1"])
        a.launch()
        openChat(a, "Checkout bug")
        XCTAssertTrue(a.buttons["talk-header"].waitForExistence(timeout: 10), "the waveform in the top bar")
        let talk = a.buttons["talk"]
        XCTAssertTrue(talk.waitForExistence(timeout: 5), "the waveform by the mic")
        shot("talk-buttons")
        talk.tap()

        let state = a.staticTexts["talk-state"]
        XCTAssertTrue(state.waitForExistence(timeout: 10), "the talk sheet")
        XCTAssertTrue(eventually(state, "label == 'Hold to talk'", timeout: 15), "connected (\(state.label))")
        let timer = a.staticTexts["talk-timer"]
        XCTAssertTrue(timer.label.contains("left") && timer.label.contains("min this month"), timer.label)
        shot("talk-ready")
        let ptt = a.buttons["talk-button"]

        // 1. A question → a tool call (mailbox_summary, run against the server) → a spoken answer, and an interrupt.
        ptt.press(forDuration: 1.0)
        XCTAssertTrue(text(a, "You: What's waiting for me?").waitForExistence(timeout: 8), "your words as a caption")
        XCTAssertTrue(a.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Checking what's waiting")).firstMatch.waitForExistence(timeout: 8), "the tool shows")
        XCTAssertTrue(text(a, "Grok: Here's what's waiting for you").waitForExistence(timeout: 10), "Grok's answer as a caption")
        XCTAssertTrue(eventually(state, "label BEGINSWITH 'Grok is speaking'", timeout: 8), "speaking (\(state.label))")
        shot("talk-speaking")
        ptt.tap() // stop it mid-sentence
        XCTAssertTrue(eventually(state, "label == 'Hold to talk'", timeout: 5), "interrupted (\(state.label))")
        XCTAssertTrue(text(a, "Grok: Here's what's waiting for you").label.hasSuffix("—"), "the cut-off answer is marked")

        // 2. "Approve the deploy request." → nothing happens yet: the app asks for a yes.
        ptt.press(forDuration: 1.0)
        let card = a.descendants(matching: .any)["talk-confirm"]
        XCTAssertTrue(card.waitForExistence(timeout: 10), "a yes is asked for")
        XCTAssertTrue(a.buttons["talk-confirm-yes"].exists && a.buttons["talk-confirm-no"].exists)
        XCTAssertTrue(text(a, "Grok: That would approve the deploy request").waitForExistence(timeout: 10), "Grok asks out loud")
        shot("talk-confirm")

        // 3. "Yes." out loud → the app runs it (the fake's approval isn't on the server, so nothing changes).
        XCTAssertTrue(eventually(state, "label == 'Hold to talk'", timeout: 8))
        ptt.press(forDuration: 1.0)
        XCTAssertTrue(text(a, "You: Yes.").waitForExistence(timeout: 8))
        XCTAssertTrue(eventually(card, "exists == false", timeout: 10), "the yes was taken")
        XCTAssertTrue(text(a, "Grok: That approval wasn't found").waitForExistence(timeout: 10), "what the server said")

        // Mute (captions stay), then end: back in the chat, and the session is settled.
        a.buttons["talk-mute"].tap()
        XCTAssertEqual(a.buttons["talk-mute"].label, "Unmute Grok")
        shot("talk-done")
        a.buttons["talk-end"].tap()
        XCTAssertTrue(talk.waitForExistence(timeout: 8), "back in the chat")
        var used = 99.0
        for _ in 0..<10 {
            used = ((call("GET", "/api/app/voice/status")["minutes_used"] as? NSNumber)?.doubleValue ?? 99) - before
            if used < 2 { break }
            Thread.sleep(forTimeInterval: 1)
        }
        XCTAssertLessThan(used, 2, "the unused minutes went back")
    }
}
