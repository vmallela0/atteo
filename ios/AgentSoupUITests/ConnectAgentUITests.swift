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

    private func assertBringSheet(_ a: XCUIApplication) {
        let title = a.staticTexts["bring-title"], tile = a.buttons["connect-claude"]
        XCTAssertTrue(title.waitForExistence(timeout: 5) || tile.exists, "Bring your assistant opens")
        XCTAssertTrue(tile.exists, "a provider to connect")
        XCTAssertTrue(a.buttons["connect-coding"].exists, "and the coding agent link")
    }
}
