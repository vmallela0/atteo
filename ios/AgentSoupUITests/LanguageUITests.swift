// QA for the interface language (vedu #1645): Settings → Appearance (Everyday) or → Display (Developer) → Language
// switches the app's words at once, saves display.lang to /api/app/prefs (the web follows it), and back to English.
// Every other test runs in English (the harness passes AGENT_SOUP_LANG=en and the server's lang stays auto); tearDown
// puts maya's lang back to auto even when a step here fails, so no later test sees Chinese.

import XCTest

final class LanguageUITests: AtteoUITestCase {
    override func tearDown() {
        call("POST", "/api/app/prefs", json: ["display": ["lang": "auto"]])
        super.tearDown()
    }

    private func serverLang() -> String? {
        ((call("GET", "/api/app/prefs")["prefs"] as? [String: Any])?["display"] as? [String: Any])?["lang"] as? String
    }

    /// Settings, from For you or Chats: the avatar button (its label is "Settings" in the app's language).
    private func openSettings(_ a: XCUIApplication, label: String, title: String) {
        let b = a.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
        XCTAssertTrue(b.waitForExistence(timeout: 10), "the \(label) button")
        b.tap()
        XCTAssertTrue(a.navigationBars[title].waitForExistence(timeout: 5), "\(title) opens")
    }

    /// Settings → Language (scrolled into view) → `name`.
    private func pick(_ a: XCUIApplication, _ name: String) {
        let row = a.buttons["display-lang"]
        for _ in 0..<10 where !(row.exists && row.isHittable) { a.swipeUp(velocity: .slow) }
        XCTAssertTrue(row.isHittable, "the Language row")
        row.tap()
        let choice = a.buttons.matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
        XCTAssertTrue(choice.waitForExistence(timeout: 5), name)
        shot("language-list")
        choice.tap()
    }

    /// Everyday: 简体中文 changes For you, the Chats button and Settings at once, and is saved for the web; English
    /// brings the English words back.
    func testEverydaySimplifiedChinese() throws {
        continueAfterFailure = false
        call("POST", "/api/app/prefs", json: ["display": ["lang": "auto"]])
        let a = app(extra: ["AGENT_SOUP_MODE": "everyday"])
        a.launch()
        XCTAssertTrue(a.navigationBars["For you"].waitForExistence(timeout: 20), "For you, in English")
        openSettings(a, label: "Settings", title: "Settings")
        pick(a, "简体中文")

        // Settings closes onto For you, in Chinese.
        XCTAssertTrue(a.navigationBars["为你"].waitForExistence(timeout: 10), "For you → 为你")
        XCTAssertTrue(a.buttons["open-chats"].label.contains("聊天"), "the Chats button → 聊天")
        XCTAssertTrue(a.staticTexts["greeting"].label.contains("Maya") && !a.staticTexts["greeting"].label.hasPrefix("Good"), "the greeting in Chinese")
        XCTAssertTrue(a.staticTexts.matching(NSPredicate(format: "label CONTAINS '需要你确认'")).firstMatch.exists, "Needs your OK → 需要你确认")
        shot("language-zh-hans-for-you")
        openSettings(a, label: "设置", title: "设置")
        XCTAssertTrue(a.staticTexts["外观"].exists || a.staticTexts["你的助手"].exists, "Settings' sections in Chinese")
        shot("language-zh-hans-settings")
        XCTAssertEqual(serverLang(), "zh-Hans", "saved to display.lang for the web")

        // Words built in code follow too (String(localized:)): the picker's Automatic row.
        let row = a.buttons["display-lang"]
        for _ in 0..<10 where !(row.exists && row.isHittable) { a.swipeUp(velocity: .slow) }
        row.tap()
        XCTAssertTrue(a.buttons.matching(NSPredicate(format: "label CONTAINS '自动'")).firstMatch.waitForExistence(timeout: 5), "Automatic → 自动")
        a.buttons.matching(NSPredicate(format: "label CONTAINS 'English'")).firstMatch.tap()

        XCTAssertTrue(a.navigationBars["For you"].waitForExistence(timeout: 10), "back to English")
        XCTAssertTrue(a.buttons["open-chats"].label.contains("Chats"), "Chats")
        XCTAssertEqual(serverLang(), "en")
    }

