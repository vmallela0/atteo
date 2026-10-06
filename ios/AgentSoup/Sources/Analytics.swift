// Product analytics (iOS). A thin PostHog capture client, the same event plan as the web loader
// (docs/ANALYTICS.md). It does nothing until a phc_ project key is configured: Info.plist (a build setting),
// the process environment, or a remote-config value passed to applyRemote. No key, a bad key, or any host
// other than eu/us: no request.
//
// The payload is an allowlist. It never includes message text, emails, names, or board titles. The distinct
// id is a random id kept on this phone (atteo.phid), not the person's handle. Settings → Opt out of analytics
// stops capture and deletes that id.

import Foundation
import SwiftUI

enum Analytics {
    /// Events the app may record. Anything else is dropped. invite_accepted and pro_started are in the plan;
    /// this app has no invitation-accept screen and no checkout return, so nothing fires them.
    static let events: Set<String> = [
        "app_open", "screen_view",
        "sign_up", "sign_in", "board_created", "invite_sent", "invite_accepted",
        "first_message", "agent_connected", "agent_posted", "voice_used", "pro_started",
    ]

    /// Property names a caller may attach. Values are short tokens. `via` is set here to `ios`.
    static let propKeys: Set<String> = ["surface", "role", "interval", "via"]

    static let optOutKey = "analytics-opt-out"
    static let idKey = "atteo.phid"

    static let hosts = [
        "eu": "https://eu.i.posthog.com",
        "us": "https://us.i.posthog.com",
    ]

    struct Config: Equatable {
        let key: String
        let region: String
        /// `https://eu.i.posthog.com/capture/` or the US host. The trailing slash matches the web loader.
        var captureURL: URL { URL(string: hosts[region]! + "/capture/")! }
    }

    /// Where a key was read from. The first layer with a non-empty key decides; an invalid key turns analytics off.
    struct Sources {
        var remoteKey: String?
        var remoteHost: String?
        var plistKey: String?
        var plistHost: String?
        var envKey: String?
        var envHost: String?
    }

