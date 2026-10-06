// "… is typing" per place (vedu #4746): a ping from a thread's reply box shows over that thread's box only, and one
// from the chat (or from an older server or page, with no root) over the chat's only.

import XCTest
@testable import Atteo

@MainActor
final class TypingThreadTests: XCTestCase {
    func testTypersAreKeptApartByThread() {
        let s = AppState()
        let soon = Date().timeIntervalSince1970 * 1000 + 6000, now = Date().timeIntervalSince1970 * 1000
        s.heardTyping("maya", until: soon, root: 0, on: "b1")
        s.heardTyping("theo", until: soon, root: 42, on: "b1")
        s.heardTyping("ann", until: soon, on: "b1") // no root: the chat
        XCTAssertEqual(Set(s.typers("b1", root: 0, at: now)), ["maya", "ann"], "the chat's row: the chat's typers")
        XCTAssertEqual(s.typers("b1", root: 42, at: now), ["theo"], "thread 42's row: only its typer")
        XCTAssertEqual(s.typers("b1", root: 7, at: now), [], "another thread: nobody")
    }

    func testMovingToAThreadMovesTheTyper() {
        let s = AppState()
        let now = Date().timeIntervalSince1970 * 1000
        s.heardTyping("maya", until: now + 6000, root: 0, on: "b1")
        s.heardTyping("maya", until: now + 7000, root: 42, on: "b1")
        XCTAssertEqual(s.typers("b1", root: 0, at: now), [], "she left the chat's box")
        XCTAssertEqual(s.typers("b1", root: 42, at: now), ["maya"], "she's typing in the thread now")
    }

    func testExpiredPingsDontShow() {
        let s = AppState()
        let now = Date().timeIntervalSince1970 * 1000
        s.heardTyping("maya", until: now - 1, root: 42, on: "b1")
        XCTAssertEqual(s.typers("b1", root: 42, at: now), [])
    }
}
