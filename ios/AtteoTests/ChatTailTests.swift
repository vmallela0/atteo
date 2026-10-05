// The chat makes its newest 30 to 50 messages up front and keeps older history lazy (vedu #2449): a lazy list near its
// end only has guessed row heights, which flipped every frame while the chat was put at a message near the end, and
// the chat froze or came back blank. The split moves in steps of 20.

import XCTest
@testable import Atteo

final class ChatTailTests: XCTestCase {
    func testShortChatsAreAllMadeUpFront() {
        for n in [0, 1, 30, 50] { XCTAssertEqual(BoardView.tailStart(n), 0, "\(n) messages") }
    }

    func testTheTailIsThirtyToFifty() {
        for n in 51...600 {
            let tail = n - BoardView.tailStart(n)
            XCTAssertTrue((30...50).contains(tail), "\(n) messages: a tail of \(tail)")
        }
    }

    func testTheSplitMovesInStepsOfTwenty() {
        var moves = 0
        for n in 51...400 where BoardView.tailStart(n) != BoardView.tailStart(n - 1) {
            moves += 1
            XCTAssertEqual(BoardView.tailStart(n) % 20, 0)
        }
        XCTAssertLessThanOrEqual(moves, 18, "a new message seldom moves a row between the stacks")
    }
}
