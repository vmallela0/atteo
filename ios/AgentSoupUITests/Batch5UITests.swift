// Batch 5 (one focused test each): Settings' Haptics & effects, Voice, Notifications and your agent's name; a named
// agent in the chat with @Jarvis / @all in the @ menu, your favourite reactions and the emoji search, Remember this;
// the board's MEMORY in its info (and no SOUL: vedu #5266); Read replies aloud without a bar (vedu #4564); and the picture editor.

import XCTest

final class Batch5UITests: AtteoUITestCase {
    var mayaAgent: String { env["AGENT_SOUP_MAYA_AGENT"] ?? "" }

    private func profile() -> [String: Any] { call("GET", "/api/me/profile")["profile"] as? [String: Any] ?? [:] }

    /// Scrolls the list until `e` is on screen (or gives up).
    private func reveal(_ a: XCUIApplication, _ e: XCUIElement, up: Bool = true) {
        for _ in 0..<8 where !(e.exists && e.isHittable) { up ? a.swipeUp(velocity: .slow) : a.swipeDown(velocity: .slow) }
    }

    private func openSettings(_ a: XCUIApplication) {
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15))
        a.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(a.navigationBars["Settings"].waitForExistence(timeout: 5))
    }

    func testSettingsFeelVoiceAndAgentName() throws {
        call("POST", "/api/me/profile", json: ["agent_name": NSNull(), "reactions": ["👍", "🎉"]])
        defer { call("POST", "/api/me/profile", json: ["agent_name": NSNull(), "reactions": NSNull()]) }
        let a = app()
        a.launch()
        openSettings(a)

        // Your agent's name: the server's reason when it won't take one, saved when it does.
        let name = a.textFields["agent-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap()
        name.typeText("agents\n")
        let problem = a.staticTexts["agent-name-error"]
        XCTAssertTrue(problem.waitForExistence(timeout: 8), "a reserved name says why")
        XCTAssertTrue(problem.label.contains("reserved"), problem.label)
        shot("b5-01-agent-name-rejected")
        name.tap()
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8) + "Jarvis\n")
        XCTAssertTrue(eventually(problem, "exists == false"), "the error goes")
        for _ in 0..<20 where profile()["agent_name"] as? String != "Jarvis" { sleep(1) }
        XCTAssertEqual(profile()["agent_name"] as? String, "Jarvis")

        // Haptics & effects, Voice, Notifications.
        let haptics = a.switches["haptics-toggle"]
        reveal(a, haptics)
        XCTAssertTrue(haptics.exists, "Haptics")
        XCTAssertTrue(a.switches["effects-toggle"].exists, "Effects")
        XCTAssertTrue(a.descendants(matching: .any)["notifications-row"].exists, "Notifications")
        XCTAssertEqual(haptics.value as? String, "1", "on by default")
        haptics.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertTrue(eventually(haptics, "value == '0'"), "switches off")
        haptics.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        XCTAssertTrue(eventually(haptics, "value == '1'"), "and on again")
        let aloud = a.switches["read-aloud-toggle"]
        reveal(a, aloud)
        XCTAssertTrue(aloud.exists, "Read replies aloud")
        shot("b5-02-settings-feel-voice")

        // Favourite reactions: add one from the searchable picker; it's saved to the account.
        let favs = a.buttons["favourite-reactions"]
        reveal(a, favs, up: false)
        favs.tap()
        XCTAssertTrue(a.navigationBars["Reactions"].waitForExistence(timeout: 5))
        let add = a.buttons["favourite-add"]
        XCTAssertTrue(add.waitForExistence(timeout: 5), "room for more (the test starts with two)")
        add.tap()
        let search = a.textFields["emoji-search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("unicorn")
        let unicorn = a.buttons["emoji-🦄"]
        XCTAssertTrue(unicorn.waitForExistence(timeout: 5), "search finds it by name")
        unicorn.tap()
        XCTAssertTrue(a.descendants(matching: .any)["favourite-🦄"].waitForExistence(timeout: 5))
        for _ in 0..<20 where !((profile()["reactions"] as? [String]) ?? []).contains("🦄") { sleep(1) }
        XCTAssertTrue(((profile()["reactions"] as? [String]) ?? []).contains("🦄"), "saved to the account")
        shot("b5-03-favourite-reactions")
    }

    func testNamedAgentMentionsReactionsAndRemember() throws {
        guard let b = boardId(titled: "Checkout bug"), !mayaAgent.isEmpty else { throw XCTSkip("needs the seed") }
        call("POST", "/api/me/profile", json: ["agent_name": "Jarvis", "reactions": ["🦄", "👍", "🎉"]])
        defer { call("POST", "/api/me/profile", json: ["agent_name": NSNull(), "reactions": NSNull()]) }
        let posted = call("POST", "/api/boards/\(b)/entries", json: ["type": "note", "text": "Batch five check: the guard is in."], token: mayaAgent)
        let seq = (posted["entry"] as? [String: Any])?["seq"] as? Int ?? 0
        XCTAssertGreaterThan(seq, 0, "maya's agent posted")

        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        // Its post shows its name with its owner.
        XCTAssertTrue(a.staticTexts["Jarvis · maya's agent"].firstMatch.waitForExistence(timeout: 10), "Jarvis · maya's agent")
        XCTAssertTrue(a.descendants(matching: .any)["mic"].exists, "the mic is in the message box")
        shot("b5-04-named-agent")

        // The @ menu: @Jarvis, and @all.
        let box = composer(a)
        box.tap()
        box.typeText("@Jar")
        XCTAssertTrue(a.buttons["mention-Jarvis"].waitForExistence(timeout: 5), "@Jarvis")
        shot("b5-05-at-jarvis")
        box.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 3) + "al")
        XCTAssertTrue(a.buttons["mention-all"].waitForExistence(timeout: 5), "@all")
        box.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 3))
        a.swipeDown(velocity: .slow) // the keyboard goes

        // Hold the message: your favourites on top, + for any emoji, and Remember this.
        let msg = a.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Batch five check'")).firstMatch
        XCTAssertTrue(msg.waitForExistence(timeout: 5))
        msg.press(forDuration: 0.8)
        XCTAssertTrue(a.buttons["🦄"].waitForExistence(timeout: 3), "your favourites")
        XCTAssertTrue(a.buttons["Any emoji"].exists, "+ for every other emoji")
        shot("b5-06-favourites-row")
        a.buttons["Remember this"].tap()
        XCTAssertTrue(a.descendants(matching: .any)["toast"].waitForExistence(timeout: 5), "says it was remembered")
        let items = call("GET", "/api/boards/\(b)/memory")["items"] as? [[String: Any]] ?? []
        let item = items.first { $0["from"] as? Int == seq }
        XCTAssertNotNil(item, "the board remembers it")
        if let id = item?["id"] as? Int { call("DELETE", "/api/boards/\(b)/memory/\(id)") }

        // Any emoji: + opens the picker, which searches by name.
        sleep(2)
        msg.press(forDuration: 0.8)
        XCTAssertTrue(a.buttons["Any emoji"].waitForExistence(timeout: 3))
        a.buttons["Any emoji"].tap()
        let search = a.textFields["emoji-search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("rocket")
        XCTAssertTrue(a.buttons["emoji-🚀"].waitForExistence(timeout: 5))
        a.buttons["emoji-🚀"].tap()
        XCTAssertTrue(a.buttons["reaction-🚀"].waitForExistence(timeout: 5), "🚀 on the message")
    }

    func testMemoryInInfo() throws {
        guard let b = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seed") }
        let added = call("POST", "/api/boards/\(b)/memory", json: ["text": "Staging uses port 8443"])
        guard let id = (added["item"] as? [String: Any])?["id"] as? Int else { return XCTFail("memory: \(added)") }

        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        a.buttons["presence"].tap()
        XCTAssertTrue(a.navigationBars["Info"].waitForExistence(timeout: 5))
        let item = a.descendants(matching: .any)["memory-item-\(id)"]
        XCTAssertTrue(item.waitForExistence(timeout: 8), "the memory item")
        XCTAssertFalse(a.staticTexts["Soul"].exists, "no Soul section (vedu #5266)")
        shot("b5-07-memory")

        // Strike it: gone here and on the server.
        a.buttons["memory-strike-\(id)"].tap()
        XCTAssertTrue(eventually(item, "exists == false"), "struck")
        let left = call("GET", "/api/boards/\(b)/memory")["items"] as? [[String: Any]] ?? []
        XCTAssertFalse(left.contains { $0["id"] as? Int == id }, "the server struck it")
    }

    func testReadRepliesAloudWithoutBar() throws {
        guard !otherApp.isEmpty, let b = boardId(titled: "Checkout bug") else { throw XCTSkip("needs theo's phone token") }
        let a = app()
        a.launchArguments += ["-read-aloud", "YES"] // the per-device switch, for this run only
        a.launch()
        openChat(a, "Checkout bug")
        sleep(2)
        let text = "can you look at the retry budget? \(UUID().uuidString)"
        call("POST", "/api/boards/\(b)/entries", json: ["type": "note", "text": "@maya \(text)"], token: otherApp)
        let msg = a.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        XCTAssertTrue(msg.waitForExistence(timeout: 15), "a new message for you arrives")
        XCTAssertFalse(a.descendants(matching: .any)["read-aloud-bar"].exists, "reading needs no bar (vedu #4564)")
        XCTAssertTrue(composer(a).isHittable, "the message box stays available")
        shot("b5-09-read-aloud")
    }

    func testPictureEditor() throws {
        let a = app()
        a.launch()
        openSettings(a)
        a.buttons["Change your picture"].tap()
        sleep(3) // the Photos sheet slides up and its grid loads (out of process: tapped by position)
        a.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 66, dy: 398)).tap()
        let save = a.buttons["crop-save"]
        XCTAssertTrue(save.waitForExistence(timeout: 10), "the editor opens on the picked photo")
        a.sliders["crop-zoom"].adjust(toNormalizedSliderPosition: 0.4)
        a.buttons["crop-rotate"].tap()
        a.sliders["crop-light"].adjust(toNormalizedSliderPosition: 0.7)
        shot("b5-10-picture-editor")
        save.tap()
        XCTAssertTrue(eventually(save, "exists == false"), "saved and closed")
        XCTAssertTrue(a.navigationBars["Settings"].exists)
    }
}
