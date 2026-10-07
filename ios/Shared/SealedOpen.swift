// Reading end-to-end encrypted messages without the app running: compiled into the app and the notification extension
// (NotifyExtension/ shows a push's real text with it). The board keys this phone holds are kept in a Keychain group
// of their own that only the app and that extension share, this device only (BoardCrypto.sync stores them;
// docs/research/E2E-EVERYWHERE.md §4). The extension only reads them: it never makes a device key or fetches a key.

import CryptoKit
import Foundation
import Security

enum SealedKeys {
    private static let service = "com.agentsoup.app" // the app's Keychain service (Auth.swift)
    private static let prefix = "board-key:"

    /// The board keys' own Keychain group, "<team>.<app id>.e2e" (Info.plist AtteoE2EKeychainGroup): the app and the
    /// notification extension are entitled to it, the share extension isn't, and the extension gets nothing else (not
    /// the sign-in token's group). Without it nothing is kept or read: board keys never land in the default group.
    static let group: String? = (Bundle.main.object(forInfoDictionaryKey: "AtteoE2EKeychainGroup") as? String).flatMap { $0.hasSuffix(".e2e") ? $0 : nil }

    static func query(_ account: String? = nil) -> [String: Any]? {
        guard let group else { return nil }
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccessGroup as String: group]
        if let account { q[kSecAttrAccount as String] = account }
        return q
    }

    private static func account(_ board: String, _ epoch: Int) -> String { "\(prefix)\(board):\(epoch)" }

    static func read(board: String, epoch: Int) -> SymmetricKey? {
        guard var q = query(account(board, epoch)) else { return nil }
        q[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data, d.count == 32 else { return nil }
        return SymmetricKey(data: d)
    }

    static func store(_ key: SymmetricKey, board: String, epoch: Int) {
        guard let q = query(account(board, epoch)) else { return }
        SecItemDelete(q as CFDictionary)
        var add = q
        add[kSecValueData as String] = key.withUnsafeBytes { Data($0) }
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    /// The board's keys (leaving it, or removed from it), or every board's (signing out). The device key stays.
    static func forget(board: String? = nil) {
        guard var q = query() else { return }
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        q[kSecReturnAttributes as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let items = out as? [[String: Any]] else { return }
        let mine = board.map { "\(prefix)\($0):" } ?? prefix
        for i in items {
            guard let a = i[kSecAttrAccount as String] as? String, a.hasPrefix(mine), let d = query(a) else { continue }
            SecItemDelete(d as CFDictionary)
        }
    }

    static func forgetAll() { forget(); PushNames.set([:]) }

    /// The boards this phone keeps keys for.
    static func boards() -> Set<String> {
        guard var q = query() else { return [] }
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        q[kSecReturnAttributes as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let items = out as? [[String: Any]] else { return [] }
        return Set(items.compactMap { i -> String? in
            guard let a = i[kSecAttrAccount as String] as? String, a.hasPrefix(prefix) else { return nil }
            let rest = a.dropFirst(prefix.count)
            return rest.lastIndex(of: ":").map { String(rest[..<$0]) }
        })
    }

    /// Keeps keys only for these boards (the encrypted boards you're on): leaving one, or being removed, drops its
    /// keys from this phone (review #5551 item 7). Returns the boards dropped.
    @discardableResult
    static func keep(only boards: Set<String>) -> Set<String> {
        let gone = Self.boards().subtracting(boards)
        for b in gone { forget(board: b) }
        return gone
    }
}

/// The names of your encrypted boards, as the app last listed them, so a push (which carries no names: review #5550)
/// can say which board it's from. Kept beside the board keys, in their Keychain group.
enum PushNames {
    private static let account = "board-titles"

    static func all() -> [String: String] {
        guard var q = SealedKeys.query(account) else { return [:] }
        q[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return [:] }
        return (try? JSONDecoder().decode([String: String].self, from: d)) ?? [:]
    }

    /// Replaces the list (only when it changed: no Keychain write on every refresh).
    static func set(_ titles: [String: String]) {
        guard titles != all(), let q = SealedKeys.query(account) else { return }
        SecItemDelete(q as CFDictionary)
        guard !titles.isEmpty, let d = try? JSONEncoder().encode(titles) else { return }
        var add = q
        add[kSecValueData as String] = d
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
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

/// A push for an encrypted board (src/pushPayload.ts) is only {board, seq, sealed} with the alert "New message": no
/// text and no names reach Apple. The notification extension swaps in the real words when this phone can read them,
/// under the board's name from the app's own list.
enum PushContent {
    struct Shown: Equatable { let title: String; let body: String }

    /// The words are checked as the app checks them (review #5551 item 6): a credential shows redacted, and text that
    /// reads like instructions to an agent starts with ⚠. Without the rules (`scan` nil) nothing readable shows.
    static func decrypted(_ info: [AnyHashable: Any], key: (String, Int) -> SymmetricKey?, title: (String) -> String?, scan: ScanRules?) -> Shown? {
        guard let scan, let board = info["board"] as? String, let sealed = info["sealed"] as? String,
              let plain = SealedOpen.open(sealed, key: { key(board, $0) }) else { return nil }
        let text = (scan.flag(plain) != nil ? "⚠ " : "") + scan.redact(plain)
        let body = text.count > 180 ? String(text.prefix(179)) + "…" : text
        return Shown(title: title(board) ?? "", body: body)
    }
}
