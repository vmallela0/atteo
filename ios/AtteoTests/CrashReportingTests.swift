import XCTest
import Sentry
@testable import Atteo

/// Privacy boundaries: test whole serialized events, including nested SDK data, rather than regex examples.
final class CrashReportingTests: XCTestCase {
    final class Recorder: CrashSink {
        var started: String?
        var stopped = false
        var events: [String] = []
        var screens: [String] = []
        func start(dsn: String) { started = dsn }
        func stop() { stopped = true }
        func screen(_ name: String) { screens.append(name) }
        func capture(kind: String) { events.append(kind) }
    }

    private var rec: Recorder!
    private var savedConsent: Any?
    private var savedCacheGeneration: Any?

    override func setUp() {
        super.setUp()
        savedConsent = UserDefaults.standard.object(forKey: Analytics.key)
        savedCacheGeneration = UserDefaults.standard.object(forKey: "crash-report-cache-generation")
        UserDefaults.standard.set(true, forKey: Analytics.key)
        rec = Recorder()
        CrashReporting.sink = rec
    }

    override func tearDown() {
        CrashReporting.sink = nil
        UserDefaults.standard.set(savedConsent, forKey: Analytics.key)
        UserDefaults.standard.set(savedCacheGeneration, forKey: "crash-report-cache-generation")
        super.tearDown()
    }

    func testBlankPlaceholderAndMalformedDsnsStayOff() {
        for value in ["", "  ", "$(SENTRY_DSN)", "YOUR_DSN_HERE", "https://example.com", "http://key@host/1",
                      "https://key@host", "https://key@host/project", "https://@host/1", "https://key:secret@host/1",
                      "https://key@host/1?email=ann@example.com"] {
            XCTAssertNil(CrashReporting.dsn(env: value, plist: nil), value)
        }
        XCTAssertNil(CrashReporting.dsn(env: nil, plist: nil))
        let dsn = "https://public@o1.ingest.sentry.io/1"
        XCTAssertEqual(CrashReporting.dsn(env: dsn, plist: "https://other@host/2"), dsn)
        XCTAssertEqual(CrashReporting.dsn(env: nil, plist: "  \(dsn)  "), dsn)
    }

    func testNoDSNDoesNotStartTheSDK() throws {
        try XCTSkipIf(CrashReporting.dsn() != nil, "This developer scheme explicitly configures a DSN")
        CrashReporting.sink = nil
        CrashReporting.start(with: rec)
        XCTAssertNil(rec.started)
        XCTAssertNil(CrashReporting.sink)
    }

    func testOnlyFixedKindsAndScreensReachTheSink() {
        CrashReporting.capture("ann@example.com")
        CrashReporting.capture("http_5xx")
        CrashReporting.capture("json_decode")
        CrashReporting.screen("ann") // even a short token could be a handle
        CrashReporting.screen("settings")
        XCTAssertEqual(rec.events, ["http_5xx", "json_decode"])
        XCTAssertEqual(rec.screens, ["settings"])
        CrashReporting.sink = nil
        CrashReporting.capture("http_5xx")
        XCTAssertEqual(rec.events.count, 2)
    }

    func testAnalyticsOptOutClosesReportingAndPreventsRestartAndCapture() {
        Analytics.setEnabled(false)
        XCTAssertTrue(rec.stopped)
        XCTAssertNil(CrashReporting.sink)
        XCTAssertNotNil(UserDefaults.standard.string(forKey: "crash-report-cache-generation"))
        CrashReporting.start(with: rec)
        XCTAssertNil(rec.started)
        XCTAssertNil(CrashReporting.sink)
        CrashReporting.capture("http_5xx")
        XCTAssertTrue(rec.events.isEmpty)
        let event = Event(level: .fatal)
        event.exceptions = [Exception(value: "private", type: "SIGABRT")]
        XCTAssertNil(CrashReporting.scrub(event), "also drop SDK-generated / previous-launch events after opt-out")
    }

    func testSavedOptOutPreventsSDKStartup() {
        CrashReporting.sink = nil
        UserDefaults.standard.set(false, forKey: Analytics.key)
        CrashReporting.start(with: rec)
        XCTAssertNil(rec.started)
        XCTAssertNil(CrashReporting.sink)
    }

