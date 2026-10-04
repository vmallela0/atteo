// End-to-end encrypted boards on this phone (encryption v2). The phone has its own device key (Curve25519, kept in
// the Keychain, never sent anywhere); each board has a key per epoch, wrapped to every member device; messages are
// encrypted once with it. Same scheme as the CLI and the server's rules (src/boardkeys.ts):
// wrap = X25519(ephemeral, device) → HKDF-SHA256(salt: epk‖device public key, info "agent-soup board key v2")
// → AES-256-GCM over the 32-byte board key; a message is AES-256-GCM with the board key: {v:2, epoch, iv, ct}.

import CryptoKit
import Foundation
import UIKit

struct EpochState: Decodable {
    struct Grant: Codable { let epoch: Int; let kid: String; let epk: String; let iv: String; let wrapped: String }
    struct Missing: Decodable { let kid: String; let user: String; let publicKey: String; let firstDevice: Bool; let epochs: [Int] }
    struct DeviceKey: Decodable { let kid: String; let user: String; let publicKey: String }
    let current: Int
    let rotateNeeded: Bool
    let mine: [Grant]
    let missing: [Missing]
    let keys: [DeviceKey]
}

private struct SealedResponse: Decodable {
    struct Item: Decodable { let seq: Int; let payload: String }
    let entries: [Item]
}

enum BoardCryptoError: LocalizedError {
    case waitingForApproval
    var errorDescription: String? {
        String(localized: "This phone can't read this board yet: open it on one of your devices that already can (the atteo CLI does it on its next read).", bundle: .l10n)
    }
}

@MainActor
final class BoardCrypto {
    static let shared = BoardCrypto()
    private static let info = Data("agent-soup board key v2".utf8)
    private var keys: [String: [Int: SymmetricKey]] = [:] // board → epoch → key (memory only)

    // MARK: - This phone's device key

