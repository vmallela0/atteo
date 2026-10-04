// QA for board pictures: the picture in Chats (a rounded square where the initial was) and large in the board's Info,
// changed from Photos and removed there (the list follows at once), a DM showing the other person's own picture, and
// an encrypted board saying the picture is visible to the server. Same harness as AgentSoupUITests: a local server
// seeded by ios/qa/seed.mjs ("Checkout bug" has a picture, priya has an avatar), run by ios/qa/run.sh. The board's
// picture is put back at the end.

import UIKit
import XCTest

final class BoardPictureUITests: XCTestCase {
    let env = ProcessInfo.processInfo.environment

    func app() -> XCUIApplication {
        let a = XCUIApplication()
        a.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"] // English words (Language.swift); LanguageUITests switches
        a.launchEnvironment["AGENT_SOUP_MODE"] = "developer" // today's app (Everyday.swift); Everyday tests opt in with "everyday"
        a.launchEnvironment["AGENT_SOUP_SERVER"] = env["AGENT_SOUP_SERVER"] ?? "http://localhost:8788"
        a.launchEnvironment["AGENT_SOUP_STILL"] = "1" // no endless animations: they keep the app from ever being idle for the test
        a.launchEnvironment["AGENT_SOUP_TOKEN"] = env["AGENT_SOUP_TOKEN"] ?? ""
        a.launchEnvironment["AGENT_SOUP_FRESH"] = "1"
        return a
    }

    func shot(_ name: String) {
        let s = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        s.name = name
        s.lifetime = .keepAlways
        add(s)
    }

    /// A call to the local server as maya's app, waited for: JSON (`body`) or raw bytes (`data`).
    @discardableResult
    func call(_ method: String, _ path: String, data: Data? = nil, contentType: String? = nil) -> [String: Any] {
        guard let server = env["AGENT_SOUP_SERVER"], let token = env["AGENT_SOUP_TOKEN"], let url = URL(string: server + path) else { return [:] }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        if let data { r.httpBody = data; r.setValue(contentType ?? "application/octet-stream", forHTTPHeaderField: "content-type") }
        var out: [String: Any] = [:]
        let done = expectation(description: "\(method) \(path)")
        URLSession.shared.dataTask(with: r) { d, _, _ in
            out = (d.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        return out
    }

    /// The seeded board with a picture: "Checkout bug" (the newest one that isn't archived).
    func checkout() -> [String: Any]? {
        let boards = call("GET", "/api/me/boards")["boards"] as? [[String: Any]] ?? []
        return boards.filter { $0["title"] as? String == "Checkout bug" && $0["archived"] as? Bool != true }
            .max { ($0["last_activity"] as? Double ?? 0) < ($1["last_activity"] as? Double ?? 0) }
    }

    /// A 256-px square picture (what the app uploads), in one colour with a pale disc.
    func squarePicture(_ color: UIColor) -> Data {
        let f = UIGraphicsImageRendererFormat(); f.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: 256, height: 256), format: f).image { c in
            color.setFill(); c.fill(CGRect(x: 0, y: 0, width: 256, height: 256))
            UIColor.white.withAlphaComponent(0.55).setFill(); c.cgContext.fillEllipse(in: CGRect(x: 64, y: 64, width: 128, height: 128))
        }.jpegData(compressionQuality: 0.85)!
    }

    /// Puts a picture on the board (the seed's, or back after the test removed it).
    @discardableResult
    func setPicture(_ id: String) -> String? {
        call("POST", "/api/boards/\(id)/picture", data: squarePicture(UIColor(red: 0.84, green: 0.47, blue: 0.34, alpha: 1)), contentType: "image/jpeg")["picture"] as? String
    }

    /// Waits until an element's accessibility value is `value`.
    func waitValue(_ e: XCUIElement, _ value: String, _ why: String, timeout: TimeInterval = 10) {
        let p = expectation(for: NSPredicate(format: "value == %@", value), evaluatedWith: e)
        XCTAssertEqual(XCTWaiter().wait(for: [p], timeout: timeout), .completed, "\(why) (value: \(e.exists ? String(describing: e.value) : "missing"))")
    }

    /// Waits until the server's picture for the board satisfies `ok`.
    func waitServer(_ why: String, _ ok: @escaping (String?) -> Bool) {
        for _ in 0..<20 {
            if ok(checkout()?["picture"] as? String) { return }
            sleep(1)
        }
        XCTFail(why)
    }

