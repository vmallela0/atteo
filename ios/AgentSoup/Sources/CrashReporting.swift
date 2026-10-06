// Crash reporting (vedu #4640, INFRA.md item 5): Sentry Cocoa, the same project as the Worker (src/sentry.ts).
// Off until a DSN is set — empty Info.plist / build setting, and no ATTEO_SENTRY_DSN. Never commit a real DSN
// (docs/SENTRY.md). What may go out: a crash stack, or a short kind ("json_decode", "http_5xx") with token tags.
// Never message text, emails, tokens, board contents, or Authorization headers. No user / handle. No session
// replay, no screenshots, no view hierarchy. Debug builds, unit tests and UI tests never start it unless
// ATTEO_SENTRY=1 (or ATTEO_SENTRY_DSN is set), so test runs never reach Sentry.

import Foundation
import Sentry

/// Where crash reports go: Sentry in the app, a recorder in the unit tests.
protocol CrashSink: AnyObject {
    func start(dsn: String)
    func capture(kind: String, tags: [String: String])
}

enum CrashReporting {
    /// The kinds the app may send by hand. Crashes are captured by the SDK itself once started.
    static let kinds: Set<String> = ["json_decode", "http_5xx"]

    /// Set once started; nil means reporting is off for this run and every call is a no-op.
    static var sink: CrashSink?

    /// A DSN from the scheme (`ATTEO_SENTRY_DSN`) or Info.plist (`AtteoSentryDSN` ← `SENTRY_DSN` build setting).
    static func dsn(env: String? = API.environment("SENTRY_DSN"), plist: String? = Bundle.main.object(forInfoDictionaryKey: "AtteoSentryDSN") as? String) -> String? {
        let raw = [env, plist].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty }
        guard let raw, raw.hasPrefix("https://"), raw.contains("@"), !raw.contains("YOUR_"), !raw.hasPrefix("$(") else { return nil }
        return raw
    }

    /// Starts Sentry once, at launch, only when a DSN is present. Release builds only, unless ATTEO_SENTRY=1.
    static func start(with s: CrashSink = SentrySink()) {
        guard sink == nil else { return }
        #if DEBUG
        guard API.environment("SENTRY") == "1" || API.environment("SENTRY_DSN") != nil else { return }
        #else
        guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
        #endif
        guard let dsn else { return }
        s.start(dsn: dsn)
        sink = s
    }

    /// A non-PII error: a known kind and short token tags only (status=500). Unknown kinds and messy values are dropped.
    static func capture(_ kind: String, tags: [String: String] = [:]) {
        guard let sink, kinds.contains(kind) else { return }
        var clean: [String: String] = ["surface": "ios"]
        for (k, v) in tags {
            if let k = token(k), let v = token(v) { clean[k] = v }
        }
        sink.capture(kind: kind, tags: clean)
    }

    /// A short token the way Analytics.via is: `[a-z0-9_]{1,32}`. Status codes and kinds fit; emails and paths do not.
    static func token(_ s: String) -> String? {
        s.range(of: "^[a-z0-9_]{1,32}$", options: .regularExpression) != nil ? s : nil
    }

    static func dropHeader(_ name: String) -> Bool {
        let n = name.lowercased()
        return n == "authorization" || n == "cookie" || n == "set-cookie" || n == "x-api-key"
            || n == "proxy-authorization" || n.contains("token") || n.contains("secret")
    }

    /// Extra / breadcrumb keys that are likely board contents, a person, or a credential.
    static func dropField(_ name: String) -> Bool {
        let n = name.lowercased()
        return n == "email" || n == "message" || n == "text" || n == "body" || n == "content"
            || n == "handle" || n == "username" || n == "user" || n == "authorization"
            || n == "cookie" || n == "token" || n.contains("password")
    }

    /// Strip emails, bearer tokens and JWT-shaped strings from a value the SDK already built (a crash reason, a crumb).
    static func redact(_ s: String) -> String {
        var out = s
        out = out.replacingOccurrences(of: #"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}"#, with: "[redacted]", options: [.regularExpression, .caseInsensitive])
        out = out.replacingOccurrences(of: #"(?i)\b(authorization|bearer|token)\b["'=\s:]+[^\s"'&]+"#, with: "$1 [redacted]", options: .regularExpression)
        out = out.replacingOccurrences(of: #"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+"#, with: "[redacted]", options: .regularExpression)
        return out
    }

    /// Last chance before an event leaves the phone: no user, no request bodies/cookies/auth headers, no long crumbs.
    static func scrub(_ event: Event) -> Event? {
        event.user = nil
        event.serverName = nil
        if let req = event.request {
            req.cookies = nil
            req.queryString = nil
            req.fragment = nil
            if let headers = req.headers {
                var keep: [String: String] = [:]
                for (k, v) in headers {
                    let name = k as? String ?? "\(k)"
                    guard !dropHeader(name) else { continue }
                    keep[name] = redact((v as? String) ?? "\(v)")
                }
                req.headers = keep
            }
        }
        if let extras = event.extra {
            var keep: [String: Any] = [:]
            for (k, v) in extras where !dropField(k) {
                if let s = v as? String { keep[k] = redact(s) }
                else if v is NSNumber { keep[k] = v }
            }
            event.extra = keep
        }
        if var ctx = event.context {
            ctx.removeValue(forKey: "user")
            event.context = ctx
        }
        if let formatted = event.message?.formatted {
            event.message = SentryMessage(formatted: redact(formatted))
        }
        event.exceptions?.forEach { if let v = $0.value { $0.value = redact(v) } }
        if let crumbs = event.breadcrumbs { event.breadcrumbs = crumbs.compactMap(scrub) }
        return event
    }

    static func scrub(_ crumb: Breadcrumb) -> Breadcrumb? {
        if let m = crumb.message {
            if m.count > 80 { crumb.message = nil } else { crumb.message = redact(m) }
        }
        if let data = crumb.data {
            for (k, v) in data {
                let name = k as? String ?? "\(k)"
                if dropHeader(name) || dropField(name) { crumb.setData(value: nil, key: name); continue }
                if let s = v as? String {
                    crumb.setData(value: s.count > 80 ? nil : redact(s), key: name)
                } else if !(v is NSNumber) {
                    crumb.setData(value: nil, key: name)
                }
            }
        }
        return crumb
    }
}

/// Sentry's iOS SDK, set up for crashes and a few token errors only.
final class SentrySink: CrashSink {
    func start(dsn: String) {
        SentrySDK.start { options in
            options.dsn = dsn
            options.sendDefaultPii = false
            options.attachScreenshot = false
            options.attachViewHierarchy = false
            options.enableCaptureFailedRequests = false
            options.enableAutoPerformanceTracing = false
            options.enableNetworkTracking = false
            options.enableNetworkBreadcrumbs = false
            options.tracesSampleRate = 0
            options.sessionReplay.sessionSampleRate = 0
            options.sessionReplay.onErrorSampleRate = 0
            options.beforeCaptureScreenshot = { _ in false }
            options.beforeCaptureViewHierarchy = { _ in false }
            options.beforeSend = { CrashReporting.scrub($0) }
            options.beforeBreadcrumb = { CrashReporting.scrub($0) }
        }
        SentrySDK.setUser(nil)
    }

    func capture(kind: String, tags: [String: String]) {
        let event = Event(level: .error)
        event.message = SentryMessage(formatted: kind)
        event.tags = tags
        event.fingerprint = [kind]
        SentrySDK.capture(event: event)
    }
}
