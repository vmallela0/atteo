// QA for Settings → Voice chat → Voice (vedu #1717): picking Leo survives a relaunch and reaches display.voice on the
// server (GET /api/app/prefs as maya), which read-aloud and voice chat use. Plus the picker in English and 简体中文.
// TEST_RUNNER_VOICE_SHOTS=<dir> also writes the screenshots there. tearDown puts maya's voice back to Eve.

import XCTest

final class VoicePickerUITests: AtteoUITestCase {
    override func tearDown() {
        call("POST", "/api/app/prefs", json: ["display": ["voice": "eve"]])
        super.tearDown()
    }

    private func serverVoice() -> String? {
        ((call("GET", "/api/app/prefs")["prefs"] as? [String: Any])?["display"] as? [String: Any])?["voice"] as? String
    }

    private func save(_ name: String) {
        shot(name)
        if let dir = env["VOICE_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    /// Settings (its button and title in the app's language), scrolled down to the voice picker.
    private func openVoicePicker(_ a: XCUIApplication, settings: String = "Settings") {
        let b = a.buttons.matching(NSPredicate(format: "label == %@", settings)).firstMatch
        XCTAssertTrue(b.waitForExistence(timeout: 20), "the \(settings) button")
        b.tap()
        XCTAssertTrue(a.navigationBars[settings].waitForExistence(timeout: 5), "\(settings) opens")
        // Settings is a lazy list: the Voice chat section only exists once it's scrolled near.
        let last = a.buttons["voice-sal"]
        for _ in 0..<12 where !(last.exists && last.isHittable) { a.swipeUp(velocity: .slow) }
        XCTAssertTrue(a.otherElements["voice-picker"].exists, "the voice picker")
        XCTAssertTrue(last.isHittable, "every voice is on screen")
        for v in ["eve", "ara", "leo", "rex", "sal"] {
            XCTAssertTrue(a.buttons["voice-\(v)"].exists, "voice-\(v)")
            XCTAssertTrue(a.buttons["voice-play-\(v)"].exists, "voice-play-\(v)")
        }
    }

    func testLeoPersistsAcrossRelaunchAndReachesTheServer() throws {
        continueAfterFailure = false
        call("POST", "/api/app/prefs", json: ["display": ["voice": "eve"]])
        var a = app()
        a.launch()
        openVoicePicker(a)
        XCTAssertTrue(eventually(a.buttons["voice-eve"], "isSelected == true"), "Eve to start with")
        save("voice-picker-en")

        a.buttons["voice-leo"].tap()
        XCTAssertTrue(eventually(a.buttons["voice-leo"], "isSelected == true"), "Leo is picked")
        XCTAssertFalse(a.buttons["voice-eve"].isSelected, "and Eve isn't")
        // Saved to display.voice (the server speaks in it whenever the app names no voice), not just on this phone.
        let until = Date().addingTimeInterval(10)
        while serverVoice() != "leo" && Date() < until { Thread.sleep(forTimeInterval: 0.5) }
        XCTAssertEqual(serverVoice(), "leo", "display.voice on the server")
        save("voice-picker-en-leo")

        a.terminate()
        a = app(fresh: false)
        a.launch()
        openVoicePicker(a)
        XCTAssertTrue(eventually(a.buttons["voice-leo"], "isSelected == true"), "Leo after relaunch")
        sleep(2) // the profile refresh: still Leo once the server's prefs land
        XCTAssertTrue(a.buttons["voice-leo"].isSelected, "still Leo after the refresh")
        XCTAssertFalse(a.buttons["voice-eve"].isSelected, "not Eve")
        XCTAssertEqual(serverVoice(), "leo")
    }

    /// The picker in 简体中文: the section's words translated, the voices' names as they are.
    func testPickerInSimplifiedChinese() throws {
        continueAfterFailure = false
        let a = app(extra: ["AGENT_SOUP_LANG": "zh-Hans"])
        a.launch()
        openVoicePicker(a, settings: "设置")
        XCTAssertTrue(a.staticTexts["声音"].exists, "Voice → 声音")
        XCTAssertEqual(a.buttons["voice-play-leo"].label, "试听这个声音", "Play's label in Chinese")
        save("voice-picker-zh-hans")
    }
}
