// Signing in: the app registers itself (OAuth dynamic registration), opens the browser sheet to Agent Soup's sign-in
// with scope=person (PKCE), and keeps the resulting token in the Keychain. The server only grants scope=person to
// the app's own agentsoup:// link, and shows "Sign in to the Agent Soup app as <you>?" so it can't be mistaken for an
// agent connection.

import AuthenticationServices
import CryptoKit
import Foundation
import Security
import UIKit

enum Keychain {
    private static let service = "com.agentsoup.app"
    private static let account = "token"

    static var token: String? {
        get {
            var out: AnyObject?
            let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true]
            guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
            return String(data: d, encoding: .utf8)
        }
        set {
            let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
            SecItemDelete(q as CFDictionary)
            guard let v = newValue else { return }
            var add = q
            add[kSecValueData as String] = Data(v.utf8)
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    /// Other secrets this phone keeps (its device key for encrypted boards); this device only, never synced.
    static func data(_ account: String) -> Data? {
        var out: AnyObject?
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true]
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    static func setData(_ d: Data, for account: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(q as CFDictionary)
        var add = q
        add[kSecValueData as String] = d
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}

@MainActor
final class SignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private static let redirect = "agentsoup://auth"
    private var session: ASWebAuthenticationSession?

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
    }

    func start() async throws {
        let base = API.shared.base
        // 1. Register (once per install).
        var clientId = UserDefaults.standard.string(forKey: "oauth_client_id")
        if clientId == nil {
            var r = URLRequest(url: base.appendingPathComponent("oauth/register"))
            r.httpMethod = "POST"
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.httpBody = try JSONSerialization.data(withJSONObject: ["client_name": "Agent Soup for iOS", "redirect_uris": [Self.redirect]])
            let (data, _) = try await URLSession.shared.data(for: r)
            clientId = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["client_id"] as? String
            guard let clientId else { throw APIError.server("Couldn't register the app with Agent Soup.") }
            UserDefaults.standard.set(clientId, forKey: "oauth_client_id")
        }
        // 2. PKCE + the browser sheet.
        let verifier = Data((0..<32).map { _ in UInt8.random(in: 0...255) }).base64URL
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URL
        let state = UUID().uuidString
        var c = URLComponents(url: base.appendingPathComponent("oauth/authorize"), resolvingAgainstBaseURL: false)!
        c.queryItems = [
            .init(name: "response_type", value: "code"), .init(name: "client_id", value: clientId),
            .init(name: "redirect_uri", value: Self.redirect), .init(name: "code_challenge", value: challenge),
            .init(name: "code_challenge_method", value: "S256"), .init(name: "scope", value: "person"), .init(name: "state", value: state),
        ]
        let callback: URL = try await withCheckedThrowingContinuation { cont in
            let s = ASWebAuthenticationSession(url: c.url!, callbackURLScheme: "agentsoup") { url, err in
                if let url { cont.resume(returning: url) } else { cont.resume(throwing: err ?? APIError.server("Sign-in was cancelled.")) }
            }
            s.presentationContextProvider = self
            s.prefersEphemeralWebBrowserSession = false
            self.session = s
            s.start()
        }
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard items.first(where: { $0.name == "state" })?.value == state, let code = items.first(where: { $0.name == "code" })?.value else {
            throw APIError.server(items.first(where: { $0.name == "error" })?.value == "access_denied" ? "Sign-in was declined." : "Sign-in didn't complete.")
        }
        // 3. Code → token.
        var t = URLRequest(url: base.appendingPathComponent("oauth/token"))
        t.httpMethod = "POST"
        t.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "content-type")
        let form = ["grant_type": "authorization_code", "code": code, "redirect_uri": Self.redirect, "client_id": clientId!, "code_verifier": verifier]
        t.httpBody = form.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")" }.joined(separator: "&").data(using: .utf8)
        let (data, _) = try await URLSession.shared.data(for: t)
        guard let token = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["access_token"] as? String else { throw APIError.server("Couldn't finish signing in.") }
        Keychain.token = token
    }
}

extension Data {
    var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
}