    private static let keyPattern = try! NSRegularExpression(pattern: "^phc_[A-Za-z0-9_]{8,200}$")
    private static let idPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9-]{8,80}$")
    private static let propPattern = try! NSRegularExpression(pattern: "^[a-z0-9_]{1,32}$")

    /// Tests replace these. Production uses the live config, standard defaults, and an ephemeral POST.
    static var configProvider: () -> Config? = { Analytics.liveConfig() }
    static var store: UserDefaults = .standard
    static var transport: AnalyticsTransport = LiveTransport()

    private static var remoteKey: String?
    private static var remoteHost: String?

    /// A remote-config payload's project key, if one is ever delivered. Empty clears that layer.
    /// Not persisted: call again on launch. Nothing in the app calls this until a config source exists.
    static func applyRemote(key: String?, host: String?) {
        let k = key?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        remoteKey = k.isEmpty ? nil : k
        remoteHost = host
    }

    /// Info.plist, else the environment, with a remote key ahead of both when one was applied.
    static func liveConfig() -> Config? {
        let info = Bundle.main.infoDictionary
        return resolve(Sources(
            remoteKey: remoteKey, remoteHost: remoteHost,
            plistKey: info?["POSTHOG_KEY"] as? String, plistHost: info?["POSTHOG_HOST"] as? String,
            envKey: API.environment("POSTHOG_KEY"), envHost: API.environment("POSTHOG_HOST")
        ))
    }

    /// Null when every layer is empty, or when the first non-empty key isn't a phc_ project key or the host isn't eu/us.
    static func resolve(_ sources: Sources) -> Config? {
        let layers: [(String?, String?)] = [
            (sources.remoteKey, sources.remoteHost),
            (sources.plistKey, sources.plistHost),
            (sources.envKey, sources.envHost),
        ]
        for (rawKey, rawHost) in layers {
            let key = (rawKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if key.isEmpty || key.contains("$(") { continue }
            guard matches(keyPattern, key) else { return nil }
            guard let region = region(rawHost) else { return nil }
            return Config(key: key, region: region)
        }
        return nil
    }

    static func region(_ raw: String?) -> String? {
        let s = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if s.isEmpty || s == "eu" || s == hosts["eu"] { return "eu" }
        if s == "us" || s == hosts["us"] { return "us" }
        return nil
    }

    /// Keep only allowlisted token properties. Emails, message text, titles, and unknown keys are dropped.
    static func sanitize(_ props: [String: String]?) -> [String: String] {
        var out: [String: String] = [:]
        guard let props else { return out }
        for key in propKeys.sorted() {
            guard let v = props[key], matches(propPattern, v) else { continue }
            out[key] = v
        }
        return out
    }

    /// One capture body, or nil when the event isn't in the plan or the distinct id isn't an anonymous token.
    static func captureBody(config: Config, event: String, distinctId: String, props: [String: String]? = nil, now: Date = Date()) -> [String: Any]? {
        guard events.contains(event), matches(idPattern, distinctId) else { return nil }
        var properties = sanitize(props)
        properties["$lib"] = "atteo-ios"
        properties["via"] = "ios"
        return [
            "api_key": config.key,
            "event": event,
            "distinct_id": distinctId,
            "properties": properties,
            "timestamp": stamp(now),
        ]
    }

    /// `2026-10-06T03:00:00.000Z`. A new formatter each call: the shared one isn't safe to use from two queues.
    private static func stamp(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(secondsFromGMT: 0)
        return f.string(from: date)
    }

    static var optedOut: Bool { store.bool(forKey: optOutKey) }

    /// Stops capture and deletes the phone's analytics id. Turning it back on mints a new id on the next event.
    static func setOptedOut(_ out: Bool) {
        store.set(out, forKey: optOutKey)
        if out { clearIdentity() }
    }

    static func clearIdentity() {
        store.removeObject(forKey: idKey)
    }

    /// The phone's random id, created on first use. Nil when analytics is opted out.
    static func distinctId(make: () -> String = { UUID().uuidString }) -> String? {
        if optedOut { return nil }
        if let existing = store.string(forKey: idKey), matches(idPattern, existing) { return existing }
        let made = make()
        guard matches(idPattern, made) else { return nil }
        store.set(made, forKey: idKey)
        return made
    }

    /// Record one planned event. No-op without a valid key, when opted out, or when the name isn't in the plan.
    /// `props` is filtered; do not pass message text, emails, names, or titles (they are dropped anyway).
    static func track(_ event: String, _ props: [String: String] = [:]) {
        guard let config = configProvider(), let id = distinctId(), let body = captureBody(config: config, event: event, distinctId: id, props: props) else { return }
        transport.send(url: config.captureURL, body: body)
    }

    /// A board tab's screen token. Chat is `board`; the other two name the tab. Never the board's title.
    static func boardSurface(_ tab: BoardTab) -> String {
        switch tab {
        case .chat: return "board"
        case .tasks: return "board_tasks"
        case .files: return "board_files"
        }
    }

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        let range = NSRange(s.startIndex..., in: s)
        return re.firstMatch(in: s, range: range)?.range == range
    }
}

protocol AnalyticsTransport: AnyObject {
    func send(url: URL, body: [String: Any])
}

/// POSTs the capture body and ignores the result. Ephemeral: no cookies, no cache.
final class LiveTransport: AnalyticsTransport {
    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieAcceptPolicy = .never
        c.httpShouldSetCookies = false
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.timeoutIntervalForRequest = 15
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    func send(url: URL, body: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(body), let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "content-type")
        r.httpBody = data
        r.httpShouldHandleCookies = false
        session.dataTask(with: r) { _, _, _ in }.resume()
    }
}

extension View {
    /// A screen view when this view appears. `name` is a short token (`chats`, `settings`), never a title.
    func analyticsScreen(_ name: String) -> some View {
        onAppear { Analytics.track("screen_view", ["surface": name]) }
    }
}

/// Settings → Opt out of analytics, on both Settings screens (Everyday and Developer).
struct AnalyticsOptOut: View {
    @AppStorage(Analytics.optOutKey) private var optedOut = false

    var body: some View {
        Section {
            Toggle("Opt out of analytics", isOn: Binding(
                get: { optedOut },
                set: { on in
                    Analytics.setOptedOut(on)
                    optedOut = on
                }
            ))
                .tint(Theme.accent)
                .accessibilityIdentifier("analytics-opt-out")
        } header: { SectionHeader("Analytics") } footer: {
            Text("Turn on to stop analytics on this phone and delete its random id. Messages, emails, names, and chat titles are never sent. Nothing is sent at all until a project key is configured.")
        }
        .listRowBackground(Theme.card)
    }
}
