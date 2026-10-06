// Reading end-to-end encrypted messages without the app running: compiled into the app and its extensions (the
// notification extension, NotifyExtension/, shows a push's real text with it). The board keys this phone holds are
// kept in the Keychain group the app and its extensions share, this device only (BoardCrypto.sync stores them;
// docs/research/E2E-EVERYWHERE.md §4). Extensions only read them: they never make a device key or fetch a key.

import CryptoKit
import Foundation
import Security

enum SealedKeys {
    private static let service = "com.agentsoup.app" // the app's Keychain service (Auth.swift)
    private static let prefix = "board-key:"

    private static func account(_ board: String, _ epoch: Int) -> String { "\(prefix)\(board):\(epoch)" }

    static func read(board: String, epoch: Int) -> SymmetricKey? {
        var out: AnyObject?
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account(board, epoch), kSecReturnData as String: true]
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data, d.count == 32 else { return nil }
        return SymmetricKey(data: d)
    }

    static func store(_ key: SymmetricKey, board: String, epoch: Int) {
        let raw = key.withUnsafeBytes { Data($0) }
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account(board, epoch)]
        SecItemDelete(q as CFDictionary)
        var add = q
        add[kSecValueData as String] = raw
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    /// Signing out: every board key goes (the device key stays, as it always has).
    static func forgetAll() {
        var out: AnyObject?
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecMatchLimit as String: kSecMatchLimitAll, kSecReturnAttributes as String: true]
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let items = out as? [[String: Any]] else { return }
        for i in items {
            guard let a = i[kSecAttrAccount as String] as? String, a.hasPrefix(prefix) else { continue }
            SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: a] as CFDictionary)
        }
    }
}

enum SealedOpen {
    /// A v2 message ({v:2, epoch, iv, ct}: AES-256-GCM with the board's key for that epoch), or nil when it isn't one or
    /// this phone doesn't hold that key.
    static func open(_ payload: String, key: (Int) -> SymmetricKey?) -> String? {
        guard let d = payload.data(using: .utf8),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              j["v"] as? Int == 2, let epoch = j["epoch"] as? Int, let k = key(epoch),
              let iv = (j["iv"] as? String).flatMap({ Data(base64Encoded: $0) }), let ct = (j["ct"] as? String).flatMap({ Data(base64Encoded: $0) }), ct.count >= 16,
              let box = try? AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ct.dropLast(16), tag: ct.suffix(16)),
              let plain = try? AES.GCM.open(box, using: k) else { return nil }
        return String(data: plain, encoding: .utf8)
    }
}

/// A push for an encrypted board (src/pushPayload.ts) carries the message's ciphertext, never its text; its alert says
/// only "New message on <board>". The notification extension swaps in the real words when this phone can read them.
enum PushContent {
    struct Shown: Equatable { let title: String; let body: String }

    static func decrypted(_ info: [AnyHashable: Any], key: (String, Int) -> SymmetricKey?) -> Shown? {
        guard let board = info["board"] as? String, let sealed = info["sealed"] as? String,
              let text = SealedOpen.open(sealed, key: { key(board, $0) }) else { return nil }
        let author = info["author"] as? String ?? ""
        let who = info["via"] as? String == "agent" ? "\(author)'s agent" : author
        let title = (info["board_title"] as? String).map { who.isEmpty ? $0 : "\(who) in \($0)" } ?? who
        let body = text.count > 180 ? String(text.prefix(179)) + "…" : text
        return Shown(title: title, body: body)
    }
}
