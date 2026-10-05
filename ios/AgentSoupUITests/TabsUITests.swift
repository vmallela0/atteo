// A board's tabs under its title, Chat · Tasks · Files (vedu #2549): always visible, a tap or a sideways swipe away,
// with the Threads button gone from the top bar (All threads is in ⋯). Same harness as the other UI tests (a local
// server seeded by ios/qa/seed.mjs, run by ios/qa/run.sh); Checkout bug has open tasks and files.

import XCTest

final class TabsUITests: AtteoUITestCase {
    private var any: XCUIElementQuery { XCUIApplication().descendants(matching: .any) }

    /// The strip is there with counts; each tab shows its part; the message box is only the chat's.
    func testTabsStripAndTaps() throws {
        continueAfterFailure = false
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")

        let chat = a.boardTab("tab-chat"), tasks = a.boardTab("tab-tasks"), files = a.boardTab("tab-files")
        XCTAssertTrue(chat.waitForExistence(timeout: 5) && tasks.exists && files.exists, "Chat · Tasks · Files under the title")
        XCTAssertTrue(chat.isSelected, "opens on Chat")
        XCTAssertEqual(tasks.label, "Tasks")
        XCTAssertTrue(eventually(tasks, "value ENDSWITH ' open'"), "Tasks says how many are open (\(tasks.value ?? ""))")
        XCTAssertFalse(a.buttons["threads"].exists, "no Threads button in the top bar")
        assertTitleClear(a, "chat")
        shot("tabs-01-chat")

        XCTAssertTrue(a.openBoardTab("tab-tasks"), "Tasks")
        XCTAssertTrue(any["group-open"].firstMatch.waitForExistence(timeout: 8), "the board's tasks")
        XCTAssertFalse(composer(a).exists, "no message box on Tasks")
        XCTAssertTrue(a.buttons["new-task"].exists, "a new task, from the top bar")
        assertTitleClear(a, "tasks")
        shot("tabs-02-tasks")

        XCTAssertTrue(a.openBoardTab("tab-files"), "Files")
        XCTAssertTrue(any["file-rollout-plan.md"].firstMatch.waitForExistence(timeout: 8), "the board's files")
        XCTAssertTrue(eventually(files, "value ENDSWITH ' files'"), "Files says how many (\(files.value ?? ""))")
        shot("tabs-03-files")

        XCTAssertTrue(a.openBoardTab("tab-chat"), "Chat")
        XCTAssertTrue(composer(a).waitForExistence(timeout: 5), "the message box is back")
    }

