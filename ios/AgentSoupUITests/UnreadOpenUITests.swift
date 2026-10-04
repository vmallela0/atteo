// QA for opening a busy chat with a lot unread: it opens at the first unread under the New line (jxn #1011) and stays
// usable. Checkout bug froze on opening with 8 or 16 of theo's messages under the seed's own unread ones (two sub-task
// cards and an approval, below maya's picture): with the first unread within a screen or two of the end, SwiftUI's lazy
// layout can fail to settle after the scroll to it (100% CPU in one layout pass). State written from the scroll
// geometry meanwhile (the new-messages pill's bookkeeping) made that far likelier; it still happens now and then.

import XCTest

final class UnreadOpenUITests: AtteoUITestCase {
    private var n: Int { Int(Date().timeIntervalSince1970) % 100000 }

    private func seq(_ r: [String: Any]) -> Int { (r["entry"] as? [String: Any])?["seq"] as? Int ?? 0 }

    /// maya's read mark goes to the newest message there (when `markRead`), then theo posts `count` more.
    private func unread(_ count: Int, on board: String, markRead: Bool, n: Int) {
        if markRead {
            let last = seq(call("POST", "/api/boards/\(board)/entries", json: ["type": "note", "text": "Read up to here \(n)"], token: otherApp))
            call("POST", "/api/boards/\(board)/seen", json: ["seq": last])
        }
        for i in 1...count {
            XCTAssertGreaterThan(seq(call("POST", "/api/boards/\(board)/entries", json: ["type": "note", "text": "Busy \(n) message \(i)"], token: otherApp)), 0)
        }
    }

    private func message(_ a: XCUIApplication, _ text: String) -> XCUIElement { a.staticTexts[text] }

    /// Opens Checkout bug with `count` new messages from theo and checks, within 10s, that it opened at the first unread
    /// under the New line and that it's usable: the box takes typing.
    private func opens(_ count: Int, mode: String = "developer", markRead: Bool = true) throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let n = n
        // The freeze needs the seed's read mark with its own unread cards still unread: a fresh seed, before anything
        // has opened Checkout bug (this class on its own, test1 first).
        if !markRead {
            let d = call("GET", "/api/boards/\(b1)/entries?after=0&limit=1000")
            let newest = (d["entries"] as? [[String: Any]] ?? []).compactMap { $0["seq"] as? Int }.max() ?? 0
            let seen = ((d["reads"] as? [String: Any])?["maya"] as? [String: Any])?["person_seen"] as? Int ?? 0
            guard seen > 0, seen < newest else { throw XCTSkip("needs a fresh seed: maya has read Checkout bug (seen \(seen) of \(newest))") }
        }
        // (The last test's app is still in the chat, live: it would read theo's messages as they land.)
        XCUIApplication().terminate()
        unread(count, on: b1, markRead: markRead, n: n)

        let a = app(extra: ["AGENT_SOUP_MODE": mode])
        a.launch()
        if mode == "everyday" { // For you first: Chats is a tap away
            XCTAssertTrue(a.buttons["open-chats"].waitForExistence(timeout: 15), "For you")
            a.buttons["open-chats"].tap()
        }
        openChat(a, "Checkout bug")
        let box = composer(a)
        XCTAssertTrue(eventually(box, "hittable == true", timeout: 10), "the box is usable")
        // Opens at the first unread, under the New line: theo's first new message, or (nothing marked read since the
        // seed) the seed's first message maya hasn't read, further up.
        XCTAssertTrue(a.descendants(matching: .any)["new-divider"].waitForExistence(timeout: 10), "a New line")
        // (A chat loads its latest 80: with more unread than that, the first unread it has.)
        let first = message(a, "Busy \(n) message \(count > 80 ? count - 79 : 1)")
        if markRead { XCTAssertTrue(eventually(first, "hittable == true", timeout: 5), "opens at the first unread") }
        sleep(2)
        if markRead { XCTAssertTrue(first.isHittable, "it stays there") }
        shot("unread-open-\(count)-\(mode)")
        // Usable: the box takes typing.
        box.tap()
        box.typeText("still here \(n)")
        XCTAssertTrue(eventually(box, "value CONTAINS 'still here'", timeout: 5), "it takes typing")
    }

    /// The shape that froze. Runs first on a fresh seed (ios/qa/run.sh -only-testing:AtteoUITests/UnreadOpenUITests):
    /// maya's read mark is where the seed left it (her picture), before the seed's own later messages (theo's agent's
    /// sub-task cards, an approval), so the first unread is above theo's 16. Skipped once Checkout bug has been read
    /// (after other classes in a full run): a constructed copy of that shape didn't freeze the old code.
    func test1_NeverRead16() throws { try opens(16, markRead: false) }
    func test2_Unread16() throws { try opens(16) }
    func test3_Unread50() throws { try opens(50) }
    func test4_Unread100() throws { try opens(100) }
    func test5_EverydayUnread16() throws { try opens(16, mode: "everyday") }
    func test6_EverydayUnread50() throws { try opens(50, mode: "everyday") }
}
