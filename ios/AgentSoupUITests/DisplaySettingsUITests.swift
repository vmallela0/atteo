// QA for Settings → Display (text size, density, theme): each setting changes, survives a relaunch, and reaches your
// profile on the server (so the web follows it). Plus screenshots of Chats, a board and Settings in light and dark,
// small and large text. Run like the rest (ios/qa/run.sh); TEST_RUNNER_DISPLAY_SHOTS=<dir> also writes the PNGs there.

import XCTest

final class DisplaySettingsUITests: XCTestCase {
    let env = ProcessInfo.processInfo.environment
    var server: String { env["AGENT_SOUP_SERVER"] ?? "http://localhost:8788" }

    func app(display: String? = nil, openBoard: String? = nil) -> XCUIApplication {
        let a = XCUIApplication()
        a.launchEnvironment["AGENT_SOUP_LANG"] = "en" // English words whatever the simulator speaks (Language.swift)
        a.launchEnvironment["AGENT_SOUP_MODE"] = "developer" // today's app (Everyday.swift); Everyday tests opt in with "everyday"
        a.launchEnvironment["AGENT_SOUP_SERVER"] = server
        a.launchEnvironment["AGENT_SOUP_STILL"] = "1" // no endless animations: they keep the app from ever being idle for the test
        a.launchEnvironment["AGENT_SOUP_TOKEN"] = env["AGENT_SOUP_TOKEN"] ?? ""
        if let display { a.launchEnvironment["AGENT_SOUP_DISPLAY"] = display }
        if let openBoard {
            // The app opens that board once the list loads (fresh, so it loads after launch rather than from the cache).
            a.launchEnvironment["AGENT_SOUP_OPEN_BOARD"] = openBoard
            a.launchEnvironment["AGENT_SOUP_FRESH"] = "1"
        }
        return a
    }

    func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let s = XCTAttachment(screenshot: screenshot)
        s.name = name
        s.lifetime = .keepAlways
        add(s)
        if let dir = env["DISPLAY_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    /// How light the screen is (0 black … 1 white), from a point of page background near the top-left (under the
    /// sheet's title row): tells light from dark.
    func brightness() -> CGFloat {
        let img = XCUIScreen.main.screenshot().image
        guard let cg = img.cgImage else { return -1 }
        let x = Int(CGFloat(cg.width) * 0.03), y = Int(CGFloat(cg.height) * 0.16)
        var px = [UInt8](repeating: 0, count: 4)
        let ctx = CGContext(data: &px, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: -x, y: -(cg.height - 1 - y), width: cg.width, height: cg.height))
        return (CGFloat(px[0]) + CGFloat(px[1]) + CGFloat(px[2])) / (3 * 255)
    }

