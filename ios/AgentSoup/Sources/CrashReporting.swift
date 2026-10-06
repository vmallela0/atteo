// Optional crash reporting (vedu #4640). No DSN or analytics opt-out means no SDK startup.
// Only fixed error kinds / native stack addresses, a fixed screen name, app version and OS may leave the phone.
// See docs/SENTRY.md. Never pass an Error's description, an API payload, or arbitrary tags to this interface.

import Foundation
import Sentry

protocol CrashSink: AnyObject {
    func start(dsn: String)
    func stop()
    func screen(_ name: String)
    func capture(kind: String)
}

enum CrashReporting {
    static let kinds: Set<String> = ["json_decode", "http_5xx"]
    static let screens: Set<String> = ["for_you", "chats", "board", "ask", "talk", "settings"]

    // API callbacks and Settings can run on different executors. All sink access, including lifecycle calls,
    // is serialized by this lock. beforeSend only reads UserDefaults and the event, never this locked state.
    private final class State: @unchecked Sendable {
        let lock = NSRecursiveLock()
        var sink: CrashSink?
    }
    private static let state = State()
    static var sink: CrashSink? {
        get { state.lock.withLock { state.sink } }
        set { state.lock.withLock { state.sink = newValue } }
    }
    static var enabled: Bool { UserDefaults.standard.object(forKey: Analytics.key) as? Bool ?? true }

