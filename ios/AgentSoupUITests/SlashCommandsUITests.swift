// QA for slash commands (#928–#930): a person's message is a note unless it starts with a command. "/" shows the
// chips (/task, /decide, /ask); picking one starts the message with it; the command word is taken off the text.
// /task: its next lines become a checklist (a task on the board); /decide: a human decision; /ask: an open question.
// An encrypted board offers no /task (its server can't read a title).

import XCTest

final class SlashCommandsUITests: AtteoUITestCase {
    /// maya's newest entry on the board whose text contains `marker`.
    func entry(_ board: String, _ marker: String) -> [String: Any]? {
        for _ in 0..<15 {
            let entries = call("GET", "/api/boards/\(board)/entries?after=0&limit=500")["entries"] as? [[String: Any]] ?? []
            if let e = entries.last(where: { ($0["text"] as? String ?? "").contains(marker) }) { return e }
            sleep(1)
        }
        return nil
    }

    func testSlashCommands() throws {
        continueAfterFailure = false
        guard let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server") }
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let box = composer(a)
        let n = Int(Date().timeIntervalSince1970) % 100000

        // A plain message is a note: no chips.
        box.tap()
        box.typeText("Plain words \(n)")
        XCTAssertFalse(a.buttons["slash-task"].exists, "no chips without a /")
        a.buttons["send"].tap()
        XCTAssertEqual(entry(b1, "Plain words \(n)")?["type"] as? String, "note")

        // "/" shows every command; pick /task.
        box.typeText("/")
        XCTAssertTrue(a.buttons["slash-task"].waitForExistence(timeout: 3), "/task")
        XCTAssertTrue(a.buttons["slash-decide"].exists && a.buttons["slash-ask"].exists, "/decide and /ask")
        shot("slash-01-chips")
        box.typeText("t")
        XCTAssertFalse(a.buttons["slash-decide"].exists, "only what fits what's typed")
        a.buttons["slash-task"].tap()
        XCTAssertTrue(eventually(box, "value == '/task '"), "the message starts with the command")
        box.typeText("Write the launch note \(n)\nfirst draft\nreview with theo")
        XCTAssertTrue(a.buttons["slash-task"].isSelected, "it will go as a task")
        shot("slash-02-task")
        a.buttons["send"].tap()
        let task = entry(b1, "Write the launch note \(n)")
        XCTAssertEqual(task?["type"] as? String, "task")
        let text = task?["text"] as? String ?? ""
        XCTAssertFalse(text.contains("/task"), "the command word is gone")
        XCTAssertTrue(text.contains("- [ ] first draft") && text.contains("- [ ] review with theo"), "the next lines are its checklist (\(text))")
        let tasks = call("GET", "/api/boards/\(b1)/tasks")["tasks"] as? [[String: Any]] ?? []
        XCTAssertTrue(tasks.contains { $0["title"] as? String == "Write the launch note \(n)" }, "a task on the board")
        let card = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'task-card-' AND label CONTAINS %@", "Write the launch note \(n)")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 8), "shown as a task card")

        // /decide: a human decision (waiting on theo).
        box.typeText("/decide Ship on Monday \(n)")
        a.buttons["send"].tap()
        XCTAssertEqual(entry(b1, "Ship on Monday \(n)")?["type"] as? String, "decision")
        let pill = a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'decision-pill' AND label == 'Human decision · waiting on theo'")).firstMatch
        XCTAssertTrue(pill.waitForExistence(timeout: 8), "a human decision")

        // /ask: an open question, the command word gone.
        box.typeText("/ask Who has the pager this week \(n)?")
        a.buttons["send"].tap()
        let q = entry(b1, "Who has the pager this week \(n)?")
        XCTAssertEqual(q?["type"] as? String, "question")
        XCTAssertEqual(q?["text"] as? String, "Who has the pager this week \(n)?")
        shot("slash-03-sent")

        // "/task" alone can't be sent yet.
        box.typeText("/task ")
        XCTAssertFalse(a.buttons["send"].isEnabled, "nothing to send yet")
    }
}
