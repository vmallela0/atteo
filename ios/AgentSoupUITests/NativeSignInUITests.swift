// QA for the native sign-in (email → 6-digit code → a name for new people), against a LOCAL server whose .dev.vars
// has DEV_FAKE_MAGIC=1: test addresses (@example.com) sign in with code 000000 there, and nowhere else.
// Run: TEST_RUNNER_AGENT_SOUP_SERVER=http://localhost:8836 xcodebuild test … -only-testing:AtteoUITests/NativeSignInUITests
// TEST_RUNNER_SIGNIN_SHOTS=<dir> also writes the light and dark screenshots there (ios/qa/design/signin).

import XCTest

final class NativeSignInUITests: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    var server: String { env["AGENT_SOUP_SERVER"] ?? "http://localhost:8836" }
    let run = String(Int(Date().timeIntervalSince1970 * 10) % 100_000_000, radix: 36)

    override func setUp() {
        continueAfterFailure = false
    }

    func app(theme: String) -> XCUIApplication {
        let a = XCUIApplication()
        a.launchEnvironment["AGENT_SOUP_LANG"] = "en" // English words whatever the simulator speaks (Language.swift)
        a.launchEnvironment["AGENT_SOUP_MODE"] = "developer" // today's app (Everyday.swift); Everyday tests opt in with "everyday"
        a.launchEnvironment["AGENT_SOUP_SERVER"] = server
        a.launchEnvironment["AGENT_SOUP_STILL"] = "1" // no endless animations: they keep the app from ever being idle for the test
        a.launchEnvironment["AGENT_SOUP_SIGNED_OUT"] = "1" // the sign-in screen, whatever this simulator signed in as before
        a.launchEnvironment["AGENT_SOUP_FRESH"] = "1"
        a.launchEnvironment["AGENT_SOUP_DISPLAY"] = "m,comfortable,\(theme)"
        a.launchArguments += ["-atteo_signin_email", ""] // no remembered email
        return a
    }

    func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let s = XCTAttachment(screenshot: screenshot)
        s.name = name
        s.lifetime = .keepAlways
        add(s)
        if let dir = env["SIGNIN_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    /// POST to the sign-in API directly (to make a returning person before the UI test).
    func post(_ path: String, _ body: [String: String]) -> [String: Any] {
        var r = URLRequest(url: URL(string: "\(server)/api/app/signin/\(path)")!)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "content-type")
        r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        var out: [String: Any] = [:]
        let done = expectation(description: path)
        URLSession.shared.dataTask(with: r) { data, _, _ in
            if let data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { out = j }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        return out
    }

    func enterEmail(_ a: XCUIApplication, _ email: String) {
        let field = a.textFields["signin.email"]
        XCTAssertTrue(field.waitForExistence(timeout: 15), "the email field")
        field.tap()
        field.typeText(email)
        a.buttons["signin.continue"].tap()
        XCTAssertTrue(a.staticTexts["Check your email"].waitForExistence(timeout: 10), "the code step")
    }

    func typeCode(_ a: XCUIApplication, _ code: String) {
        let field = a.textFields["signin.code"]
        XCTAssertTrue(field.waitForExistence(timeout: 5), "the code field")
        field.tap()
        field.typeText(code)
    }

    /// A new person: email, a wrong code (inline error), the right code, then a name; lands in Chats.
    func testNewPersonSignsUpInTheApp() {
        let a = app(theme: "light")
        a.launch()
        XCTAssertTrue(a.textFields["signin.email"].waitForExistence(timeout: 15))
        XCTAssertTrue(a.buttons["signin.apple"].exists, "Continue with Apple (App Review 4.8)")
        XCTAssertTrue(a.buttons["signin.web"].exists, "Google / GitHub (the browser) is still there")
        XCTAssertFalse(a.buttons["signin.continue"].isEnabled, "Continue waits for an email")
        shot("signin-email-light")

        enterEmail(a, "si-new-\(run)@example.com")
        XCTAssertTrue(a.staticTexts["signin.resendTimer"].exists, "a resend timer")
        XCTAssertTrue(a.buttons["signin.differentEmail"].exists)
        shot("signin-code-light")

        typeCode(a, "123456")
        XCTAssertTrue(a.staticTexts["signin.error"].waitForExistence(timeout: 10), "a wrong code says so inline")
        XCTAssertTrue(a.staticTexts["Check your email"].exists, "and stays on the code step")
        shot("signin-code-error-light")

        typeCode(a, "000000")
        XCTAssertTrue(a.staticTexts["Pick your name"].waitForExistence(timeout: 10), "new people pick a name")
        let name = a.textFields["signin.name"]
        XCTAssertEqual(name.value as? String, "si-new-\(run)", "suggested from the email")
        shot("signin-name-light")

        name.tap()
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 30) + "si\(run)")
        a.buttons["signin.createAccount"].tap()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 20), "signed in: Chats")
    }

    /// Someone with an account: email and code, straight to Chats (no name step). "Use a different email" goes back.
    func testReturningPersonGoesStraightIn() {
        let email = "si-back-\(run)@example.com"
        let v = post("verify", ["email": email, "code": "000000"])
        guard let ticket = v["ticket"] as? String else { return XCTFail("the local server needs DEV_FAKE_MAGIC=1: \(v)") }
        XCTAssertNotNil(post("name", ["ticket": ticket, "name": "sib\(run)"])["token"], "made the account")

        let a = app(theme: "light")
        a.launch()
        enterEmail(a, "nobody-\(run)@example.com")
        a.buttons["signin.differentEmail"].tap()
        XCTAssertTrue(a.staticTexts["Sign in or create an account"].waitForExistence(timeout: 5), "back to the email step")
        // Empty (an empty field reports its placeholder as its value).
        XCTAssertTrue(["", "you@example.com"].contains(a.textFields["signin.email"].value as? String ?? ""), "the field is ready for another address")
        enterEmail(a, email)
        typeCode(a, "000000")
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 20), "signed in: Chats")
        XCTAssertFalse(a.staticTexts["Pick your name"].exists)
    }

    /// The same screens in dark.
    func testDarkScreens() {
        let a = app(theme: "dark")
        a.launch()
        XCTAssertTrue(a.textFields["signin.email"].waitForExistence(timeout: 15))
        shot("signin-email-dark")
        enterEmail(a, "si-dark-\(run)@example.com")
        shot("signin-code-dark")
        typeCode(a, "000000")
        XCTAssertTrue(a.staticTexts["Pick your name"].waitForExistence(timeout: 10))
        shot("signin-name-dark")
    }
}
