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

    // jxn #4181: saving on every key redrew every row of Chats (they show drafts) and wrote UserDefaults each time.
    func testSavingTheSameTextChangesNothing() {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let b = board("one")
        let store = MessageDrafts(defaults: defaults)
        store.save("words", for: b)
        let after = store.revision
        store.save("words", for: b)
        XCTAssertEqual(store.revision, after, "no change, no redraw")
        store.save("words!", for: b)
        XCTAssertEqual(store.revision, after + 1)
    }

    @MainActor
    func testBoxSavesOncePausedAndAtOnceWhenAsked() async throws {
        let b = board("box-\(UUID().uuidString)")
        defer { MessageDrafts.shared.clear(for: b) }
        let box = ComposerDraft(board: b)
        var seen: [String] = []
        box.onChange = { seen.append($0) }
        box.set("h"); box.set("he"); box.set("hey")
        XCTAssertEqual(box.text, "hey")
        XCTAssertEqual(seen, ["h", "he", "hey"])
        XCTAssertEqual(MessageDrafts.shared.text(for: b), "", "not saved while typing")
        try await Task.sleep(for: .milliseconds(1400))
        XCTAssertEqual(MessageDrafts.shared.text(for: b), "hey", "saved once typing paused")
        box.set("hey there")
        box.save() // leaving the chat
        XCTAssertEqual(MessageDrafts.shared.text(for: b), "hey there")
        XCTAssertEqual(ComposerDraft(board: b).text, "hey there", "a new box restores it")
    }

    @MainActor
    func testThreadBoxAttachesLater() {
        let b = board("box-\(UUID().uuidString)")
        defer { MessageDrafts.shared.clear(for: b, root: 9) }
        MessageDrafts.shared.save("a reply", for: b, root: 9)
        let box = ComposerDraft()
        box.set("typed before it knew where") // no board yet: nothing saved
        box.save()
        box.attach(b, root: 9)
        XCTAssertEqual(box.text, "a reply")
    }
}
