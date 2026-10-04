// Connect your agent, in Developer mode (board #2241, "where is the connect your agent button on mobile"): Settings
// has it at the top, and Your agents has it first; both open Bring your assistant.

import XCTest

final class ConnectAgentUITests: AtteoUITestCase {
    /// Settings: "Connect your agent" right under the pictures, on screen without scrolling, saying whether one is
    /// connected; it opens the connect sheet.
    func testSettingsConnectAgent() throws {
        continueAfterFailure = false
        let a = app()
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15), "Chats")
        a.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(a.navigationBars["Settings"].waitForExistence(timeout: 5), "Settings")
        let row = a.buttons["connect-agent"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Connect your agent")
        XCTAssertTrue(row.isHittable, "on screen without scrolling")
        XCTAssertLessThan(row.frame.minY, a.textFields["display-name"].frame.minY, "above everything but the pictures")
        XCTAssertTrue(row.label.contains("Connect your agent"), row.label)
        XCTAssertTrue(row.label.contains("Not connected yet") || row.label.contains("Connected ·"), "its state: \(row.label)")
        shot("connect-agent-settings")
        row.tap()
        assertBringSheet(a)
        shot("connect-agent-settings-sheet")
        a.buttons["bring-done"].tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5), "back on Settings")
    }

    /// Your agents: "Connect an agent" first, opening the same sheet.
    func testYourAgentsConnect() throws {
        continueAfterFailure = false
        let a = app()
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15), "Chats")
        a.buttons["Your agents"].firstMatch.tap()
        XCTAssertTrue(a.navigationBars["Your agents"].waitForExistence(timeout: 5), "Your agents")
        let connect = a.buttons["agents-connect"]
        XCTAssertTrue(connect.waitForExistence(timeout: 5), "Connect an agent")
        XCTAssertTrue(connect.isHittable, "on screen without scrolling")
        shot("connect-agent-your-agents")
        connect.tap()
        assertBringSheet(a)
        shot("connect-agent-your-agents-sheet")
        a.buttons["bring-done"].tap()
        XCTAssertTrue(connect.waitForExistence(timeout: 5), "back on Your agents")
    }

    /// Grok's and Muse's Copy & open (vedu #2298): copies, then opens the provider's app if it's installed, else its
    /// website. The simulator has neither app, so Safari comes up; back in Atteo, "Copied." is showing.
    func testCopyAndOpenGoesToTheProvider() throws {
        continueAfterFailure = false
        let a = app()
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15), "Chats")
        a.buttons["Settings"].firstMatch.tap()
        let row = a.buttons["connect-agent"]
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Connect your agent")
        row.tap()
        assertBringSheet(a)
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        for (id, name) in [("grok", "Grok"), ("muse", "Muse")] {
            a.buttons["connect-\(id)"].tap()
            let bar = a.navigationBars["Connect \(name)"]
            XCTAssertTrue(bar.waitForExistence(timeout: 5), "\(name)'s steps")
            let open = a.buttons["connect-open"]
            XCTAssertTrue(open.waitForExistence(timeout: 5), "\(name)'s Copy & open")
            shot("connect-open-\(id)")
            open.tap()
            XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 15), "no \(name) app here: its website, in Safari")
            a.activate()
            XCTAssertTrue(a.wait(for: .runningForeground, timeout: 10), "back in Atteo")
            XCTAssertTrue(a.staticTexts["connect-copied"].waitForExistence(timeout: 5), "\(name): Copied.")
            bar.buttons["Done"].tap()
            XCTAssertTrue(a.buttons["connect-grok"].waitForExistence(timeout: 5), "back on Bring your assistant")
        }
    }

    private func assertBringSheet(_ a: XCUIApplication) {
        let title = a.staticTexts["bring-title"], tile = a.buttons["connect-claude"]
        XCTAssertTrue(title.waitForExistence(timeout: 5) || tile.exists, "Bring your assistant opens")
        XCTAssertTrue(tile.exists, "a provider to connect")
        XCTAssertTrue(a.buttons["connect-coding"].exists, "and the coding agent link")
    }
}