    /// Right to left pages Chat → Tasks → Files; left to right comes back. A message's own swipe (right: its thread) and a
    /// task's (left: Remove) still win where they start.
    func testSwipeBetweenTabs() throws {
        continueAfterFailure = false
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let tasks = a.boardTab("tab-tasks"), files = a.boardTab("tab-files"), chat = a.boardTab("tab-chat")
        XCTAssertTrue(tasks.waitForExistence(timeout: 5))

        // In the chat: right to left, mid-screen, goes to Tasks.
        let mid = a.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
        mid.press(forDuration: 0.05, thenDragTo: a.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)), withVelocity: .fast, thenHoldForDuration: 0)
        XCTAssertTrue(eventually(tasks, "isSelected == true", timeout: 4), "swiping left in the chat opens Tasks")
        XCTAssertTrue(any["group-open"].firstMatch.waitForExistence(timeout: 8))

        // A task's own swipe comes first: Remove shows, still on Tasks.
        let row = any["task-row-Add a regression test for empty carts"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.swipeLeft()
        XCTAssertTrue(a.buttons["Remove"].firstMatch.waitForExistence(timeout: 3), "the row's own swipe: Remove")
        XCTAssertTrue(tasks.isSelected, "a swipe on a task row stays on Tasks")
        shot("tabs-04-row-swipe")
        // Swipe it shut, from the row's visible part (the screen's edge is Back): it closes, and the tab stays.
        let screen = a.coordinate(withNormalizedOffset: .zero), y = row.frame.midY, w = a.frame.width
        screen.withOffset(CGVector(dx: w * 0.25, dy: y)).press(forDuration: 0.05, thenDragTo: screen.withOffset(CGVector(dx: w * 0.85, dy: y)))
        XCTAssertTrue(eventually(a.buttons["Remove"].firstMatch, "exists == false", timeout: 3), "the swipe closes")
        XCTAssertTrue(tasks.isSelected, "…and the tab stays on Tasks")

        // On the strip (at the tabs' height): right to left to Files, then back to Tasks and Chat.
        swipeStrip(a, left: true)
        XCTAssertTrue(eventually(files, "isSelected == true", timeout: 4), "on to Files")
        XCTAssertTrue(any["file-rollout-plan.md"].firstMatch.waitForExistence(timeout: 8))
        swipeStrip(a, left: false)
        XCTAssertTrue(eventually(tasks, "isSelected == true", timeout: 4), "back to Tasks")
        swipeStrip(a, left: false)
        XCTAssertTrue(eventually(chat, "isSelected == true", timeout: 4), "back to Chat")
        XCTAssertTrue(composer(a).waitForExistence(timeout: 5))

        // In the chat, left to right on a message is still its thread, not a tab. (theo posts a plain one to swipe.)
        let words = "tabs swipe check \(Int(Date().timeIntervalSince1970) % 100000)"
        if let id = boardId(titled: "Checkout bug") {
            call("POST", "/api/boards/\(id)/entries", json: ["type": "note", "text": words], token: otherApp)
        }
        let message = a.staticTexts[words]
        XCTAssertTrue(eventually(message, "exists == true AND hittable == true", timeout: 15), "theo's message arrives")
        let from = message.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
        from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 140, dy: 0)), withVelocity: .fast, thenHoldForDuration: 0)
        XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 3), "swiping a message right opens its thread")
        a.navigationBars["Thread"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(chat.isSelected, "still on Chat")
    }

    /// All threads is in ⋯; the tab you were on comes back when you open the board again.
    func testThreadsInMenuAndTabRemembered() throws {
        continueAfterFailure = false
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        a.openThreadsList()
        XCTAssertTrue(a.navigationBars["Threads"].waitForExistence(timeout: 5), "the threads list, from ⋯")
        shot("tabs-05-threads")
        a.navigationBars["Threads"].buttons.element(boundBy: 0).tap()

        XCTAssertTrue(a.openBoardTab("tab-files"), "Files")
        a.navigationBars.buttons.element(boundBy: 0).tap() // back to Chats
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 5))
        a.buttons["chat-Checkout bug"].firstMatch.tap()
        XCTAssertTrue(eventually(a.boardTab("tab-files"), "isSelected == true", timeout: 6), "it opens on Files again")
    }

    /// The magnifying glass (jxn #2566): Search this board, the field ready; a hit goes to that message in Chat, from any
    /// tab.
    func testBoardSearchJumpsToMessage() throws {
        continueAfterFailure = false
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        XCTAssertTrue(a.openBoardTab("tab-files"), "start from another tab")
        let search = a.buttons["board-search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5), "a search button in the top bar")
        XCTAssertEqual(search.label, "Search this board")
        search.tap()
        let field = a.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5), "the search field")
        XCTAssertTrue(eventually(field, "hasKeyboardFocus == true", timeout: 3), "ready to type in")
        field.typeText("step 7")
        let hit = a.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'search-hit-' AND label CONTAINS 'retry path' AND (label ENDSWITH 'step 7' OR label CONTAINS 'step 7 ' OR label CONTAINS 'step 7,')")).firstMatch
        XCTAssertTrue(hit.waitForExistence(timeout: 10), "the message is a hit")
        shot("tabs-06-search")
        hit.tap()
        let message = a.staticTexts["Earlier: checked the retry path, step 7"]
        XCTAssertTrue(eventually(a.boardTab("tab-chat"), "isSelected == true", timeout: 5), "back on Chat")
        XCTAssertTrue(eventually(message, "exists == true AND hittable == true", timeout: 15), "scrolled to the message")
        shot("tabs-07-search-jumped")
    }

    /// The title and who's working never run under the buttons (vedu #2650): at Dynamic Type XL, with the most buttons on
    /// the right (Tasks adds +), and on a board with a very long title.
    func testTitleNeverUnderButtons() throws {
        continueAfterFailure = false
        // A long title: one of maya's own boards (not Checkout bug), renamed for this test and named back after it (a new
        // board would pass the Free plan's 3; only a board's creator can rename it, so try hers until one takes).
        let long = "A very long board title that keeps going \(Int(Date().timeIntervalSince1970) % 100000)"
        let boards = (call("GET", "/api/me/boards")["boards"] as? [[String: Any]] ?? [])
            .filter { $0["archived"] as? Bool != true && ($0["kind"] as? String ?? "board") == "board" && $0["title"] as? String != "Checkout bug" }
        var renamedBoard: (id: String, title: String)?
        for b in boards {
            guard let id = b["id"] as? String, let title = b["title"] as? String else { continue }
            if call("POST", "/api/boards/\(id)/rename", json: ["title": long])["_status"] as? Int == 200 { renamedBoard = (id, title); break }
        }
        let renamed = try XCTUnwrap(renamedBoard, "one of maya's boards takes the long title")
        addTeardownBlock { [self] in call("POST", "/api/boards/\(renamed.id)/rename", json: ["title": renamed.title]) }
        let a = app()
        a.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryXL"]
        a.launch()
        openChat(a, "Checkout bug")
        assertTitleClear(a, "XL chat")
        XCTAssertTrue(a.openBoardTab("tab-tasks"))
        assertTitleClear(a, "XL tasks")
        shot("tabs-08-title-xl")
        XCTAssertTrue(a.openBoardTab("tab-chat"))
        a.navigationBars.buttons.element(boundBy: 0).tap() // back to Chats
        openChat(a, long)
        assertTitleClear(a, "long title")
        XCTAssertTrue(a.openBoardTab("tab-tasks"))
        assertTitleClear(a, "long title, tasks")
        shot("tabs-09-title-long")
    }

    /// The title block (the board's name and who's working) is clear of every button on both sides of the top bar.
    private func assertTitleClear(_ a: XCUIApplication, _ step: String) {
        let title = a.buttons["presence"]
        XCTAssertTrue(title.waitForExistence(timeout: 5), "\(step): the title")
        sleep(1) // the bar settles after a tab change
        let t = title.frame
        for id in ["board-search", "board-menu", "new-task", "talk", "BackButton"] {
            let b = a.navigationBars.buttons[id].firstMatch.exists ? a.navigationBars.buttons[id].firstMatch : a.buttons[id].firstMatch
            guard b.exists, b.frame.width > 0 else { continue }
            XCTAssertFalse(t.intersects(b.frame), "\(step): the title block \(t) runs under \(id) \(b.frame)")
        }
    }

    /// A sideways swipe along the tab strip, at the height of the tabs themselves (the strip's frame reaches up under
    /// the navigation bar, whose middle isn't the strip).
    private func swipeStrip(_ a: XCUIApplication, left: Bool) {
        let y = a.boardTab("tab-chat").frame.midY
        let origin = a.coordinate(withNormalizedOffset: .zero)
        let width = a.frame.width
        let from = origin.withOffset(CGVector(dx: width * (left ? 0.8 : 0.3), dy: y))
        let to = origin.withOffset(CGVector(dx: width * (left ? 0.3 : 0.8), dy: y))
        from.press(forDuration: 0.05, thenDragTo: to, withVelocity: .fast, thenHoldForDuration: 0)
        sleep(1)
    }

    /// The largest accessibility text size: the strip grows with the text and scrolls sideways rather than running
    /// off the screen, and every tab still opens.
    func testTabsAtLargestTextSize() throws {
        continueAfterFailure = false
        let a = app()
        a.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        a.launch()
        // At this size the board can be below the fold of Chats: scroll to it.
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15), "Chats")
        if a.buttons["tab-boards"].waitForExistence(timeout: 10) { a.buttons["tab-boards"].tap() }
        let row = a.buttons["chat-Checkout bug"].firstMatch
        for _ in 0..<8 where !row.isHittable { a.swipeUp(velocity: .slow) }
        XCTAssertTrue(row.waitForExistence(timeout: 5), "Checkout bug is in the list")
        row.tap()
        let chat = a.boardTab("tab-chat")
        XCTAssertTrue(chat.waitForExistence(timeout: 10))
        XCTAssertGreaterThanOrEqual(chat.frame.minX, a.frame.minX, "Chat starts on screen")
        XCTAssertGreaterThanOrEqual(chat.frame.minY, a.navigationBars.firstMatch.frame.maxY - 1, "the strip doesn't run up under the top bar")
        shot("tabs-ax-01-chat")
        XCTAssertTrue(a.openBoardTab("tab-files"), "Files opens, scrolled to if it has to be")
        shot("tabs-ax-02-files")
        XCTAssertTrue(a.openBoardTab("tab-chat"), "and back to Chat")
    }
}