    /// Your display settings as the server has them (GET /api/me/profile).
    func serverDisplay() throws -> [String: String] {
        var r = URLRequest(url: URL(string: "\(server)/api/me/profile")!)
        r.setValue("Bearer \(env["AGENT_SOUP_TOKEN"] ?? "")", forHTTPHeaderField: "authorization")
        var out: [String: String] = [:]
        let done = expectation(description: "profile")
        URLSession.shared.dataTask(with: r) { data, _, _ in
            if let data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let p = j["profile"] as? [String: Any], let d = p["display"] as? [String: Any] {
                out = d.compactMapValues { $0 as? String } // display also has true/false settings (voice_autosend, xai_ok)
            }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return out
    }

    func openSettings(_ a: XCUIApplication) {
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15), "Chats")
        a.buttons["Settings"].firstMatch.tap()
        XCTAssertTrue(a.navigationBars["Settings"].waitForExistence(timeout: 5), "Settings opens")
    }

    /// A Display segmented control, scrolled into view.
    func control(_ a: XCUIApplication, _ id: String) -> XCUIElement {
        let c = a.segmentedControls[id]
        var tries = 0
        // Settings is a lazy list: the Display section only exists once it's scrolled near. Small steps, and back up if it
        // went past (under the title bar), so a smaller phone doesn't overshoot it.
        while !(c.exists && c.isHittable) && tries < 16 {
            if c.waitForExistence(timeout: tries == 0 ? 2 : 0.5), c.isHittable { break }
            let past = c.exists && c.frame.midY < a.frame.height * 0.3
            let from = a.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: past ? 0.35 : 0.7))
            from.press(forDuration: 0.05, thenDragTo: a.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: past ? 0.7 : 0.35)))
            tries += 1
        }
        XCTAssertTrue(c.exists && c.isHittable, "\(id) is on screen")
        return c
    }

    func pick(_ a: XCUIApplication, _ id: String, _ label: String) {
        control(a, id).buttons[label].tap()
        // A new text size re-lays the whole list (and Settings scrolls the row back into view): find the control
        // again before checking it took.
        XCTAssertTrue(control(a, id).buttons[label].isSelected, "\(id) → \(label)")
    }

    func assertSelected(_ a: XCUIApplication, _ id: String, _ label: String) {
        XCTAssertTrue(control(a, id).buttons[label].isSelected, "\(id) is \(label) after relaunch")
    }

    func waitForServer(_ want: [String: String], timeout: TimeInterval = 10) throws {
        let until = Date().addingTimeInterval(timeout)
        var got: [String: String] = [:]
        repeat {
            // Only the settings this test changes: the server's display also carries mode and lang.
            got = try serverDisplay().filter { want[$0.key] != nil }
            if got == want { return }
            Thread.sleep(forTimeInterval: 0.5)
        } while Date() < until
        XCTFail("server has \(got), expected \(want)")
    }

    func testEachSettingPersistsAcrossRelaunch() throws {
        continueAfterFailure = false
        var a = app()
        a.launch()
        openSettings(a)
        shot("display-00-settings-before")
        let systemLook = brightness() // the phone's own appearance (theme: System)
        pick(a, "display-text", "L")
        pick(a, "display-density", "Compact")
        pick(a, "display-theme", "Light")
        shot("display-01-changed")
        // Saved to your profile (the web follows it), not just on this phone.
        try waitForServer(["text": "l", "density": "compact", "theme": "light"])
        a.buttons["Done"].tap()

        // Relaunch: the app comes back with what you picked.
        a.terminate()
        a = app()
        a.launch()
        openSettings(a)
        assertSelected(a, "display-text", "L")
        assertSelected(a, "display-density", "Compact")
        assertSelected(a, "display-theme", "Light")
        shot("display-02-after-relaunch")

        // Each one again, separately: small text, then dark, then comfortable.
        pick(a, "display-text", "S")
        try waitForServer(["text": "s", "density": "compact", "theme": "light"])
        pick(a, "display-theme", "Dark")
        try waitForServer(["text": "s", "density": "compact", "theme": "dark"])
        pick(a, "display-density", "Comfortable")
        try waitForServer(["text": "s", "density": "comfortable", "theme": "dark"])
        a.terminate()
        a = app()
        a.launch()
        openSettings(a)
        assertSelected(a, "display-text", "S")
        assertSelected(a, "display-density", "Comfortable")
        assertSelected(a, "display-theme", "Dark")
        shot("display-03-after-second-relaunch")

        // Back to the defaults, so other tests start from them. Dark → System hands the look back to the phone at
        // once, no relaunch (this simulator is in light mode, so the shot is light).
        pick(a, "display-text", "M")
        pick(a, "display-theme", "System")
        sleep(1)
        shot("display-04-back-to-system")
        XCTAssertEqual(brightness(), systemLook, accuracy: 0.1, "Dark → System gives the phone's appearance back without a relaunch")
        try waitForServer(["text": "m", "density": "comfortable", "theme": "system"])
        a.buttons["Done"].tap()

        // The other way: a change made on the web (the server) shows up in the app after a relaunch.
        try postDisplay(["theme": "dark", "density": "compact"])
        a.terminate()
        a = app()
        a.launch()
        openSettings(a)
        let dark = control(a, "display-theme").buttons["Dark"]
        // The cached settings show first; the profile refresh brings the web's.
        wait(for: [expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: dark)], timeout: 10)
        assertSelected(a, "display-density", "Compact")
        shot("display-05-from-the-web")
        try postDisplay(["theme": "system", "density": "comfortable"])
    }

    /// Sets display settings the way the web does (POST /api/me/profile with a partial display).
    func postDisplay(_ d: [String: String]) throws {
        var r = URLRequest(url: URL(string: "\(server)/api/me/profile")!)
        r.httpMethod = "POST"
        r.setValue("Bearer \(env["AGENT_SOUP_TOKEN"] ?? "")", forHTTPHeaderField: "authorization")
        r.setValue("application/json", forHTTPHeaderField: "content-type")
        r.httpBody = try JSONSerialization.data(withJSONObject: ["display": d])
        var status = 0
        let done = expectation(description: "post")
        URLSession.shared.dataTask(with: r) { _, resp, _ in status = (resp as? HTTPURLResponse)?.statusCode ?? 0; done.fulfill() }.resume()
        wait(for: [done], timeout: 10)
        XCTAssertEqual(status, 200, "POST display")
    }

    /// Chats, a board and Settings in light and dark, small and large text (and Chats compact), for the design review.
    /// Hindi and Korean under the design language's fonts (Onest has neither script): the system font fills in glyph
    /// by glyph, with no missing-glyph boxes. Chats, a board and Settings, light and dark; shots for a look.
    func testScriptFallbackScreenshots() throws {
        let board = (env["AGENT_SOUP_TICK"] ?? "").split(separator: ":").first.map(String.init)
        let words = ["hi": (chats: "चैट", settings: "सेटिंग"), "ko": (chats: "채팅", settings: "설정")]
        for lang in ["hi", "ko"] {
            for theme in ["light", "dark"] {
                let a = app(display: "m,comfortable,\(theme),\(lang)")
                a.launchEnvironment["AGENT_SOUP_LANG"] = lang
                a.launch()
                XCTAssertTrue(a.navigationBars[words[lang]!.chats].waitForExistence(timeout: 30), "Chats in \(lang)")
                a.buttons["tab-boards"].firstMatch.tap()
                sleep(2)
                shot("\(lang)-chats-\(theme)")
                let row = a.buttons["chat-Checkout bug"].firstMatch
                if board != nil, row.waitForExistence(timeout: 5) {
                    row.tap()
                    sleep(4)
                    shot("\(lang)-board-\(theme)")
                    a.navigationBars.buttons.element(boundBy: 0).tap()
                    sleep(1)
                }
                let settings = a.buttons.matching(NSPredicate(format: "label == %@", words[lang]!.settings)).firstMatch
                XCTAssertTrue(settings.waitForExistence(timeout: 10), "Settings in \(lang)")
                settings.tap()
                sleep(2)
                shot("\(lang)-settings-\(theme)")
                a.terminate()
            }
        }
    }

    func testDisplayScreenshots() throws {
        let board = (env["AGENT_SOUP_TICK"] ?? "").split(separator: ":").first.map(String.init)
        let combos: [(String, String)] = [("light", "s"), ("light", "l"), ("dark", "s"), ("dark", "l"), ("light", "m"), ("dark", "m")]
        for (theme, text) in combos {
            let spec = "\(text),comfortable,\(theme)"
            let a = app(display: spec)
            a.launch()
            XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 30))
            a.buttons["tab-boards"].firstMatch.tap()
            sleep(2)
            shot("chats-\(theme)-\(text)")
            openSettings(a)
            sleep(1)
            shot("settings-\(theme)-\(text)")
            a.buttons["Done"].tap()
            // The board, from the same launch (a relaunch per look made this test long enough to time out at the end
            // of a full run): tap its row, give it time to settle, and look. A query over a long chat's accessibility
            // tree can itself time out, so this just waits.
            let row = a.buttons["chat-Checkout bug"].firstMatch
            if board != nil, row.waitForExistence(timeout: 5) {
                row.tap()
                sleep(5)
                shot("board-\(theme)-\(text)")
            }
            a.terminate()
        }
        for theme in ["light", "dark"] {
            let a = app(display: "m,compact,\(theme)")
            a.launch()
            XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15))
            sleep(2)
            shot("chats-\(theme)-m-compact")
            a.terminate()
            // The sign-in screen (the mark, the wordmark and the button all flip with the theme).
            let s = app(display: "m,comfortable,\(theme)")
            s.launchEnvironment["AGENT_SOUP_SIGNED_OUT"] = "1"
            s.launch()
            sleep(2)
            shot("signin-\(theme)")
            s.terminate()
        }
        // Tasks (opened from a board) comfortable and compact. From Chats, like a person (a fresh launch straight into a
        // long chat could keep the app too busy to answer the test's queries).
        if board != nil {
            for density in ["comfortable", "compact"] {
                let b = app(display: "m,\(density),light")
                b.launch()
                let row = b.buttons["chat-Checkout bug"].firstMatch
                if b.navigationBars["Chats"].waitForExistence(timeout: 30) { b.buttons["tab-boards"].firstMatch.tap() }
                if row.waitForExistence(timeout: 10) {
                    row.tap()
                    sleep(4)
                    if b.openBoardTab("tab-tasks", timeout: 20) { sleep(2); shot("tasks-light-m-\(density)") }
                }
                b.terminate()
            }
        }
    }
}
