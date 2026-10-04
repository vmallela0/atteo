// Batch 6: a message's blocks (code with Copy, a table, a chart and its Data, a diagram's code, a status card), and
// managing a chat from the Chats list (rename and archive from its row, then restore it from Archived).

import XCTest

final class Batch6UITests: AtteoUITestCase {
    var mayaAgent: String { env["AGENT_SOUP_MAYA_AGENT"] ?? "" }

    /// A fresh board of maya's (not encrypted, so the API can post into it in plain text), by id.
    private func newBoard(_ title: String) -> String? {
        (call("POST", "/api/boards", json: ["title": title, "encrypted": false])["board"] as? [String: Any])?["id"] as? String
    }

    func testMessageBlocksRender() throws {
        guard !mayaAgent.isEmpty else { throw XCTSkip("needs the seed (MAYA_AGENT)") }
        let n = Int(Date().timeIntervalSince1970) % 100000
        let title = "Checkout bug"
        guard let b = boardId(titled: title) else { throw XCTSkip("needs the seed") }
        let text = """
        Latency after the cache change, @maya:

        ```swift
        let p95 = samples.sorted()[Int(Double(samples.count) * 0.95)]
        print("p95", p95)
        ```

        | Region | p50 | p95 |
        |:--|--:|--:|
        | us-east | 41 | 120 |
        | eu-west | 48 | 133 |

        ```chart
        {"type":"bar","title":"p95 by day","x":["Mon","Tue","Wed"],"series":[{"name":"before","values":[180,175,190]},{"name":"after","values":[120,118,125]}],"unit":"ms"}
        ```

        ```mermaid
        graph TD; cache-->db
        ```

        ```status
        api      ok    41ms
        worker   warn  2 retries
        ```

        That's all for today \(n).
        """
        let posted = call("POST", "/api/boards/\(b)/entries", json: ["type": "note", "text": text], token: mayaAgent)
        XCTAssertTrue((200..<300).contains(posted["_status"] as? Int ?? 0), "posted: \(posted)")

        let a = app()
        a.launch()
        openChat(a, title)
        let any = a.descendants(matching: .any)
        // The words around the blocks are still text (with the mention), the code has its header and Copy.
        XCTAssertTrue(a.staticTexts["That's all for today \(n)."].waitForExistence(timeout: 10), "the words after the blocks")
        XCTAssertTrue(any["code-block"].firstMatch.waitForExistence(timeout: 5), "the code block")
        XCTAssertTrue(a.buttons["code-copy"].firstMatch.exists, "with Copy")
        XCTAssertTrue(a.staticTexts["swift"].exists, "and its language")
        XCTAssertTrue(any.matching(NSPredicate(format: "identifier == 'code-block' AND value == %@", "highlighted: swift")).firstMatch.exists, "coloured as Swift (jxn #2015)")
        XCTAssertTrue(any["md-table"].firstMatch.exists, "the table")
        XCTAssertTrue(a.staticTexts["eu-west"].exists, "its cells")
        shot("b6-01-code-and-table")

        // The chart: drawn, and its numbers under Data.
        let chart = any["chart"].firstMatch
        for _ in 0..<6 where !(chart.exists && chart.isHittable) { a.swipeUp(velocity: .slow); sleep(1) }
        XCTAssertTrue(chart.exists, "the chart")
        let data = a.buttons["chart-data"].firstMatch
        for _ in 0..<4 where !data.isHittable { a.swipeUp(velocity: .slow); sleep(1) }
        data.tap()
        XCTAssertTrue(any["chart-table"].firstMatch.waitForExistence(timeout: 3), "Data shows the numbers")
        XCTAssertTrue(a.staticTexts["after (ms)"].exists, "a column per series")
        shot("b6-02-chart")

        // A diagram is its code, labelled; a status snapshot is a card.
        let status = any["status-card"].firstMatch
        for _ in 0..<6 where !(status.exists && status.isHittable) { a.swipeUp(velocity: .slow); sleep(1) }
        XCTAssertTrue(any["mermaid-block"].firstMatch.exists, "the diagram's code")
        XCTAssertTrue(status.exists, "the status card")
        shot("b6-03-diagram-status")
    }

