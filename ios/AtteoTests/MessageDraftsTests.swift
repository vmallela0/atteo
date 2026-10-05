import XCTest
@testable import Atteo

final class MessageDraftsTests: XCTestCase {
    private func board(_ id: String, encrypted: Bool = false) -> Board {
        Board(id: id, title: id, kind: "board", entryCount: 0, lastActivity: 0, encrypted: encrypted, last: nil)
    }

    func testBoardDraftSavesRestoresAndClearsAfterSend() {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let b = board("one")
        let store = MessageDrafts(defaults: defaults)
        store.save("unfinished message", for: b)
        XCTAssertEqual(MessageDrafts(defaults: defaults).text(for: b), "unfinished message")
        XCTAssertEqual(store.text(for: board("two")), "")
        store.clear(for: b)
        XCTAssertEqual(MessageDrafts(defaults: defaults).text(for: b), "")
    }

    func testThreadDraftsAreSeparateFromBoardAndEachOther() {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let b = board("one")
        let store = MessageDrafts(defaults: defaults)
        store.save("board text", for: b)
        store.save("first reply", for: b, root: 12)
        store.save("second reply", for: b, root: 13)
        let restored = MessageDrafts(defaults: defaults)
        XCTAssertEqual(restored.text(for: b), "board text")
        XCTAssertEqual(restored.text(for: b, root: 12), "first reply")
        XCTAssertEqual(restored.text(for: b, root: 13), "second reply")
        store.clear(for: b, root: 12)
        XCTAssertEqual(restored.text(for: b, root: 12), "")
        XCTAssertEqual(restored.text(for: b), "board text")
    }

    func testEncryptedDraftNeverPersists() {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let b = board("secret", encrypted: true)
        let store = MessageDrafts(defaults: defaults)
        store.save("private text", for: b)
        store.save("private reply", for: b, root: 7)
        XCTAssertEqual(store.text(for: b), "private text")
        XCTAssertEqual(store.text(for: b, root: 7), "private reply")
        XCTAssertFalse(defaults.dictionaryRepresentation().keys.contains { $0.hasPrefix("message-draft.") })
        XCTAssertEqual(MessageDrafts(defaults: defaults).text(for: b), "")
    }
}
