// Product analytics (Analytics.swift): the key gate, the property allowlist, and the opt-out.
// No network. A fake transport records what would have been posted.

import XCTest
@testable import Atteo

final class AnalyticsTests: XCTestCase {
    private let key = "phc_abcdefgh"
    private var suite = ""
    private var savedProvider: (() -> Analytics.Config?)?
    private var savedStore: UserDefaults?
    private var savedTransport: AnalyticsTransport?

    override func setUp() {
        super.setUp()
        suite = "analytics-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        savedProvider = Analytics.configProvider
        savedStore = Analytics.store
        savedTransport = Analytics.transport
        Analytics.store = defaults
        Analytics.applyRemote(key: nil, host: nil)
        Analytics.configProvider = { nil }
    }

    override func tearDown() {
        Analytics.configProvider = savedProvider ?? { nil }
        if let savedStore { Analytics.store = savedStore }
        if let savedTransport { Analytics.transport = savedTransport }
        Analytics.applyRemote(key: nil, host: nil)
        UserDefaults(suiteName: suite)?.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    private func sources(remoteKey: String? = nil, remoteHost: String? = nil, plistKey: String? = nil, plistHost: String? = nil, envKey: String? = nil, envHost: String? = nil) -> Analytics.Sources {
        Analytics.Sources(remoteKey: remoteKey, remoteHost: remoteHost, plistKey: plistKey, plistHost: plistHost, envKey: envKey, envHost: envHost)
    }

    func testMissingOrMalformedKeyIsOff() {
        XCTAssertNil(Analytics.resolve(sources()))
        XCTAssertNil(Analytics.resolve(sources(plistKey: "", plistHost: "eu")))
        XCTAssertNil(Analytics.resolve(sources(plistKey: "$(POSTHOG_KEY)", plistHost: "$(POSTHOG_HOST)")))
        XCTAssertNil(Analytics.resolve(sources(plistKey: "phc_short", plistHost: "eu")))
        XCTAssertNil(Analytics.resolve(sources(plistKey: "secret_abcdefgh", plistHost: "eu")))
        XCTAssertNil(Analytics.resolve(sources(envKey: key, envHost: "https://evil.example")))
    }

    func testFirstNonEmptyKeyWins() {
        let eu = Analytics.resolve(sources(plistKey: key, plistHost: ""))
        XCTAssertEqual(eu?.region, "eu")
        XCTAssertEqual(eu?.captureURL.absoluteString, "https://eu.i.posthog.com/capture/")

        let us = Analytics.resolve(sources(plistKey: "  ", envKey: key, envHost: "us"))
        XCTAssertEqual(us?.region, "us")
        XCTAssertEqual(us?.captureURL.absoluteString, "https://us.i.posthog.com/capture/")

        let remote = Analytics.resolve(sources(remoteKey: key, remoteHost: "https://us.i.posthog.com/", plistKey: key, plistHost: "eu"))
        XCTAssertEqual(remote?.region, "us")

        // A bad remote key does not fall through to a valid plist key.
        XCTAssertNil(Analytics.resolve(sources(remoteKey: "not-a-key", remoteHost: "eu", plistKey: key, plistHost: "eu")))
        // An unresolved build setting is "unset", so the environment can still turn it on.
        XCTAssertEqual(Analytics.resolve(sources(plistKey: "$(POSTHOG_KEY)", envKey: key, envHost: "eu"))?.region, "eu")
    }

    func testCaptureDropsIdentityAndFreeText() {
        let cfg = Analytics.Config(key: key, region: "eu")
        XCTAssertNil(Analytics.captureBody(config: cfg, event: "sign_in", distinctId: "ada@example.com"))
        XCTAssertNil(Analytics.captureBody(config: cfg, event: "typed_a_message", distinctId: "11111111-1111-1111-1111-111111111111"))
        let body = Analytics.captureBody(
            config: cfg, event: "voice_used", distinctId: "11111111-1111-1111-1111-111111111111",
            props: ["email": "ada@example.com", "text": "hello there", "title": "My board", "name": "ada", "surface": "Talk", "role": "owner", "via": "email"],
            now: Date(timeIntervalSince1970: 0)
        )
        let props = body?["properties"] as? [String: String]
        XCTAssertEqual(props?["$lib"], "atteo-ios")
        XCTAssertEqual(props?["via"], "ios", "the platform token replaces anything the caller passed")
        XCTAssertEqual(props?["role"], "owner")
        XCTAssertNil(props?["surface"], "uppercase and free text are not tokens")
        XCTAssertNil(props?["email"])
        XCTAssertNil(props?["text"])
        XCTAssertNil(props?["title"])
        XCTAssertEqual(body?["event"] as? String, "voice_used")
        XCTAssertTrue((body?["timestamp"] as? String)?.hasPrefix("1970-01-01T00:00:00") == true)
        let blob = String(data: try! JSONSerialization.data(withJSONObject: body!), encoding: .utf8)!
        XCTAssertFalse(blob.contains("ada@"))
        XCTAssertFalse(blob.contains("hello"))
        XCTAssertFalse(blob.contains("My board"))
    }

    func testPlannedEventsAndNothingElse() {
        let cfg = Analytics.Config(key: key, region: "eu")
        let id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        for name in ["app_open", "screen_view", "sign_up", "sign_in", "board_created", "invite_sent", "invite_accepted", "first_message", "agent_connected", "agent_posted", "voice_used", "pro_started"] {
            XCTAssertNotNil(Analytics.captureBody(config: cfg, event: name, distinctId: id), name)
        }
        XCTAssertNil(Analytics.captureBody(config: cfg, event: "message", distinctId: id))
    }

    func testTrackIsANoOpWithoutAKeyAndWhenOptedOut() {
        let recorder = Recorder()
        Analytics.transport = recorder
        let before = recorder.sent.count
        Analytics.track("app_open")
        XCTAssertEqual(recorder.sent.count, before)
        XCTAssertNil(Analytics.store.string(forKey: Analytics.idKey), "no key: don't mint an id")

        Analytics.configProvider = { Analytics.Config(key: self.key, region: "eu") }
        Analytics.setOptedOut(true)
        Analytics.track("sign_in", ["email": "ada@example.com", "text": "secret message"])
        XCTAssertEqual(recorder.sent.count, before)
        XCTAssertNil(Analytics.store.string(forKey: Analytics.idKey))

        Analytics.setOptedOut(false)
        Analytics.track("screen_view", ["surface": "chats"])
        Analytics.track("screen_view", ["surface": "settings"])
        let screens = recorder.sent.filter { $0.1["event"] as? String == "screen_view" }
        XCTAssertEqual(screens.count, 2)
        XCTAssertEqual(screens[0].0.absoluteString, "https://eu.i.posthog.com/capture/")
        let first = screens[0].1["distinct_id"] as? String
        let second = screens[1].1["distinct_id"] as? String
        XCTAssertEqual(first, second)
        XCTAssertEqual(first?.count, 36)
        XCTAssertEqual((screens[0].1["properties"] as? [String: String])?["surface"], "chats")
        let blob = String(data: try! JSONSerialization.data(withJSONObject: screens[0].1), encoding: .utf8)!
        XCTAssertFalse(blob.contains("@"))
        XCTAssertFalse(blob.contains("secret"))

        let minted = first
        Analytics.setOptedOut(true)
        XCTAssertNil(Analytics.store.string(forKey: Analytics.idKey))
        Analytics.setOptedOut(false)
        let mark = recorder.sent.count
        Analytics.track("app_open")
        XCTAssertEqual(recorder.sent.count, mark + 1)
        let fresh = recorder.sent[mark].1["distinct_id"] as? String
        XCTAssertNotEqual(fresh, minted, "opting out forgets the id; the next event mints another")
    }
}

private final class Recorder: AnalyticsTransport {
    var sent: [(URL, [String: Any])] = []
    func send(url: URL, body: [String: Any]) { sent.append((url, body)) }
}
