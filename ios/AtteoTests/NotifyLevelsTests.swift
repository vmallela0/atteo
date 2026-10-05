// Notification volume (vedu #2490): the digest's summary, what's kept between background wakes, the inbox's
// `interrupt`, and the levels' wire values.

import XCTest
@testable import Atteo

@MainActor
final class NotifyLevelsTests: XCTestCase {
    func testDigestGroupsByBoardMostFirst() {
        let e = [DigestEntry(board: "Design", kind: "agent"), DigestEntry(board: "Launch", kind: "mention"), DigestEntry(board: "Launch", kind: "agent"), DigestEntry(board: "Launch", kind: "reply"), DigestEntry(board: "Design", kind: "agent")]
        XCTAssertTrue(DigestSummary.title(e).contains("5"))
        XCTAssertEqual(DigestSummary.body(e), "3 in Launch · 2 in Design")
    }

    func testDigestKeepsFirstSeenOrderOnTiesAndCapsAtThree() {
        let e = ["A", "B", "C", "D", "E"].map { DigestEntry(board: $0, kind: "agent") } + [DigestEntry(board: nil, kind: "friend_accept")]
        let body = DigestSummary.body(e)
        XCTAssertTrue(body.hasPrefix("1 in A · 1 in B · 1 in C"), body)
        XCTAssertTrue(body.hasSuffix("3 more"), body) // D, E and the one with no board
    }

    func testPendingSurvivesBetweenWakesAndClears() {
        Notifier.setPending([DigestEntry(board: "X", kind: "agent")])
        XCTAssertEqual(Notifier.pending(), [DigestEntry(board: "X", kind: "agent")])
        Notifier.setPending([])
        XCTAssertEqual(Notifier.pending(), [])
    }

    func testInboxDecodesInterruptAndNotify() throws {
        let json = """
        {"items":[{"id":1,"board_id":"b_x","board_title":"X","seq":3,"kind":"mention","actor":"maya","actor_via":"person","excerpt":"hi","created_at":1,"read_at":null,"interrupt":"digest","broadcast":true},
                  {"id":2,"board_id":"","seq":0,"kind":"approval","actor":"me","excerpt":"ok?","created_at":2,"read_at":null,"approval_id":"ap_1"}],
         "notify":{"quiet_now":false,"digest_at":1700000000000,"digest":["09:00","13:00","18:00"],"tz":"Europe/Berlin"}}
        """
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        let r = try d.decode(InboxResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.items[0].interrupt, "digest")
        XCTAssertEqual(r.items[1].approvalId, "ap_1")
        XCTAssertNil(r.items[1].interrupt)
        XCTAssertEqual(r.notify?.digestAt, 1_700_000_000_000)
        XCTAssertEqual(r.notify?.digest.count, 3)
        // Marking read keeps the rest.
        XCTAssertEqual(r.items[0].read(at: 5).interrupt, "digest")
        // An older server sends neither: still decodes.
        let old = try d.decode(InboxResponse.self, from: Data(#"{"items":[]}"#.utf8))
        XCTAssertNil(old.notify)
    }

    func testLevelsMatchTheServer() {
        XCTAssertEqual(NotifyLevel.allCases.map(\.rawValue), ["everything", "needs_me", "off"])
        XCTAssertFalse(NotifyLevel.needsMe.hint.isEmpty)
    }

    func testQuietHoursTimesRoundTrip() {
        XCTAssertEqual(QuietHoursRows.hhmm(QuietHoursRows.date("22:00")), "22:00")
        XCTAssertEqual(QuietHoursRows.hhmm(QuietHoursRows.date("07:05")), "07:05")
    }

    /// The same start and end isn't a window (#2668): the row says so and doesn't save; any real window is fine.
    func testSameStartAndEndIsNotAWindow() {
        XCTAssertFalse(QuietHoursRows.isWindow(start: "22:00", end: "22:00"))
        XCTAssertFalse(QuietHoursRows.isWindow(start: QuietHoursRows.hhmm(QuietHoursRows.date("07:00")), end: "07:00"))
        XCTAssertTrue(QuietHoursRows.isWindow(start: "22:00", end: "07:00"))
        XCTAssertTrue(QuietHoursRows.isWindow(start: "07:00", end: "07:01"))
    }

    /// "1 update", "2 updates" (#2668): the title is a real plural, not "1 updates".
    func testDigestTitleIsPlural() {
        let one = [DigestEntry(board: "A", kind: "agent")]
        XCTAssertEqual(DigestSummary.title(one), "1 update since the last digest")
        XCTAssertEqual(DigestSummary.title(one + one), "2 updates since the last digest")
    }
}
