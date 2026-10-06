// Notification volume (vedu #2490): a chat's Info sets how much it may interrupt you (Everything, Needs me or Off), the
// chat's menu does too, and Settings → Notifications has quiet hours. Each saves to the account.

import XCTest

final class NotifyLevelsUITests: AtteoUITestCase {
    private func level(_ id: String) -> String { call("GET", "/api/boards/\(id)/notify")["level"] as? String ?? "" }
    private func waitLevel(_ id: String, _ want: String) -> Bool {
        for _ in 0..<20 { if level(id) == want { return true }; usleep(300_000) }
        return false
    }

    func testLevelFromInfoAndTheChatMenu() {
        guard let id = boardId(titled: "Checkout bug") else { return XCTFail("the seeded board") }
        call("PUT", "/api/boards/\(id)/notify", json: ["level": "needs_me"])
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")

        // Info: Needs me by default; Off saves.
        let presence = a.buttons["presence"]
        XCTAssertTrue(presence.waitForExistence(timeout: 5))
        presence.tap()
        XCTAssertTrue(a.navigationBars["Info"].waitForExistence(timeout: 5))
        let seg = a.segmentedControls["notify-level"]
        for _ in 0..<8 where !(seg.exists && seg.isHittable) { a.swipeUp(); usleep(400_000) }
        XCTAssertTrue(seg.waitForExistence(timeout: 5), "Info has Notifications")
        XCTAssertTrue(eventually(seg.buttons["Needs me"], "isSelected == true"), "Needs me is the default")
        seg.buttons["Off"].tap()
        XCTAssertTrue(waitLevel(id, "off"), "Off saved")
        XCTAssertTrue(a.staticTexts["notify-level-hint"].label.contains("Inbox"), "Off's hint")
        shot("notify-info-off")
        a.navigationBars["Info"].swipeDown(velocity: .fast)

        // The rail sheet (#4860): Notifications → Everything.
        a.openRail()
        let segs = a.segmentedControls["notify-level-segments"].firstMatch
        XCTAssertTrue(segs.waitForExistence(timeout: 5), "the rail has Notifications")
        XCTAssertTrue(eventually(segs.buttons["Off"], "isSelected == true"), "the rail shows the level saved in Info")
        segs.buttons["Everything"].tap()
        XCTAssertTrue(waitLevel(id, "everything"), "Everything saved from the rail")
        call("PUT", "/api/boards/\(id)/notify", json: ["level": "needs_me"])
    }

    func testQuietHoursInSettings() {
        call("PUT", "/api/me/notify", json: ["quiet": ["on": false]])
        let a = app()
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15))
        a.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(a.navigationBars["Settings"].waitForExistence(timeout: 5))
        let quiet = a.switches["quiet-hours"]
        for _ in 0..<10 where !(quiet.exists && quiet.isHittable) { a.swipeUp(); usleep(400_000) }
        XCTAssertTrue(quiet.waitForExistence(timeout: 5), "Settings → Notifications has quiet hours")
        XCTAssertTrue(a.staticTexts["digest-times"].label.contains("13:00"), "the digest times")
        if quiet.switches.firstMatch.exists { quiet.switches.firstMatch.tap() } else { quiet.tap() }
        XCTAssertTrue(a.datePickers["quiet-start"].waitForExistence(timeout: 5), "start and end appear")
        var on = false
        for _ in 0..<20 where !on { on = ((call("GET", "/api/me/notify")["quiet"] as? [String: Any])?["on"] as? Bool) == true; if !on { usleep(300_000) } }
        XCTAssertTrue(on, "quiet hours saved")
        let tz = (call("GET", "/api/me/notify")["quiet"] as? [String: Any])?["tz"] as? String
        XCTAssertEqual(tz, TimeZone.current.identifier, "in the phone's zone")
        shot("notify-quiet-hours")
        call("PUT", "/api/me/notify", json: ["quiet": ["on": false]])
    }
}
