// Settings → Display → Replies (vedu #2360): `replies` decodes, saves and falls back like the other display settings,
// and a server that doesn't keep it yet never resets the phone's choice.

import XCTest
@testable import Atteo

final class DisplayPrefsTests: XCTestCase {
    private func decode(_ json: String) throws -> DisplayPrefs { try JSONDecoder().decode(DisplayPrefs.self, from: Data(json.utf8)) }

    func testRepliesDecodes() throws {
        let d = try decode(#"{"text":"l","density":"compact","theme":"dark","replies":"thread"}"#)
        XCTAssertEqual(d.replies, "thread")
        XCTAssertTrue(d.repliesInThread)
        XCTAssertTrue(d.repliesKnown)
    }

    func testAnOlderServerLeavesItUnknown() throws {
        let d = try decode(#"{"text":"m","density":"comfortable","theme":"system"}"#)
        XCTAssertEqual(d.replies, "chat", "the default")
        XCTAssertFalse(d.repliesKnown, "the server didn't say")
    }

    func testAnUnknownValueIsTheDefault() throws {
        let d = try decode(#"{"replies":"sideways"}"#)
        XCTAssertEqual(d.replies, "chat")
    }

    func testSavesWithAndWithoutIt() {
        let d = DisplayPrefs(replies: "thread")
        XCTAssertEqual(d.body()["replies"], "thread")
        XCTAssertNil(d.body(replies: false)["replies"], "left out for a server that refuses it")
        XCTAssertEqual(d.body(replies: false)["density"], "comfortable", "the rest still saves")
    }

    func testTheCacheRoundTripsAndKnownDoesNotCount() throws {
        var d = DisplayPrefs(replies: "thread")
        let back = try JSONDecoder().decode(DisplayPrefs.self, from: JSONEncoder().encode(d))
        XCTAssertEqual(back, d)
        XCTAssertTrue(back.repliesInThread, "kept on the phone")
        d.repliesKnown = false
        XCTAssertEqual(back, d, "whether the server said isn't a setting")
        XCTAssertEqual(DisplayPrefs(spec: "m,compact,dark,auto,eve,thread")?.replies, "thread")
        XCTAssertEqual(DisplayPrefs(spec: "m,compact,dark")?.replies, "chat")
    }

    /// Tab order (vedu #5192): decodes, saves, round-trips through the cache, and an older server leaves it unknown.
    func testTabOrder() throws {
        let d = try decode(#"{"tab_order":"opened"}"#)
        XCTAssertTrue(d.tabsByOpened)
        XCTAssertTrue(d.tabOrderKnown)
        XCTAssertEqual(d.body()["tab_order"], "opened")
        XCTAssertNil(d.body(tabs: false)["tab_order"], "left out for a server that refuses it")
        XCTAssertEqual(try JSONDecoder().decode(DisplayPrefs.self, from: JSONEncoder().encode(d)).tabOrder, "opened")
        let old = try decode(#"{"text":"m"}"#)
        XCTAssertEqual(old.tabOrder, "recent", "the default: the latest message first")
        XCTAssertFalse(old.tabOrderKnown)
        XCTAssertEqual(try decode(#"{"tab_order":"alphabetical"}"#).tabOrder, "recent")
        XCTAssertNotEqual(d, old, "a different order is a different setting")
    }
}