    /// Picks the newest photo in the Photos picker. The picker runs out of process (its own extension), so it's
    /// Picks a photo in the Photos picker. The picker runs out of process and none of it is in the accessibility tree
    /// (iOS 26), so it's tapped by position: the first column, a little under the top of the grid. With the "Private
    /// Access to Photos" note showing that's the newest photo; without it, the one below. Either is a photo.
    func pickPhoto(_ a: XCUIApplication) {
        sleep(3) // the sheet slides up and the grid loads
        shot("03a-photos-picker")
        a.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 66, dy: 398)).tap()
    }

    func testBoardPicture() throws {
        continueAfterFailure = false
        guard let board = checkout(), let id = board["id"] as? String else { throw XCTSkip("needs the seeded Checkout bug board") }
        if board["picture"] as? String == nil { XCTAssertNotNil(setPicture(id), "seeds the picture") }
        defer { if checkout()?["picture"] as? String == nil { setPicture(id) } } // leave the board as we found it

        let a = app()
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 10))
        let tab = a.buttons["tab-boards"]
        if tab.waitForExistence(timeout: 5) { tab.tap() }

        // 1. Chats: the board's picture (loaded with the app's token) where its initial was; others keep the initial.
        let row = a.buttons["chat-Checkout bug"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        waitValue(row, "picture", "Checkout bug's row shows its picture")
        let plain = a.buttons["chat-Secret plans"].firstMatch
        if plain.waitForExistence(timeout: 3) { waitValue(plain, "initial", "a board without a picture keeps its initial", timeout: 3) }
        shot("01-chats-picture")

        // 2. Info: the picture, large, with Change picture and Remove picture.
        row.tap()
        let presence = a.buttons["presence"]
        XCTAssertTrue(presence.waitForExistence(timeout: 10))
        shot("02a-chat-header")
        presence.tap()
        XCTAssertTrue(a.navigationBars["Info"].waitForExistence(timeout: 5))
        let pic = a.descendants(matching: .any)["board-picture"].firstMatch
        XCTAssertTrue(pic.waitForExistence(timeout: 5))
        waitValue(pic, "picture", "Info shows the board's picture")
        let change = a.buttons["board-picture-change"]
        XCTAssertTrue(change.waitForExistence(timeout: 5), "a member who can post can change it")
        XCTAssertTrue(a.buttons["board-picture-remove"].exists, "…and remove it")
        XCTAssertFalse(a.staticTexts["board-picture-caption"].exists, "the server-visibility note is for encrypted boards")
        shot("02-info-picture")

        // 3. Change it from Photos: the new picture shows, and the server has a new version.
        let before = checkout()?["picture"] as? String
        change.tap()
        pickPhoto(a)
        let save = a.buttons["crop-save"] // the crop sheet comes up after picking (#1001)
        XCTAssertTrue(save.waitForExistence(timeout: 10), "the crop sheet opens")
        save.tap()
        waitServer("the server has the new picture") { $0 != nil && $0 != before }
        waitValue(pic, "picture", "Info shows the new picture")
        XCTAssertFalse(a.staticTexts["board-picture-error"].exists, "no error")
        shot("03-info-changed")

        // 4. Remove it (asks first): the initial comes back here and in the list, at once.
        a.buttons["board-picture-remove"].tap()
        let sure = a.buttons.matching(NSPredicate(format: "label == 'Remove picture' AND identifier != 'board-picture-remove'")).firstMatch
        XCTAssertTrue(sure.waitForExistence(timeout: 3), "asks first")
        shot("04-remove-confirm")
        sure.tap()
        waitValue(pic, "initial", "Info shows the initial again")
        XCTAssertFalse(a.buttons["board-picture-remove"].waitForExistence(timeout: 1), "nothing left to remove")
        waitServer("the server removed it") { $0 == nil }
        shot("05-info-removed")
        a.navigationBars["Info"].buttons["Done"].tap()
        a.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 5))
        waitValue(row, "initial", "the list shows the initial again")
        shot("06-chats-removed")

        // 5. Put it back from the server: the list picks up the new version on the next refresh.
        XCTAssertNotNil(setPicture(id))
        // Pull to refresh (a slow drag from the top of the list; a fast swipe only scrolls).
        a.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).press(forDuration: 0.1, thenDragTo: a.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)))
        waitValue(row, "picture", "the list shows a picture set elsewhere", timeout: 15)

        // 6. A DM shows the other person's own picture, and has no board picture to change.
        a.buttons["tab-direct"].tap()
        let dm = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'chat-' AND identifier CONTAINS 'priya'")).firstMatch
        XCTAssertTrue(dm.waitForExistence(timeout: 5), "the DM with priya")
        waitValue(dm, "person", "a DM's row shows the person")
        shot("07-dm-row")
        dm.tap()
        XCTAssertTrue(presence.waitForExistence(timeout: 10))
        presence.tap()
        XCTAssertTrue(pic.waitForExistence(timeout: 5))
        waitValue(pic, "person", "a DM's Info shows the person")
        XCTAssertFalse(a.buttons["board-picture-change"].waitForExistence(timeout: 2), "a DM has no picture of its own to change")
        shot("08-dm-info")
        a.navigationBars["Info"].buttons["Done"].tap()
        a.navigationBars.buttons.element(boundBy: 0).tap()
        a.buttons["tab-boards"].tap()
    }

    func testEncryptedBoardSaysThePictureIsVisible() throws {
        continueAfterFailure = false
        let a = app()
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 10))
        let tab = a.buttons["tab-boards"]
        if tab.waitForExistence(timeout: 5) { tab.tap() }
        let row = a.buttons["chat-Secret plans"].firstMatch
        guard row.waitForExistence(timeout: 10) else { throw XCTSkip("needs the seeded encrypted board") }
        row.tap()
        let presence = a.buttons["presence"]
        XCTAssertTrue(presence.waitForExistence(timeout: 10))
        presence.tap()
        XCTAssertTrue(a.buttons["board-picture-change"].waitForExistence(timeout: 5), "an encrypted board can have a picture")
        XCTAssertTrue(a.staticTexts["Visible to the server, like the board name."].exists, "it says the server can see it")
        shot("09-encrypted-info")
        a.navigationBars["Info"].buttons["Done"].tap()
        a.navigationBars.buttons.element(boundBy: 0).tap()
    }
}