    func testScrubRemovesPIIFromEntireSerializedEventAndKeepsStackAddresses() throws {
        let secret = "private message ann@example.com @ann 192.0.2.1 2001:db8::1"
        let event = Event(level: .fatal)
        event.message = SentryMessage(formatted: secret)
        event.serverName = secret
        event.transaction = secret
        event.environment = secret
        event.logger = secret
        event.dist = secret
        event.fingerprint = [secret]
        event.modules = [secret: secret]
        event.tags = ["screen": "board", "handle": "ann", "email": secret]
        event.extra = ["nested": ["innocent": secret]]
        event.context = ["device": ["name": secret, "id": secret], "os": ["version": "18.0", "name": secret],
                         "app": ["device_app_hash": secret], "trace": ["trace_id": secret]]
        let user = User()
        user.email = secret
        user.username = secret
        user.ipAddress = "192.0.2.1"
        event.user = user
        let request = SentryRequest()
        request.url = "https://example.com/\(secret)"
        request.headers = ["Accept": secret, "Authorization": secret, "X-Forwarded-For": "192.0.2.1"]
        request.cookies = secret
        event.request = request
        let crumb = Breadcrumb()
        crumb.message = secret
        crumb.data = ["nested": ["value": secret]]
        event.breadcrumbs = [crumb]
        let frame = Frame()
        frame.instructionAddress = "0x1234"
        frame.imageAddress = "0x1000"
        frame.function = secret
        frame.fileName = secret
        frame.package = secret
        let exception = Exception(value: secret, type: secret)
        exception.module = secret
        let mechanism = Mechanism(type: secret)
        mechanism.desc = secret
        mechanism.data = ["body": secret]
        mechanism.handled = false
        exception.mechanism = mechanism
        exception.stacktrace = SentryStacktrace(frames: [frame], registers: ["x0": secret])
        event.exceptions = [exception]
        let binary = DebugMeta()
        binary.debugID = "12345678-1234-1234-1234-123456789ABC"
        binary.imageAddress = "0x1000"
        binary.codeFile = secret
        event.debugMeta = [binary]
        event.releaseName = "Atteo@1.2.3+4"

        let clean = try XCTUnwrap(CrashReporting.scrub(event))
        let serialized = try JSONSerialization.data(withJSONObject: clean.serialize(), options: [.sortedKeys])
        let json = String(decoding: serialized, as: UTF8.self)
        for forbidden in ["private message", "ann@example.com", "@ann", "192.0.2.1", "2001:db8::1", "Authorization", "device_app_hash"] {
            XCTAssertFalse(json.contains(forbidden), forbidden)
        }
        XCTAssertNil(clean.request)
        XCTAssertNil(clean.user)
        XCTAssertNil(clean.extra)
        XCTAssertNil(clean.message)
        XCTAssertNil(clean.breadcrumbs)
        XCTAssertEqual(clean.tags, ["screen": "board"])
        XCTAssertEqual(clean.context?.count, 1)
        XCTAssertEqual(clean.releaseName, "Atteo@1.2.3+4")
        XCTAssertEqual(clean.exceptions?.first?.type, "native_crash")
        XCTAssertEqual(clean.exceptions?.first?.mechanism?.handled, false)
        XCTAssertEqual(clean.exceptions?.first?.stacktrace?.frames.first?.instructionAddress, "0x1234")
        XCTAssertEqual(clean.debugMeta?.first?.debugID, binary.debugID)
        XCTAssertEqual((clean.sdk?["settings"] as? [String: String])?["infer_ip"], "never")
    }

    func testManualErrorsKeepOnlyTheirKindAndUnknownScreensAreDropped() throws {
        let event = Event(level: .error)
        event.message = SentryMessage(formatted: "json_decode")
        event.tags = ["screen": "ann", "handle": "ann", "status": "500"]
        let clean = try XCTUnwrap(CrashReporting.scrub(event))
        XCTAssertEqual(clean.exceptions?.first?.type, "json_decode")
        XCTAssertNil(clean.message)
        XCTAssertNil(clean.tags)
        event.message = SentryMessage(formatted: "private message")
        XCTAssertNil(CrashReporting.scrub(event))
        event.type = "transaction"
        XCTAssertNil(CrashReporting.scrub(event))
    }
}
