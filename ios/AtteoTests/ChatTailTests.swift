// The chat makes its newest messages up front and keeps older history lazy (vedu #2449): a lazy list near its end only
// has guessed row heights, which flipped every frame while the chat was put at a message near the end, and the chat
// froze or came back blank. The part made up front is all of a chat's first 100 (it opens with its latest 80), then the
// newest 80 to 99: with only 40, the keyboard coming up over a long chat brought the lazy part within reach and the
// chat's height went round every frame (UnreadOpen test5, vedu #3059). The split moves in steps of 20.

import XCTest
@testable import Atteo

final class ChatTailTests: XCTestCase {
    func testChatsUpToAHundredAreAllMadeUpFront() {
        for n in [0, 1, 30, 50, 80, 100] { XCTAssertEqual(BoardView.tailStart(n), 0, "\(n) messages") }
    }

    func testTheTailIsEightyToNinetyNine() {
        for n in 101...600 {
            let tail = n - BoardView.tailStart(n)
            XCTAssertTrue((80...99).contains(tail), "\(n) messages: a tail of \(tail)")
        }
    }

    func testTheSplitMovesInStepsOfTwenty() {
        var moves = 0
        for n in 101...400 where BoardView.tailStart(n) != BoardView.tailStart(n - 1) {
            moves += 1
            XCTAssertEqual(BoardView.tailStart(n) % 20, 0)
        }
        XCTAssertLessThanOrEqual(moves, 16, "a new message seldom moves a row between the stacks")
    }
}
