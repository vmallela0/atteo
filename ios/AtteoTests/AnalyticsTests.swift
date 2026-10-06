import XCTest
@testable import Atteo

/// Product analytics (Analytics.swift, vedu #4416): the Settings toggle reaches PostHog, only known events with token
/// properties go out, and the one-time events fire once.
final class AnalyticsTests: XCTestCase {
    final class Recorder: AnalyticsSink {
        var events: [(String, [String: Any])] = [], screens: [String] = []
        var optIns = 0, optOuts = 0, resets = 0
        func start(key: String, host: String, optedOut: Bool) {}
        func capture(_ event: String, properties: [String: Any]) { events.append((event, properties)) }
        func screen(_ name: String) { screens.append(name) }
        func reset() { resets += 1 }
        func optIn() { optIns += 1 }
        func optOut() { optOuts += 1 }
    }

    private var rec: Recorder!
    private let keys = [Analytics.key, "analytics-first-message-ann", "analytics-sessions-seen-ann"]

    override func setUp() {
        super.setUp()
        keys.forEach { UserDefaults.standard.removeObject(forKey: $0) }
        rec = Recorder()
        Analytics.sink = rec
    }

    override func tearDown() {
        Analytics.sink = nil
        keys.forEach { UserDefaults.standard.removeObject(forKey: $0) }
        super.tearDown()
    }

    func testOnByDefaultAndTheToggleOptsOutAndBackIn() {
        XCTAssertTrue(Analytics.enabled)
        Analytics.setEnabled(false)
        XCTAssertEqual(rec.optOuts, 1)
        XCTAssertFalse(Analytics.enabled)
        Analytics.capture("board_created")
        Analytics.screen("chats")
        XCTAssertTrue(rec.events.isEmpty && rec.screens.isEmpty, "nothing is recorded while off")
        Analytics.setEnabled(true)
        XCTAssertEqual(rec.optIns, 1)
        Analytics.capture("board_created")
        XCTAssertEqual(rec.events.map(\.0), ["board_created"])
    }

    func testOnlyKnownEventsAndTokenPropertiesGoOut() {
        Analytics.capture("message_text_leak")
        Analytics.capture("invite_sent", via: "ann@example.com")
        Analytics.capture("invite_sent", via: "link")
        XCTAssertEqual(rec.events.map(\.0), ["invite_sent", "invite_sent"])
        XCTAssertNil(rec.events[0].1["via"], "an address is never a property")
        XCTAssertEqual(rec.events[1].1["via"] as? String, "link")
        XCTAssertEqual(rec.events[1].1["surface"] as? String, "ios")
    }

    func testFirstMessageOncePerPersonAndAgentConnectedOnlyWhenTheCountGoesUp() {
        Analytics.messageSent(by: "ann")
        Analytics.messageSent(by: "ann")
        Analytics.sessionsSeen(1, for: "ann") // the first look only remembers
        Analytics.sessionsSeen(1, for: "ann")
        Analytics.sessionsSeen(2, for: "ann")
        XCTAssertEqual(rec.events.map(\.0), ["first_message", "agent_connected"])
    }

    func testAnonymousOnlyAndResetOnSignOut() {
        Analytics.messageSent(by: "ann")
        XCTAssertFalse(rec.events.contains { e in e.1.values.contains { "\($0)".contains("ann") } }, "no handle in any event")
        Analytics.reset()
        XCTAssertEqual(rec.resets, 1)
    }
}