    /// Syntax colours (jxn #2015): TypeScript, Python, Swift and SQL blocks, each coloured, in light and dark.
    /// TEST_RUNNER_CODE_SHOTS=<dir> also writes the screenshots there.
    func testCodeColours() throws {
        let title = "Checkout bug"
        guard !mayaAgent.isEmpty, let b = boardId(titled: title) else { throw XCTSkip("needs the seed (MAYA_AGENT)") }
        let n = Int(Date().timeIntervalSince1970) % 100000
        let text = """
        Four fixes \(n):

        ```ts
        // retry with backoff
        export async function load(id: string): Promise<Board> {
          return await api.get(`/boards/${id}`, { retries: 3 })
        }
        ```

        ```python
        @cache
        def p95(samples: list[float]) -> float:  # ms
            return sorted(samples)[int(len(samples) * 0.95)]
        ```

        ```swift
        struct Latency: Codable {
            let p95: Double // ms
            func label() -> String { "p95 \\(p95) ms" }
        }
        ```

        ```sql
        SELECT board, count(*) AS n FROM entries
        WHERE type = 'task' AND ts > 1700000000 -- recent
        GROUP BY board ORDER BY n DESC;
        ```
        """
        let posted = call("POST", "/api/boards/\(b)/entries", json: ["type": "note", "text": text], token: mayaAgent)
        XCTAssertTrue((200..<300).contains(posted["_status"] as? Int ?? 0), "posted: \(posted)")
        for theme in ["light", "dark"] {
            let a = app(extra: ["AGENT_SOUP_DISPLAY": "m,comfortable,\(theme)"])
            a.launch()
            openChat(a, title)
            let any = a.descendants(matching: .any)
            XCTAssertTrue(a.staticTexts["Four fixes \(n):"].waitForExistence(timeout: 10), "the message")
            for lang in ["ts", "python", "swift", "sql"] {
                let block = any.matching(NSPredicate(format: "identifier == 'code-block' AND value == %@", "highlighted: \(lang)")).firstMatch
                XCTAssertTrue(block.waitForExistence(timeout: 5), "a \(lang) block, coloured")
            }
            // All four blocks on screen: the last one above the message box (the first unread may have opened it higher).
            let last = any.matching(NSPredicate(format: "identifier == 'code-block' AND value == %@", "highlighted: sql")).firstMatch
            let box = composer(a)
            for _ in 0..<6 where last.frame.maxY > box.frame.minY - 8 { a.swipeUp(velocity: .slow); sleep(1) }
            sleep(1)
            codeShot("code-colours-\(theme)")
            a.terminate()
        }
    }

    private func codeShot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let s = XCTAttachment(screenshot: screenshot)
        s.name = name
        s.lifetime = .keepAlways
        add(s)
        if let dir = env["CODE_SHOTS"], !dir.isEmpty {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    func testRenameAndArchiveFromList() throws {
        let n = Int(Date().timeIntervalSince1970) % 100000
        let title = "Manage \(n)"
        let renamed = "Renamed \(n)"
        // maya's free plan holds 3 active boards and the seed fills them: make room with "Secret plans" for the
        // length of the test (restored last, once this one is archived again).
        guard let secret = boardId(titled: "Secret plans") else { throw XCTSkip("needs the seed") }
        call("POST", "/api/boards/\(secret)/archive", json: ["archived": true])
        defer { call("POST", "/api/boards/\(secret)/archive", json: ["archived": false]) }
        guard let b = newBoard(title) else { return XCTFail("board") }
        defer { call("POST", "/api/boards/\(b)/archive", json: ["archived": true]) } // tidy: out of the other tests' way
        let a = app()
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15))
        let tab = a.buttons["tab-boards"]
        if tab.waitForExistence(timeout: 10) { tab.tap() }

        // Rename: long-press the row → Rename → a new title.
        let row = a.buttons["chat-\(title)"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the new board is in Chats")
        row.press(forDuration: 0.8)
        XCTAssertTrue(a.buttons["Rename"].waitForExistence(timeout: 3), "the row's menu")
        XCTAssertTrue(a.buttons["Archive"].exists && a.buttons["Delete"].exists, "an owner's actions")
        shot("b6-10-row-menu")
        a.buttons["Rename"].tap()
        let field = a.alerts.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 3))
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: title.count + 2) + renamed)
        a.alerts.buttons["Rename"].tap()
        let renamedRow = a.buttons["chat-\(renamed)"].firstMatch
        XCTAssertTrue(renamedRow.waitForExistence(timeout: 8), "renamed in the list")
        let server = call("GET", "/api/me/boards")["boards"] as? [[String: Any]] ?? []
        XCTAssertEqual(server.first { $0["id"] as? String == b }?["title"] as? String, renamed, "and on the server")

        // Archive: swipe the row left → Archive; it leaves the list and waits under Archived.
        renamedRow.swipeLeft()
        let archive = a.buttons["Archive"].firstMatch
        XCTAssertTrue(archive.waitForExistence(timeout: 3), "the swipe actions")
        shot("b6-11-swipe")
        archive.tap()
        XCTAssertTrue(renamedRow.waitForNonExistence(timeout: 8), "gone from Chats")
        let archived = a.buttons["archived-chats"]
        for _ in 0..<6 where !(archived.exists && archived.isHittable) { a.swipeUp(velocity: .slow); sleep(1) }
        XCTAssertTrue(archived.exists, "an Archived row")
        archived.tap()
        let restore = a.buttons["restore-\(renamed)"]
        XCTAssertTrue(restore.waitForExistence(timeout: 5), "it's under Archived")
        shot("b6-12-archived")
        restore.tap()
        XCTAssertTrue(restore.waitForNonExistence(timeout: 8), "restored")
        a.buttons["Done"].tap()
        for _ in 0..<6 where !renamedRow.exists { a.swipeDown(velocity: .slow); sleep(1) }
        XCTAssertTrue(renamedRow.waitForExistence(timeout: 8), "back in Chats")
    }
}
