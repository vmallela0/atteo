// Voice chat with Atteo (vedu #1318, hands-free #1598, "Atteo" on screen #1599, one way in #1602) against the local
// server's fake voice: DEV_FAKE_VOICE=1 in the local .dev.vars, and the app (ATTEO_FAKE_VOICE=1) sends x-dev-fake-voice
// and plays the scripted conversation in TalkFake.swift. Hands-free there's no mic: a tap on the orb is the fake person
// saying the next line (speech_started → speech_stopped → transcript → an answer, no button). The tools run for real
// against the local server; the session is settled at the end (its 10-minute cap goes back to the month).

import XCTest

final class TalkUITests: AtteoUITestCase {
    private func text(_ a: XCUIApplication, _ prefix: String) -> XCUIElement {
        a.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    /// Hands-free unless a test switches (the per-device choice is pinned for this run).
    private func launch() -> XCUIApplication {
        let a = app(extra: ["AGENT_SOUP_FAKE_VOICE": "1"])
        a.launchArguments += ["-talk-hold-to-talk", "NO"]
        a.launch()
        return a
    }

    private func minutesUsed() -> Double { (call("GET", "/api/app/voice/status")["minutes_used"] as? NSNumber)?.doubleValue ?? 0 }

    private func endAndSettle(_ a: XCUIApplication, before: Double) {
        a.buttons["talk-end"].tap()
        XCTAssertTrue(a.buttons["talk"].waitForExistence(timeout: 8), "back in the chat")
        var used = 99.0
        for _ in 0..<10 {
            used = minutesUsed() - before
            if used < 2 { break }
            Thread.sleep(forTimeInterval: 1)
        }
        XCTAssertLessThan(used, 2, "the unused minutes went back")
    }

    func testVoiceChatHandsFreeWithTheFake() {
        let before = minutesUsed()
        let a = launch()
        openChat(a, "Checkout bug")
        let talk = a.buttons["talk"]
        XCTAssertTrue(talk.waitForExistence(timeout: 10), "the waveform by the mic")
        XCTAssertFalse(a.buttons["talk-header"].exists, "one way in: no waveform in the top bar (#1602)")
        XCTAssertEqual(talk.label, "Talk to Atteo")
        shot("talk-buttons")
        talk.tap()

        let state = a.staticTexts["talk-state"]
        XCTAssertTrue(state.waitForExistence(timeout: 10), "the voice chat sheet")
        XCTAssertTrue(eventually(state, "label == 'Listening…'", timeout: 15), "connected, listening (\(state.label))")
        XCTAssertFalse(a.buttons["talk-button"].exists, "no hold-to-talk button hands-free")
        XCTAssertTrue(a.staticTexts["Atteo"].exists, "it's Atteo on screen")
        let timer = a.staticTexts["talk-timer"]
        XCTAssertTrue(timer.label.contains("left") && timer.label.contains("min this month"), timer.label)
        shot("talk-listening")
        let orb = a.buttons["talk-orb"]
        XCTAssertTrue(orb.exists)

        // 1. Just talk (the fake's person speaks) → a tool call (mailbox_summary, run against the server) → an answer.
        orb.tap()
        XCTAssertTrue(text(a, "You: What's waiting for me?").waitForExistence(timeout: 8), "your words as a caption")
        XCTAssertTrue(a.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Checking what's waiting")).firstMatch.waitForExistence(timeout: 8), "the tool shows")
        XCTAssertTrue(text(a, "Atteo: Here's what's waiting for you").waitForExistence(timeout: 10), "the answer as a caption")
        XCTAssertTrue(eventually(state, "label == 'Atteo is speaking'", timeout: 8), "speaking (\(state.label))")
        shot("talk-speaking")

        // 2. Talking over it (barge-in): it stops at once, and "Approve the deploy request." → a yes is asked for.
        orb.tap()
        XCTAssertTrue(eventually(text(a, "Atteo: Here's what's waiting for you"), "label ENDSWITH '—'", timeout: 5), "the cut-off answer is marked")
        XCTAssertTrue(text(a, "You: Approve the deploy request.").waitForExistence(timeout: 8))
        let card = a.descendants(matching: .any)["talk-confirm"]
        XCTAssertTrue(card.waitForExistence(timeout: 10), "a yes is asked for")
        XCTAssertTrue(a.buttons["talk-confirm-yes"].exists && a.buttons["talk-confirm-no"].exists)
        XCTAssertTrue(text(a, "Atteo: That would approve the deploy request").waitForExistence(timeout: 10), "asked out loud")
        shot("talk-confirm")

        // 3. "Yes." out loud → the app runs it (the fake's approval isn't on the server, so nothing changes).
        XCTAssertTrue(eventually(state, "label == 'Listening…'", timeout: 8), "listening again (\(state.label))")
        orb.tap()
        XCTAssertTrue(text(a, "You: Yes.").waitForExistence(timeout: 8))
        XCTAssertTrue(eventually(card, "exists == false", timeout: 10), "the yes was taken")
        XCTAssertTrue(text(a, "Atteo: That approval wasn't found").waitForExistence(timeout: 10), "what the server said")
        XCTAssertTrue(eventually(state, "label == 'Listening…'", timeout: 8))

        // The mic off (nothing is heard), Atteo's voice muted (captions stay).
        let mic = a.buttons["talk-mic"]
        mic.tap()
        XCTAssertEqual(mic.label, "Unmute mic")
        XCTAssertTrue(eventually(state, "label == 'Mic off'", timeout: 3), state.label)
        let count = a.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'You:'")).count
        orb.tap()
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertEqual(a.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'You:'")).count, count, "nothing heard with the mic off")
        mic.tap()
        XCTAssertTrue(eventually(state, "label == 'Listening…'", timeout: 3))
        a.buttons["talk-mute"].tap()
        XCTAssertEqual(a.buttons["talk-mute"].label, "Unmute Atteo")
        shot("talk-done")
        endAndSettle(a, before: before)
    }

    /// Everyday's Ask screen opens the same hands-free sheet (EverydayHooks.talk).
    func testVoiceChatFromEverydayAsk() {
        let before = minutesUsed()
        let a = app(extra: ["AGENT_SOUP_FAKE_VOICE": "1", "AGENT_SOUP_MODE": "everyday"])
        a.launchArguments += ["-talk-hold-to-talk", "NO"]
        a.launch()
        XCTAssertTrue(a.buttons["ask-bar"].waitForExistence(timeout: 15), "For you's Ask bar")
        a.buttons["ask-bar"].tap()
        let voice = a.buttons["ask-talk"]
        XCTAssertTrue(voice.waitForExistence(timeout: 8), "Voice chat beside Type instead")
        XCTAssertEqual(voice.label, "Talk to Atteo")
        shot("talk-ask")
        voice.tap()
        let state = a.staticTexts["talk-state"]
        XCTAssertTrue(eventually(state, "label == 'Listening…'", timeout: 15), "hands-free (\(state.label))")
        a.buttons["talk-orb"].tap()
        XCTAssertTrue(text(a, "You: What's waiting for me?").waitForExistence(timeout: 8))
        XCTAssertTrue(text(a, "Atteo: Here's what's waiting for you").waitForExistence(timeout: 10))
        a.buttons["talk-end"].tap()
        XCTAssertTrue(voice.waitForExistence(timeout: 8), "back on Ask")
        var used = 99.0
        for _ in 0..<10 {
            used = minutesUsed() - before
            if used < 2 { break }
            Thread.sleep(forTimeInterval: 1)
        }
        XCTAssertLessThan(used, 2, "the unused minutes went back")
    }

    func testHoldToTalkFallback() {
        let before = minutesUsed()
        let a = launch()
        openChat(a, "Checkout bug")
        let talk = a.buttons["talk"]
        XCTAssertTrue(talk.waitForExistence(timeout: 10))
        talk.tap()
        let state = a.staticTexts["talk-state"]
        XCTAssertTrue(eventually(state, "label == 'Listening…'", timeout: 15), "hands-free first (\(state.label))")

        // The menu → Hold to talk: the button is back, and a press is a turn.
        a.buttons["talk-menu"].tap()
        let hold = a.buttons["Hold to talk"]
        XCTAssertTrue(hold.waitForExistence(timeout: 5), "Hold to talk in the menu")
        shot("talk-menu")
        hold.tap()
        XCTAssertTrue(eventually(state, "label == 'Hold to talk'", timeout: 5), "push-to-talk (\(state.label))")
        let ptt = a.buttons["talk-button"]
        XCTAssertTrue(ptt.exists)
        XCTAssertFalse(a.buttons["talk-orb"].exists)
        ptt.press(forDuration: 1.0)
        XCTAssertTrue(text(a, "You: What's waiting for me?").waitForExistence(timeout: 8))
        XCTAssertTrue(text(a, "Atteo: Here's what's waiting for you").waitForExistence(timeout: 10))
        XCTAssertTrue(eventually(state, "label BEGINSWITH 'Atteo is speaking'", timeout: 8), "speaking (\(state.label))")
        ptt.tap() // stop it mid-sentence
        XCTAssertTrue(eventually(state, "label == 'Hold to talk'", timeout: 5), "interrupted (\(state.label))")
        XCTAssertTrue(text(a, "Atteo: Here's what's waiting for you").label.hasSuffix("—"), "the cut-off answer is marked")
        shot("talk-hold")

        // And back to hands-free.
        a.buttons["talk-menu"].tap()
        XCTAssertTrue(hold.waitForExistence(timeout: 5))
        hold.tap()
        XCTAssertTrue(eventually(state, "label == 'Listening…'", timeout: 5), "hands-free again (\(state.label))")
        endAndSettle(a, before: before)
    }
}