    static func dsn(env: String? = API.environment("SENTRY_DSN"), plist: String? = Bundle.main.object(forInfoDictionaryKey: "AtteoSentryDSN") as? String) -> String? {
        let raw = [env, plist].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty }
        guard let raw, !raw.contains("YOUR_"), !raw.contains("$("),
              let url = URLComponents(string: raw), url.scheme == "https",
              let host = url.host, !host.isEmpty, let key = url.user, !key.isEmpty,
              url.password == nil, url.query == nil, url.fragment == nil,
              url.path.split(separator: "/").last?.allSatisfy({ $0.isASCII && $0.isNumber }) == true else { return nil }
        return raw
    }

    /// Release only, unless explicitly enabled in a debug scheme. Consent is checked before SDK startup,
    /// because startup can immediately send a crash saved on the previous launch.
    static func start(with s: CrashSink = SentrySink()) {
        state.lock.withLock {
            guard enabled else { stop(); return }
            guard state.sink == nil else { return }
            #if DEBUG
            guard API.environment("SENTRY") == "1" || API.environment("SENTRY_DSN") != nil else { return }
            #else
            guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
            #endif
            guard let configuredDSN = dsn() else { return }
            s.start(dsn: configuredDSN)
            state.sink = s
        }
    }

    static func stop() {
        state.lock.withLock {
            state.sink?.stop()
            state.sink = nil
            SentrySink.discardCachedReports()
        }
    }

    static func consentChanged() {
        if enabled { start() } else { stop() }
    }

    static func capture(_ kind: String) {
        state.lock.withLock {
            guard enabled, kinds.contains(kind) else { return }
            state.sink?.capture(kind: kind)
        }
    }

    static func screen(_ name: String) {
        state.lock.withLock {
            guard enabled, screens.contains(name) else { return }
            state.sink?.screen(name)
        }
    }

    private static func matching(_ value: String?, _ pattern: String) -> String? {
        guard let value, value.range(of: pattern, options: .regularExpression) != nil else { return nil }
        return value
    }

    private static func address(_ value: String?) -> String? { matching(value, "^0x[0-9a-fA-F]{1,16}$") }
    private static func version(_ value: String?) -> String? { matching(value, "^[0-9]+(?:\\.[0-9]+){0,3}$") }

    static var releaseName: String {
        let appVersion = version(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0"
        let build = self.version(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? "0"
        return "Atteo@\(appVersion)+\(build)"
    }

    /// Rebuild the event from an allowlist. Regex redaction of free text cannot reliably remove names,
    /// handles, messages or nested PII. Stack addresses and binary UUIDs retain server-side symbolication;
    /// source paths, symbols, local variables, registers and exception descriptions are deliberately omitted.
    static func scrub(_ event: Event) -> Event? {
        guard enabled, event.type == nil || event.type == "error" || event.type == "default" else { return nil }
        let clean = Event(level: event.level)
        clean.eventId = event.eventId
        clean.timestamp = event.timestamp
        clean.platform = "cocoa"
        clean.releaseName = matching(event.releaseName, "^Atteo@[0-9.]+\\+[0-9.]+$") ?? releaseName
        // Cocoa otherwise asks the server to infer the connection IP even with sendDefaultPii=false.
        clean.sdk = ["name": "sentry.cocoa", "settings": ["infer_ip": "never"]]
        if let screen = event.tags?["screen"], screens.contains(screen) { clean.tags = ["screen": screen] }
        let os = ProcessInfo.processInfo.operatingSystemVersion
        let osVersion = version(event.context?["os"]?["version"] as? String) ?? "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
        clean.context = ["os": ["name": "iOS", "version": osVersion]]
        if let kind = event.message?.formatted, kinds.contains(kind) {
            clean.exceptions = [Exception(value: nil, type: kind)]
            clean.fingerprint = [kind]
        } else if let exceptions = event.exceptions, !exceptions.isEmpty {
            let nativeTypes: Set<String> = ["EXC_BAD_ACCESS", "EXC_BAD_INSTRUCTION", "EXC_ARITHMETIC", "EXC_BREAKPOINT",
                                           "EXC_CRASH", "SIGABRT", "SIGBUS", "SIGFPE", "SIGILL", "SIGSEGV", "SIGTRAP",
                                           "NSInvalidArgumentException", "NSRangeException", "NSInternalInconsistencyException"]
            clean.exceptions = exceptions.map { exception in
                let type = exception.type.flatMap { nativeTypes.contains($0) ? $0 : nil } ?? "native_crash"
                let result = Exception(value: nil, type: type)
                let mechanism = Mechanism(type: "generic")
                mechanism.handled = NSNumber(value: exception.mechanism?.handled?.boolValue ?? (event.level != .fatal))
                result.mechanism = mechanism
                result.stacktrace = exception.stacktrace.map(scrubStack)
                return result
            }
            clean.stacktrace = event.stacktrace.map(scrubStack)
            clean.debugMeta = event.debugMeta?.compactMap { image in
                guard let id = image.debugID, let uuid = UUID(uuidString: id),
                      let imageAddress = address(image.imageAddress) else { return nil }
                let result = DebugMeta()
                result.type = "macho"
                result.debugID = uuid.uuidString
                result.imageAddress = imageAddress
                result.imageVmAddress = self.address(image.imageVmAddress)
                result.imageSize = image.imageSize
                return result
            }
        } else {
            return nil // no arbitrary messages, feedback, or unknown SDK event types
        }
        return clean
    }

    private static func scrubStack(_ stack: SentryStacktrace) -> SentryStacktrace {
        let frames: [Frame] = stack.frames.compactMap { frame in
            guard let instruction = address(frame.instructionAddress) else { return nil }
            let result = Frame()
            result.instructionAddress = instruction
            result.imageAddress = address(frame.imageAddress)
            result.symbolAddress = address(frame.symbolAddress)
            result.inApp = frame.inApp
            return result
        }
        return SentryStacktrace(frames: frames, registers: [:])
    }
}

final class SentrySink: CrashSink {
    private var options: Options?
    private var session: URLSession?
    private static let cacheKey = "crash-report-cache-generation"
    private static var cacheRoot: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("AtteoCrashReports", isDirectory: true)
    }
    static func discardCachedReports() {
        // A new directory prevents late writes from an old SDK transport from being replayed after opt-in.
        UserDefaults.standard.set(UUID().uuidString, forKey: cacheKey)
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    func start(dsn: String) {
        let options = Options()
        options.dsn = dsn
        options.releaseName = CrashReporting.releaseName
        options.sendDefaultPii = false
        options.enableMemoryIntrospection = false
        options.attachScreenshot = false
        options.attachViewHierarchy = false
        options.maxAttachmentSize = 0
        options.enableCaptureFailedRequests = false
        options.enableAutoPerformanceTracing = false
        options.enableNetworkTracking = false
        options.enableNetworkBreadcrumbs = false
        options.enableAutoBreadcrumbTracking = false
        options.enableSwizzling = false
        options.enableAutoSessionTracking = false
        options.enableAppHangTracking = false
        options.enableWatchdogTerminationTracking = false
        options.enableMetricKit = false
        options.sendClientReports = false
        options.maxBreadcrumbs = 0
        options.tracesSampleRate = 0
        options.sessionReplay.sessionSampleRate = 0
        options.sessionReplay.onErrorSampleRate = 0
        options.beforeSendLog = { _ in nil }
        options.beforeSend = { CrashReporting.scrub($0) }
        options.beforeBreadcrumb = { _ in nil }
        options.shutdownTimeInterval = 0
        let generation = UserDefaults.standard.string(forKey: Self.cacheKey) ?? "initial"
        options.cacheDirectoryPath = Self.cacheRoot.appendingPathComponent(generation, isDirectory: true).path
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        let session = URLSession(configuration: config)
        options.urlSession = session
        self.session = session
        self.options = options
        SentrySDK.start(options: options)
        SentrySDK.setUser(nil)
    }

    func stop() {
        options?.enabled = false
        session?.invalidateAndCancel() // cancel queued uploads before close (which normally flushes)
        SentrySDK.close()
        options = nil
        session = nil
    }

    func screen(_ name: String) { SentrySDK.configureScope { $0.setTag(value: name, key: "screen") } }

    func capture(kind: String) {
        let event = Event(level: .error)
        event.message = SentryMessage(formatted: kind) // replaced by a fixed exception type in beforeSend
        SentrySDK.capture(event: event)
    }
}