    private var privateKey: Curve25519.KeyAgreement.PrivateKey {
        if let raw = Keychain.data("device-key"), let k = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw) { return k }
        let k = Curve25519.KeyAgreement.PrivateKey()
        Keychain.setData(k.rawRepresentation, for: "device-key")
        return k
    }
    private var publicKey: Data { privateKey.publicKey.rawRepresentation }

    /// This phone's key id on the server (registered once; the server returns the same id for the same key).
    func deviceId() async throws -> String {
        if let kid = UserDefaults.standard.string(forKey: "agent-soup-device-kid") { return kid }
        struct R: Decodable { let id: String }
        let d = try await API.shared.send("/api/me/keys", body: ["public_key": publicKey.base64EncodedString(), "label": UIDevice.current.name])
        let kid = try JSONDecoder.soup.decode(R.self, from: d).id
        UserDefaults.standard.set(kid, forKey: "agent-soup-device-kid")
        return kid
    }

    // MARK: - Board keys

    /// Gets this phone's board keys; hands keys on to members who lack them (newcomers read the history); and,
    /// when about to write, opens the board's first or next key (after someone left) for everyone remaining.
    @discardableResult
    func sync(_ board: String, forWriting: Bool = false) async throws -> EpochState {
        let kid = try await deviceId()
        var st = try await API.shared.get("/api/boards/\(board)/epochs", as: EpochState.self)
        if forWriting && (st.current == 0 || st.rotateNeeded) {
            let fresh = SymmetricKey(size: .bits256)
            let grants = try st.keys.map { k -> [String: Any] in try ["kid": k.kid] .merging(wrap(fresh, to: k.publicKey)) { a, _ in a } }
            if !st.keys.contains(where: { $0.kid == kid }) { throw BoardCryptoError.waitingForApproval }
            _ = try await API.shared.send("/api/boards/\(board)/epochs", body: ["epoch": st.current + 1, "grants": grants], retries: false)
            st = try await API.shared.get("/api/boards/\(board)/epochs", as: EpochState.self)
        }
        var mine: [Int: SymmetricKey] = [:]
        for g in st.mine where g.kid == kid { if let k = try? unwrap(g) { mine[g.epoch] = k } }
        keys[board] = mine
        // Hand on what we hold to devices that may have it (the server only lists what we're allowed to grant).
        let out = try st.missing.flatMap { m in try m.epochs.compactMap { e -> [String: Any]? in
            guard let k = mine[e] else { return nil }
            return try ["epoch": e, "kid": m.kid].merging(wrap(k, to: m.publicKey)) { a, _ in a }
        } }
        if !out.isEmpty { _ = try? await API.shared.send("/api/boards/\(board)/grants", body: ["grants": out], retries: false) }
        return st
    }

    /// The board's encrypted messages from `after`, decrypted where this phone holds the key (seq → text).
    func decrypt(_ board: String, after: Int) async -> [Int: String] {
        do {
            if keys[board] == nil { try await sync(board) }
            let r = try await API.shared.get("/api/boards/\(board)/sealed?after=\(after)", as: SealedResponse.self)
            var out: [Int: String] = [:]
            for e in r.entries { if let t = open(e.payload, board: board) { out[e.seq] = t } }
            return out
        } catch { return [:] }
    }

    /// Encrypts a message with the board's current key (opening one first if needed) as a v2 payload.
    func seal(_ text: String, board: String) async throws -> String {
        let st = try await sync(board, forWriting: true)
        guard let key = keys[board]?[st.current] else { throw BoardCryptoError.waitingForApproval }
        let box = try AES.GCM.seal(Data(text.utf8), using: key)
        let payload: [String: Any] = ["v": 2, "epoch": st.current, "iv": Data(box.nonce).base64EncodedString(), "ct": (box.ciphertext + box.tag).base64EncodedString()]
        return String(data: try JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!
    }

    /// Whether this phone can read the board right now (false: waiting for one of your devices to add it).
    func canRead(_ board: String) -> Bool { !(keys[board]?.isEmpty ?? true) }

    // MARK: - The scheme

    private func open(_ payload: String, board: String) -> String? {
        guard let d = payload.data(using: .utf8),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              j["v"] as? Int == 2, let epoch = j["epoch"] as? Int, let key = keys[board]?[epoch],
              let iv = (j["iv"] as? String).flatMap({ Data(base64Encoded: $0) }), let ct = (j["ct"] as? String).flatMap({ Data(base64Encoded: $0) }), ct.count >= 16,
              let box = try? AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ct.dropLast(16), tag: ct.suffix(16)),
              let plain = try? AES.GCM.open(box, using: key) else { return nil }
        return String(data: plain, encoding: .utf8)
    }

    private func kek(_ shared: SharedSecret, epk: Data, devicePublic: Data) -> SymmetricKey {
        shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: epk + devicePublic, sharedInfo: Self.info, outputByteCount: 32)
    }

    private func wrap(_ key: SymmetricKey, to publicKeyB64: String) throws -> [String: Any] {
        guard let pub = Data(base64Encoded: publicKeyB64) else { throw CryptoKitError.incorrectKeySize }
        let eph = Curve25519.KeyAgreement.PrivateKey()
        let shared = try eph.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: pub))
        let raw = key.withUnsafeBytes { Data($0) }
        let box = try AES.GCM.seal(raw, using: kek(shared, epk: eph.publicKey.rawRepresentation, devicePublic: pub))
        return ["epk": eph.publicKey.rawRepresentation.base64EncodedString(), "iv": Data(box.nonce).base64EncodedString(), "wrapped": (box.ciphertext + box.tag).base64EncodedString()]
    }

    private func unwrap(_ g: EpochState.Grant) throws -> SymmetricKey {
        guard let epk = Data(base64Encoded: g.epk), let iv = Data(base64Encoded: g.iv), let w = Data(base64Encoded: g.wrapped), w.count == 48 else { throw CryptoKitError.incorrectParameterSize }
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: epk))
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: w.prefix(32), tag: w.suffix(16))
        return SymmetricKey(data: try AES.GCM.open(box, using: kek(shared, epk: epk, devicePublic: publicKey)))
    }

    func forget() { keys = [:]; UserDefaults.standard.removeObject(forKey: "agent-soup-device-kid") }
}
