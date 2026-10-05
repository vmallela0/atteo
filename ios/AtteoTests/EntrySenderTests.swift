import XCTest
@testable import Atteo

/// Who wrote a message, for its sender line and for grouping a run (jxn #2589): two sessions of one person's agent are
/// two speakers, as on the web.
final class EntrySenderTests: XCTestCase {
    private func entry(_ author: String, via: String?, client: String?) throws -> Entry {
        var o: [String: Any] = ["seq": 1, "ts": 0, "author": author, "type": "note", "text": "hi"]
        if let via { o["via"] = via }
        if let client { o["client"] = client }
        let d = JSONDecoder(); d.keyDecodingStrategy = .convertFromSnakeCase
        return try d.decode(Entry.self, from: JSONSerialization.data(withJSONObject: o))
    }

    func testSessionNameComesFromTheClientLikeTheWeb() throws {
        XCTAssertEqual(try entry("jxn", via: "agent", client: "opus-b · Claude Code").sessionName, "opus-b")
        XCTAssertNil(try entry("jxn", via: "agent", client: "Claude Code").sessionName, "no named session")
        XCTAssertNil(try entry("jxn", via: "agent", client: nil).sessionName)
        XCTAssertNil(try entry("jxn", via: "person", client: "x · y").sessionName, "people have no session")
        XCTAssertNil(try entry("jxn", via: "agent", client: " · Claude Code").sessionName, "an empty name is none")
    }

    func testTwoSessionsOfOneAgentAreTwoSpeakers() throws {
        let a = try entry("jxn", via: "agent", client: "opus-b · Claude Code")
        let b = try entry("jxn", via: "agent", client: "claude · Claude Code")
        let a2 = try entry("jxn", via: "agent", client: "opus-b · Cursor")
        let person = try entry("jxn", via: "person", client: nil)
        let plain = try entry("jxn", via: "agent", client: "Claude Code")
        XCTAssertNotEqual(a.senderKey, b.senderKey)
        XCTAssertEqual(a.senderKey, a2.senderKey, "the same session, whatever client it reports")
        XCTAssertNotEqual(a.senderKey, person.senderKey, "jxn and jxn's agent are apart")
        XCTAssertNotEqual(a.senderKey, plain.senderKey)
        XCTAssertEqual(person.senderKey, try entry("jxn", via: "person", client: nil).senderKey)
    }
}
