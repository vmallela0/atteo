import XCTest
@testable import Atteo

/// Crash reporting (CrashReporting.swift, vedu #4640): no DSN means off; only known kinds with token tags go out;
/// scrubbing drops Authorization, emails, tokens and long / board-like fields.
final class CrashReportingTests: XCTestCase {
    final class Recorder: CrashSink {
        var started: String?
        var events: [(String, [String: String])] = []
        func start(dsn: String) { started = dsn }
        func capture(kind: String, tags: [String: String]) { events.append((kind, tags)) }
    }

    private var rec: Recorder!

    override func setUp() {
        super.setUp()
        rec = Recorder()
        CrashReporting.sink = rec
    }

    override func tearDown() {
        CrashReporting.sink = nil
        super.tearDown()
    }

    func testBlankAndPlaceholderDsnsStayOff() {
        XCTAssertNil(CrashReporting.dsn(env: nil, plist: nil))
        XCTAssertNil(CrashReporting.dsn(env: "", plist: "  "))
        XCTAssertNil(CrashReporting.dsn(env: "$(SENTRY_DSN)", plist: nil))
        XCTAssertNil(CrashReporting.dsn(env: "YOUR_DSN_HERE", plist: "https://example.com"))
        XCTAssertNil(CrashReporting.dsn(env: "http://insecure@o1.ingest.sentry.io/1", plist: nil))
        XCTAssertNil(CrashReporting.dsn(env: "not-a-dsn", plist: nil))
    }

    func testHttpsDsnIsAcceptedAndEnvWins() {
        let d = "https://public@o1.ingest.sentry.io/1"
        XCTAssertEqual(CrashReporting.dsn(env: d, plist: nil), d)
        XCTAssertEqual(CrashReporting.dsn(env: nil, plist: "  \(d)  "), d)
        XCTAssertEqual(CrashReporting.dsn(env: d, plist: "https://other@o1.ingest.sentry.io/2"), d)
    }

    func testStartWithoutADsnNeverInstallsTheSink() {
        CrashReporting.sink = nil
        CrashReporting.start(with: rec)
        XCTAssertNil(CrashReporting.sink, "no DSN (and debug without ATTEO_SENTRY): Sentry never starts")
        XCTAssertNil(rec.started)
    }

    func testOnlyKnownKindsAndTokenTagsGoOut() {
        CrashReporting.capture("message_text_leak")
        CrashReporting.capture("http_5xx", tags: ["status": "500", "email": "ann@example.com", "path": "/api/boards/b_1"])
        CrashReporting.capture("json_decode", tags: ["surface": "ios"])
        XCTAssertEqual(rec.events.map(\.0), ["http_5xx", "json_decode"])
        XCTAssertEqual(rec.events[0].1["status"], "500")
        XCTAssertNil(rec.events[0].1["email"], "an address is never a tag")
        XCTAssertNil(rec.events[0].1["path"], "a board path is never a tag")
        XCTAssertEqual(rec.events[0].1["surface"], "ios")
        XCTAssertEqual(rec.events[1].1["surface"], "ios")
    }

    func testCaptureIsANoOpWhenSentryDidNotStart() {
        CrashReporting.sink = nil
        CrashReporting.capture("http_5xx", tags: ["status": "500"])
        XCTAssertTrue(rec.events.isEmpty)
    }

    func testRedactStripsEmailsTokensAndJwts() {
        let raw = "user ann@example.com Authorization: Bearer ab_secret eyJhbGciOiJIUzI1NiJ9.aaa.bbb"
        let out = CrashReporting.redact(raw)
        XCTAssertFalse(out.contains("ann@example.com"))
        XCTAssertFalse(out.contains("ab_secret"))
        XCTAssertFalse(out.contains("eyJhbGciOiJIUzI1NiJ9"))
        XCTAssertTrue(out.contains("[redacted]"))
    }

    func testAuthAndCookieHeadersAreDropped() {
        XCTAssertTrue(CrashReporting.dropHeader("Authorization"))
        XCTAssertTrue(CrashReporting.dropHeader("authorization"))
        XCTAssertTrue(CrashReporting.dropHeader("Cookie"))
        XCTAssertTrue(CrashReporting.dropHeader("X-Api-Key"))
        XCTAssertTrue(CrashReporting.dropHeader("X-CSRF-Token"))
        XCTAssertFalse(CrashReporting.dropHeader("User-Agent"))
        XCTAssertFalse(CrashReporting.dropHeader("Accept"))
    }

    func testBoardLikeFieldsAreDropped() {
        XCTAssertTrue(CrashReporting.dropField("message"))
        XCTAssertTrue(CrashReporting.dropField("text"))
        XCTAssertTrue(CrashReporting.dropField("email"))
        XCTAssertTrue(CrashReporting.dropField("handle"))
        XCTAssertTrue(CrashReporting.dropField("body"))
        XCTAssertFalse(CrashReporting.dropField("status"))
        XCTAssertFalse(CrashReporting.dropField("surface"))
    }
}
