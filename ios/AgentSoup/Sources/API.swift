// The Atteo JSON API, as the person (an "app" token from signing in). Writes carry an Idempotency-Key and retry
// through dropped connections and server restarts, so a message is stored once however many tries reach the server
// (the same contract as the web composer: writes never fail).

import Foundation

enum APIError: LocalizedError {
    case signedOut
    case server(String)
    case offline

    var errorDescription: String? {
        switch self {
        case .signedOut: return String(localized: "You're signed out.", bundle: .l10n)
        case .server(let m): return m
        case .offline: return String(localized: "Couldn't reach Atteo. Check your connection.", bundle: .l10n)
        }
    }
}

final class API: @unchecked Sendable {
    static let shared = API()

    /// Old names still work for existing simulator scripts and developer setups.
    static func environment(_ name: String) -> String? {
        ProcessInfo.processInfo.environment["ATTEO_\(name)"] ?? ProcessInfo.processInfo.environment["AGENT_SOUP_\(name)"]
    }

    /// The server: production, or ATTEO_SERVER in debug runs (the simulator against a local server).
    let base: URL = {
        #if DEBUG
        if let s = API.environment("SERVER"), let u = URL(string: s) { return u }
        #endif
        return URL(string: "https://agent-board.vedu-mallela.workers.dev")!
    }()

    /// The address people and other assistants are given (connect messages, shared links): Atteo's public name,
    /// atteo.dev, which reaches the same server. Debug runs against another server keep that server's address.
    var publicBase: URL {
        base.host == "agent-board.vedu-mallela.workers.dev" ? URL(string: "https://atteo.dev")! : base
    }

    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 35
        c.waitsForConnectivity = false
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.httpAdditionalHeaders = ["user-agent": "Atteo-iOS"]
        return URLSession(configuration: c)
    }()

    var token: String? { Keychain.token }

    /// A board's live socket (the same one the web page uses): it says when a message lands or a task changes.
    func socket(board: String) -> URLSessionWebSocketTask? {
        guard let token, var c = URLComponents(url: base.appendingPathComponent("api/boards/\(board)/ws"), resolvingAgainstBaseURL: false) else { return nil }
        c.scheme = c.scheme == "http" ? "ws" : "wss"
        guard let url = c.url else { return nil }
        var r = URLRequest(url: url)
        r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        return session.webSocketTask(with: r)
    }

    private func request(_ method: String, _ path: String, body: Any? = nil, idempotencyKey: String? = nil, timeout: TimeInterval? = nil) throws -> URLRequest {
        guard let token else { throw APIError.signedOut }
        var r = URLRequest(url: URL(string: path, relativeTo: base)!)
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        if let idempotencyKey { r.setValue(idempotencyKey, forHTTPHeaderField: "idempotency-key") }
        if let timeout { r.timeoutInterval = timeout }
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return r
    }

    private func check(_ data: Data, _ resp: URLResponse) throws -> Data {
        guard let http = resp as? HTTPURLResponse else { throw APIError.offline }
        if http.statusCode == 401 {
            Keychain.token = nil
            Task { @MainActor in AppState.shared.signedIn = false }
            throw APIError.signedOut
        }
        if !(200..<300).contains(http.statusCode) {
            // Crash reporting: a fixed error kind only; never the server message or body.
            if http.statusCode >= 500 { CrashReporting.capture("http_5xx") }
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw APIError.server(msg ?? String(localized: "Something went wrong (\(http.statusCode)).", bundle: .l10n))
        }
        return data
    }

    func get<T: Decodable>(_ path: String, as: T.Type, timeout: TimeInterval? = nil) async throws -> T {
        let waits: [UInt64] = [300, 1000] // 0.3s, 1s backoff (vedu #4845)
        var attempt = 0
        while true {
            let r = try request("GET", path, timeout: timeout)
            let (data, resp): (Data, URLResponse)
            do { (data, resp) = try await session.data(for: r) } catch { throw APIError.offline }
            do {
                return try JSONDecoder.soup.decode(T.self, from: check(data, resp))
            } catch let e as APIError {
                // Retry transient Cloudflare errors on GET requests (vedu #4845)
                if case .server(let msg) = e,
                   attempt < waits.count,
                   isTransientServerError(msg) {
                    try await Task.sleep(nanoseconds: waits[attempt] * 1_000_000); attempt += 1; continue
                }
                throw e
            } catch {
                if error is DecodingError { CrashReporting.capture("json_decode") } // kind only; never the payload
                throw error
            }
        }
    }

    /// Uploads raw bytes (a picture, a file). Not retried: the person is watching and can tap again.
    /// `progress` hears how much has gone up (0…1) as it sends.
    @discardableResult
    func upload(_ path: String, data: Data, contentType: String, method: String = "POST", progress: (@Sendable (Double) -> Void)? = nil) async throws -> Data {
        guard let token else { throw APIError.signedOut }
        var r = URLRequest(url: URL(string: path, relativeTo: base)!)
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        r.setValue(contentType, forHTTPHeaderField: "content-type")
        r.timeoutInterval = 120
        let (d, resp): (Data, URLResponse)
        do { (d, resp) = try await session.upload(for: r, from: data, delegate: progress.map(UploadProgress.init)) } catch { throw APIError.offline }
        return try check(d, resp)
    }

    /// Bytes the server keeps for you (a picture or file on a board), as you.
    func download(_ path: String) async throws -> Data {
        let r = try request("GET", path, timeout: 60)
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await session.data(for: r) } catch { throw APIError.offline }
        return try check(data, resp)
    }

    /// One POST of a ready body (multipart, say) with no retries, answering with the status and body as they came (a 401
    /// still signs you out): for callers that tell the server's answers apart themselves (Report a bug: 501 means the
    /// server has no bug board).
    func post(_ path: String, body: Data, contentType: String) async throws -> (status: Int, data: Data) {
        var r = try request("POST", path, idempotencyKey: UUID().uuidString, timeout: 30)
        r.setValue(contentType, forHTTPHeaderField: "content-type")
        r.httpBody = body
        let data: Data, resp: URLResponse
        do { (data, resp) = try await session.data(for: r) } catch { throw APIError.offline }
        guard let http = resp as? HTTPURLResponse else { throw APIError.offline }
        if http.statusCode == 401 { _ = try check(data, resp) }
        return (http.statusCode, data)
    }

    /// A write. Safe to retry (Idempotency-Key): network errors, 408, 429 and 5xx are retried for about two minutes.
    @discardableResult
    func send(_ path: String, method: String = "POST", body: Any? = [String: Any](), retries: Bool = true) async throws -> Data {
        let key = UUID().uuidString
        let waits: [UInt64] = retries ? [500, 1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000] : []
        var attempt = 0
        while true {
            let r = try request(method, path, body: body, idempotencyKey: key)
            do {
                let (data, resp) = try await session.data(for: r)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                if code == 408 || code == 429 || code >= 500, attempt < waits.count {
                    try await Task.sleep(nanoseconds: waits[attempt] * 1_000_000); attempt += 1; continue
                }
                return try check(data, resp)
            } catch let e as APIError {
                throw e
            } catch {
                guard attempt < waits.count else { throw APIError.offline }
                try await Task.sleep(nanoseconds: waits[attempt] * 1_000_000); attempt += 1
            }
        }
    }
}

