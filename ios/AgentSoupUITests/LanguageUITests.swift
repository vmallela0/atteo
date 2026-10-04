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
}