    /// Developer mode: Settings → Display → Language → 繁體中文; Chats and Settings follow, then back to English.
    func testDeveloperTraditionalChinese() throws {
        continueAfterFailure = false
        call("POST", "/api/app/prefs", json: ["display": ["lang": "auto"]])
        let a = app()
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 20), "Chats, in English")
        openSettings(a, label: "Settings", title: "Settings")
        pick(a, "繁體中文")

        XCTAssertTrue(a.navigationBars["聊天"].waitForExistence(timeout: 10), "Chats → 聊天")
        shot("language-zh-hant-chats")
        openSettings(a, label: "設定", title: "設定")
        shot("language-zh-hant-settings")
        XCTAssertEqual(serverLang(), "zh-Hant")
        pick(a, "English")
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 10), "back to English")
    }

    // Français, हिन्दी and 한국어 (vedu #1776). Each checks words that differ from English (French "Chats" is "Chats", so the
    // French passes look at For you, Settings and the New button instead).

    private func has(_ a: XCUIApplication, _ text: String) -> Bool {
        a.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch.waitForExistence(timeout: 5)
    }

    /// Everyday: `name` turns For you, the greeting, Needs your OK, Settings and the picker's Automatic row into the
    /// language, saved as `code`; English brings the English words back.
    private func everyday(_ name: String, code: String, forYou: String, chats: String?, needsOK: String, settings: String,
                          appearance: String, automatic: String, shots tag: String) {
        continueAfterFailure = false
        call("POST", "/api/app/prefs", json: ["display": ["lang": "auto"]])
        let a = app(extra: ["AGENT_SOUP_MODE": "everyday"])
        a.launch()
        XCTAssertTrue(a.navigationBars["For you"].waitForExistence(timeout: 20), "For you, in English")
        openSettings(a, label: "Settings", title: "Settings")
        pick(a, name)

        XCTAssertTrue(a.navigationBars[forYou].waitForExistence(timeout: 10), "For you → \(forYou)")
        if let chats { XCTAssertTrue(a.buttons["open-chats"].label.contains(chats), "Chats → \(chats)") }
        XCTAssertTrue(a.staticTexts["greeting"].label.contains("Maya") && !a.staticTexts["greeting"].label.hasPrefix("Good"), "the greeting translated")
        XCTAssertTrue(has(a, needsOK), "Needs your OK → \(needsOK)")
        shot("language-\(tag)-for-you")
        openSettings(a, label: settings, title: settings)
        // (Notifications, with its quiet hours, sits above Appearance now: scroll down to it, it's a lazy list.)
        let header = a.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", appearance)).firstMatch
        for _ in 0..<6 where !header.exists { a.swipeUp(velocity: .slow) }
        XCTAssertTrue(has(a, appearance), "Appearance → \(appearance)")
        shot("language-\(tag)-settings")
        XCTAssertEqual(serverLang(), code, "saved to display.lang for the web")

        let row = a.buttons["display-lang"]
        for _ in 0..<10 where !(row.exists && row.isHittable) { a.swipeUp(velocity: .slow) }
        shot("language-\(tag)-settings-lower")
        row.tap()
        XCTAssertTrue(a.buttons.matching(NSPredicate(format: "label CONTAINS %@", automatic)).firstMatch.waitForExistence(timeout: 5), "Automatic → \(automatic)")
        a.buttons.matching(NSPredicate(format: "label CONTAINS 'English'")).firstMatch.tap()
        XCTAssertTrue(a.navigationBars["For you"].waitForExistence(timeout: 10), "back to English")
        XCTAssertEqual(serverLang(), "en")
    }

    /// Developer mode: `name` from Settings → Display; the Chats screen and Settings follow, then back to English.
    private func developer(_ name: String, code: String, chats: String, new: String, settings: String, display: String, shots tag: String) {
        continueAfterFailure = false
        call("POST", "/api/app/prefs", json: ["display": ["lang": "auto"]])
        let a = app()
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 20), "Chats, in English")
        openSettings(a, label: "Settings", title: "Settings")
        pick(a, name)

        XCTAssertTrue(a.buttons.matching(NSPredicate(format: "label == %@", settings)).firstMatch.waitForExistence(timeout: 10), "Settings → \(settings)")
        XCTAssertTrue(a.navigationBars[chats].exists, "Chats → \(chats)")
        XCTAssertTrue(a.buttons.matching(NSPredicate(format: "label == %@", new)).firstMatch.exists, "New → \(new)")
        // The Boards / DMs switch stays one line (French « Messages directs » once broke over three).
        let dms = a.buttons["tab-direct"]
        XCTAssertTrue(dms.waitForExistence(timeout: 5), "the DMs tab")
        XCTAssertLessThan(dms.frame.height, 40, "DMs on one line")
        XCTAssertTrue(a.buttons["people-first"].exists, "People first is still there")
        shot("language-\(tag)-chats")
        openSettings(a, label: settings, title: settings)
        shot("language-\(tag)-dev-settings")
        // Display is below the fold: scroll to the Language row (in it). Its header sits five rows above it (Text
        // size, Density, Theme, Replies), which longer words in Hindi or Korean push off the top: nudge back down
        // until the header is on screen.
        let row = a.buttons["display-lang"]
        for _ in 0..<10 where !(row.exists && row.isHittable) { a.swipeUp(velocity: .slow) }
        let header = a.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", display)).firstMatch
        for _ in 0..<4 where !(header.exists && header.isHittable) {
            a.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35)).press(forDuration: 0.05, thenDragTo: a.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)))
        }
        XCTAssertTrue(has(a, display), "Display → \(display)")
        shot("language-\(tag)-dev-settings-display")
        XCTAssertEqual(serverLang(), code)
        pick(a, "English")
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 10), "back to English")
    }

    func testEverydayFrench() throws {
        everyday("Français", code: "fr", forYou: "Pour vous", chats: nil, needsOK: "Attend votre accord", settings: "Paramètres",
                 appearance: "Apparence", automatic: "Automatique", shots: "fr")
    }

    func testEverydayHindi() throws {
        everyday("हिन्दी", code: "hi", forYou: "आपके लिए", chats: "चैट", needsOK: "आपकी मंज़ूरी चाहिए", settings: "सेटिंग",
                 appearance: "दिखावट", automatic: "अपने आप", shots: "hi")
    }

    func testDeveloperFrench() throws {
        developer("Français", code: "fr", chats: "Chats", new: "Nouveau", settings: "Paramètres", display: "Affichage", shots: "fr")
    }

    func testDeveloperHindi() throws {
        developer("हिन्दी", code: "hi", chats: "चैट", new: "नया", settings: "सेटिंग", display: "डिस्प्ले", shots: "hi")
    }

    /// Hindi's longer words in the tight places (vedu #1776): a chat's header and tabs (Everyday and Developer), and
    /// Everyday's Work screen, whose segmented control is 168 pt for करने के काम / फ़ाइलें. Shots for a look; the test
    /// checks the screens open in Hindi.
    func testHindiTightPlaces() throws {
        continueAfterFailure = false
        for mode in ["everyday", "developer"] {
            call("POST", "/api/app/prefs", json: ["display": ["lang": "hi"]])
            let a = app(extra: ["AGENT_SOUP_MODE": mode])
            a.launch()
            if mode == "everyday" {
                XCTAssertTrue(a.navigationBars["आपके लिए"].waitForExistence(timeout: 20), "For you in Hindi")
                a.buttons["open-chats"].tap()
            }
            XCTAssertTrue(a.navigationBars["चैट"].waitForExistence(timeout: 15), "Chats in Hindi")
            let tab = a.buttons["tab-boards"]
            if tab.waitForExistence(timeout: 10) { tab.tap() }
            let row = a.buttons["chat-Checkout bug"].firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 10), "Checkout bug")
            row.tap()
            XCTAssertTrue(composer(a).waitForExistence(timeout: 10), "the chat opens")
            sleep(1)
            shot("language-hi-\(mode)-chat")
            if mode == "everyday" {
                a.buttons["tab-todos"].tap()
                XCTAssertTrue(a.segmentedControls["work-pane"].waitForExistence(timeout: 5), "the Work screen")
                sleep(1)
                shot("language-hi-everyday-work")
            }
            a.terminate()
        }
    }

    func testDeveloperKorean() throws {
        developer("한국어", code: "ko", chats: "채팅", new: "새로 만들기", settings: "설정", display: "화면", shots: "ko")
    }
}