/// A multipart/form-data body: plain fields, then files (each with its own fields after it, in order).
struct Multipart {
    let boundary = "atteo-" + UUID().uuidString
    private(set) var body = Data()
    var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    mutating func field(_ name: String, _ value: String) {
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
    }
    mutating func file(_ name: String, filename: String, mime: String, data: Data) {
        let safe = filename.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "")
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(safe)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n".utf8))
    }
    mutating func finish() -> Data {
        body.append(Data("--\(boundary)--\r\n".utf8))
        return body
    }
}

/// Reports an upload's progress as its body goes out.
private final class UploadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let report: @Sendable (Double) -> Void
    init(_ report: @escaping @Sendable (Double) -> Void) { self.report = report }
    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData _: Int64, totalBytesSent sent: Int64, totalBytesExpectedToSend total: Int64) {
        if total > 0 { report(Double(sent) / Double(total)) }
    }
}

extension JSONDecoder {
    static let soup: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()
}

/// Cloudflare's passing errors (a deploy restarting a board, a dropped database link): worth one more try, and never shown raw (vedu #4845).
func isTransientServerError(_ message: String) -> Bool {
    message.range(of: #"internal error; reference =|reset because its code was updated|Network connection lost|D1_ERROR"#, options: [.regularExpression, .caseInsensitive]) != nil
}
