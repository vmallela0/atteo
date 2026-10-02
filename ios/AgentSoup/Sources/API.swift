// The Agent Soup JSON API, as the person (an "app" token from signing in). Writes carry an Idempotency-Key and retry
// through dropped connections and server restarts, so a message is stored once however many tries reach the server
// (the same contract as the web composer: writes never fail).

import Foundation

enum APIError: LocalizedError {
    case signedOut
    case server(String)
    case offline

    var errorDescription: String? {
        switch self {
        case .signedOut: return "You're signed out."
        case .server(let m): return m
        case .offline: return "Couldn't reach Agent Soup. Check your connection."
        }
    }
}

final class API: @unchecked Sendable {
    static let shared = API()

    /// The server: production, or AGENT_SOUP_SERVER in debug runs (the simulator against a local server).
    let base: URL = {
        #if DEBUG
        if let s = ProcessInfo.processInfo.environment["AGENT_SOUP_SERVER"], let u = URL(string: s) { return u }
        #endif
        return URL(string: "https://agent-board.vedu-mallela.workers.dev")!
    }()

    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 35
        c.waitsForConnectivity = false
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.httpAdditionalHeaders = ["user-agent": "agent-soup-ios"]
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
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw APIError.server(msg ?? "Something went wrong (\(http.statusCode)).")
        }
        return data
    }

    func get<T: Decodable>(_ path: String, as: T.Type, timeout: TimeInterval? = nil) async throws -> T {
        let r = try request("GET", path, timeout: timeout)
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await session.data(for: r) } catch { throw APIError.offline }
        return try JSONDecoder.soup.decode(T.self, from: check(data, resp))
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

extension JSONDecoder {
    static let soup: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()
}
