// QA for Settings → Display → Messages → One line (jxn #2690, the web's #2691): a message that isn't for you shows as
// one line until you tap it, and a tap on Fold folds it again; a mention of you stays whole; the board's menu opens
// and folds them all.

import XCTest

final class OneLineUITests: AtteoUITestCase {
    private var n: Int { Int(Date().timeIntervalSince1970) % 100000 }
    private func seq(_ r: [String: Any]) -> Int { (r["entry"] as? [String: Any])?["seq"] as? Int ?? 0 }
    private func text(_ a: XCUIApplication, _ s: String) -> XCUIElement {
        a.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", s)).firstMatch
    }

    func testOneLineFoldsWhatIsntForYou() throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let n = n
        let plain = "Plain update \(n): the build is green", mention = "@maya can you look at \(n)?"
        let p = seq(call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": plain], token: otherApp))
        let m = seq(call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": mention], token: otherApp))
        XCTAssertGreaterThan(p, 0); XCTAssertGreaterThan(m, 0)
        // Read up to here, so neither is the first unread (which never folds).
        call("POST", "/api/boards/\(b1)/seen", json: ["seq": m])

        let a = app(extra: ["AGENT_SOUP_DISPLAY": "m,comfortable,system,auto,eve,chat,others"])
        a.launch()
        openChat(a, "Checkout bug")

        let folded = a.descendants(matching: .any)["folded-\(p)"]
        XCTAssertTrue(folded.waitForExistence(timeout: 10), "a message that isn't for you is one line (shown whole instead: \(text(a, plain).exists))")
        XCTAssertTrue(folded.label.contains("Plain update \(n)"), "who · first line (\(folded.label))")
        XCTAssertTrue(text(a, "can you look at \(n)").exists, "a mention of you stays whole")
        XCTAssertFalse(a.descendants(matching: .any)["folded-\(m)"].exists)
        shot("one-line-01-folded")

        // A tap opens it; Fold folds it again.
        folded.tap()
        XCTAssertTrue(text(a, plain).waitForExistence(timeout: 5), "tapped: the whole message")
        let fold = a.buttons["fold-\(p)"]
        XCTAssertTrue(fold.waitForExistence(timeout: 5), "with Fold under it")
        shot("one-line-02-open")
        fold.tap()
        XCTAssertTrue(a.descendants(matching: .any)["folded-\(p)"].waitForExistence(timeout: 5), "folded again")

        // The board's menu: Open all, then Fold all.
        a.buttons["work-menu"].firstMatch.tap(); sleep(1)
        let openAll = a.buttons["Open all"].firstMatch
        XCTAssertTrue(openAll.waitForExistence(timeout: 5))
        openAll.tap()
        XCTAssertTrue(text(a, plain).waitForExistence(timeout: 5), "Open all opens it")
        XCTAssertFalse(a.descendants(matching: .any)["folded-\(p)"].exists)
        a.buttons["work-menu"].firstMatch.tap(); sleep(1)
        let foldAll = a.buttons["Fold all"].firstMatch
        XCTAssertTrue(foldAll.waitForExistence(timeout: 5))
        foldAll.tap()
        XCTAssertTrue(a.descendants(matching: .any)["folded-\(p)"].waitForExistence(timeout: 5), "Fold all folds it again")
        shot("one-line-03-fold-all")
    }

    /// Full (the default): nothing folds.
    func testFullFoldsNothing() throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let plain = "Full stays full \(n)"
        let p = seq(call("POST", "/api/boards/\(b1)/entries", json: ["type": "note", "text": plain], token: otherApp))
        call("POST", "/api/boards/\(b1)/seen", json: ["seq": p])
        let a = app(extra: ["AGENT_SOUP_DISPLAY": "m,comfortable,system,auto,eve,chat,off"])
        a.launch()
        openChat(a, "Checkout bug")
        XCTAssertTrue(text(a, plain).waitForExistence(timeout: 10))
        XCTAssertFalse(a.descendants(matching: .any)["folded-\(p)"].exists)
    }
}
