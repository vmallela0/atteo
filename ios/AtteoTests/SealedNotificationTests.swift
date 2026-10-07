// A notification for an end-to-end encrypted board is decrypted on the phone (Notifier.check). Which inbox items are
// those: the board's own flag, or the server's stand-in text, "🔒 encrypted" (src/board.ts; review #5551 item 4).

import XCTest
@testable import Atteo

final class SealedNotificationTests: XCTestCase {
    private func item(board: String = "b_1", seq: Int = 7, excerpt: String) -> InboxItem {
        InboxItem(id: 1, boardId: board, boardTitle: "Plans", seq: seq, kind: "mention", actor: "ann", actorVia: "person", excerpt: excerpt, createdAt: 0, readAt: nil)
    }

    func testTheServersStandInIsRecognised() {
        XCTAssertTrue(Notifier.sealed(item(excerpt: "🔒 encrypted"), encryptedBoards: []))
        XCTAssertTrue(Notifier.sealed(item(excerpt: "🔒 Encrypted message (read it with atteo read)"), encryptedBoards: []), "an older server")
    }

    func testAnEncryptedBoardIsEnoughWhateverTheExcerpt() {
        XCTAssertTrue(Notifier.sealed(item(excerpt: "anything"), encryptedBoards: ["b_1"]))
    }

    func testPlainMessagesAreLeftAlone() {
        XCTAssertFalse(Notifier.sealed(item(excerpt: "lunch at noon?"), encryptedBoards: ["b_other"]))
        XCTAssertFalse(Notifier.sealed(item(board: "", excerpt: "🔒 encrypted"), encryptedBoards: []), "no board")
        XCTAssertFalse(Notifier.sealed(item(seq: 0, excerpt: "🔒 encrypted"), encryptedBoards: []), "no message")
    }
}
