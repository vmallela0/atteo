// Product analytics (vedu #4416, #4602): PostHog, the same small event set as the web (src/analytics.ts). The project
// key is public (it can only record events). Nothing here sends message text, emails or names: events carry only
// short tokens (surface, via), and a person is identified by their handle. No session replay, no autocapture, no
// screenshots. Settings → Safety and privacy → "Share usage analytics" (on by default) opts this phone in or out.
// Debug builds, unit tests and UI tests never start it unless ATTEO_ANALYTICS=1, so test runs never reach PostHog.

import Foundation
import PostHog

/// Where events go: PostHog in the app, a recorder in the unit tests.
protocol AnalyticsSink: AnyObject {
    func start(key: String, host: String, optedOut: Bool)
    func capture(_ event: String, properties: [String: Any])
    func screen(_ name: String)
    func identify(_ id: String)
    func reset()
    func optIn()
    func optOut()
}

enum Analytics {
    static let key = "share-usage-analytics"
    static let projectKey = "phc_wmSGccJEcjikTZXeXaReyTKJXxFKDXVifqBE8QpQdQy2" // public, write-only (Muse #4509)
    static let host = "https://us.i.posthog.com"

    /// The events the app may record: the web's list (src/analytics.ts ANALYTICS_EVENTS). Anything else is dropped.
    static let events: Set<String> = [
        "sign_up", "sign_in", "board_created", "invite_sent", "invite_accepted", "first_message",
        "agent_connected", "agent_posted", "voice_used", "pro_started",
    ]

    /// The person's choice for this phone; on until they turn it off.
    static var enabled: Bool {
        get { UserDefaults.standard.object(forKey: key) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    /// Set once started; nil means analytics is off for this run (debug, tests) and every call is a no-op.
    static var sink: AnalyticsSink?

    /// Starts PostHog once, at launch. Release builds only, unless ATTEO_ANALYTICS=1.
    static func start(with s: AnalyticsSink = PostHogSink()) {
        guard sink == nil else { return }
        #if DEBUG
        guard API.environment("ANALYTICS") == "1" else { return }
        #else
        guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
        #endif
        s.start(key: projectKey, host: host, optedOut: !enabled)
        sink = s
    }

    /// The Settings toggle: saved here and applied to PostHog at once.
    static func setEnabled(_ on: Bool) {
        enabled = on
        if on { sink?.optIn() } else { sink?.optOut() }
    }

    static func capture(_ event: String, via: String? = nil) {
        guard enabled, events.contains(event), let sink else { return }
        var p: [String: Any] = ["surface": "ios"]
        if let via, via.range(of: "^[a-z0-9_]{1,32}$", options: .regularExpression) != nil { p["via"] = via }
        sink.capture(event, properties: p)
    }

    /// A screen by a short fixed name ("chats", "board", "settings"), never a board title or a person.
    static func screen(_ name: String) {
        guard enabled, let sink else { return }
        sink.screen(name)
    }

    /// Ties this phone's events to the person's handle (no email, no display name).
    static func identify(_ handle: String?) {
        guard let handle, !handle.isEmpty, let sink else { return }
        sink.identify(handle)
    }

    /// Signing out: the next person on this phone starts anonymous.
    static func reset() { sink?.reset() }

    // MARK: - Events that need a little memory

    /// A person's first message from this phone (once per account), like the web's first_message.
    static func messageSent(by handle: String?) {
        guard let handle, !handle.isEmpty else { return }
        let k = "analytics-first-message-\(handle.lowercased())"
        guard !UserDefaults.standard.bool(forKey: k) else { return }
        UserDefaults.standard.set(true, forKey: k)
        capture("first_message")
    }

    /// The person's connected agents went up since this phone last looked (the first look only remembers the count).
    static func sessionsSeen(_ count: Int, for handle: String) {
        let k = "analytics-sessions-seen-\(handle.lowercased())" // per person: signing out and back in isn't a new agent
        let before = UserDefaults.standard.object(forKey: k) as? Int
        UserDefaults.standard.set(count, forKey: k)
        if let before, count > before { capture("agent_connected") }
    }
}

/// PostHog's iOS SDK, set up for product analytics only.
final class PostHogSink: AnalyticsSink {
    func start(key: String, host: String, optedOut: Bool) {
        let config = PostHogConfig(apiKey: key, host: host)
        config.captureApplicationLifecycleEvents = true // app opened / backgrounded
        config.captureScreenViews = false // SwiftUI screens are named by hand (Analytics.screen)
        config.captureElementInteractions = false
        config.sessionReplay = false
        config.preloadFeatureFlags = false
        config.sendFeatureFlagEvent = false
        config.personProfiles = .identifiedOnly
        config.optOut = optedOut
        PostHogSDK.shared.setup(config)
    }
    func capture(_ event: String, properties: [String: Any]) { PostHogSDK.shared.capture(event, properties: properties) }
    func screen(_ name: String) { PostHogSDK.shared.screen(name) }
    func identify(_ id: String) { PostHogSDK.shared.identify(id) }
    func reset() { PostHogSDK.shared.reset() }
    func optIn() { PostHogSDK.shared.optIn() }
    func optOut() { PostHogSDK.shared.optOut() }
}
