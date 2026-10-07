// Which devices this phone hands board keys to (E2E 1c, docs/SPEC.md §16): the CLI's cli/src/crosssign.ts and the
// web's pins (src/e2eweb.ts), byte for byte. A pin is `kid|public key|signing key|signed by`, per person. A person is
// trusted on first sight once this phone holds the board's key; later devices only through a signature from a device
// pinned here, or on the person's word with the fingerprint they read out. Pure functions, unit-tested
// (AtteoTests/DeviceTrustTests.swift); BoardCrypto applies them.

import CryptoKit
import Foundation

typealias Pins = [String: [String]]

/// A device as the server lists it on a board (`GET /api/boards/{id}/epochs`: keys and missing).
struct SignedDevice: Decodable, Hashable {
    let kid: String
    let user: String
    let publicKey: String
    var label: String? = nil
    var signPub: String? = nil
    var signedBy: String? = nil
    var sig: String? = nil
}

enum DeviceTrust {
    // MARK: - Pins

    static func pinId(_ kid: String, _ pub: String, _ spub: String? = nil, via: String? = nil) -> String {
        let s = spub.flatMap { $0.isEmpty ? nil : $0 }
        return "\(kid)|\(pub)" + (s.map { "|\($0)" } ?? (via != nil ? "|" : "")) + (via.map { "|\($0)" } ?? "")
    }

    /// The pin for this device id AND public key, if any (the server can't keep a trusted id and swap the key).
    static func pinned(_ list: [String]?, _ kid: String, _ pub: String) -> String? {
        let p = pinId(kid, pub)
        return list?.first { $0 == p || $0.hasPrefix(p + "|") }
    }

    static func isPinned(_ pin: Pins, _ d: SignedDevice) -> Bool { pinned(pin[d.user], d.kid, d.publicKey) != nil }

    private static func parts(_ e: String) -> [String] { e.split(separator: "|", omittingEmptySubsequences: false).map(String.init) }

    /// A person never seen here: their first device listed is trusted on first use. A person seen once keeps their entry,
    /// emptied or not (review #5558).
    static func firstSight(_ pin: inout Pins, me: String, _ devices: [SignedDevice]) {
        for d in devices where d.user != me && pin[d.user] == nil { pin[d.user] = [pinId(d.kid, d.publicKey, d.signPub)] }
    }

    /// Every pinned device of theirs is gone (a tombstone): a new one gets nothing from here without their word.
    static func noneLeft(_ pin: Pins, _ user: String) -> Bool { pin[user].map(\.isEmpty) ?? false }

    /// A device signed by one pinned here, checked against the signing key pinned with the signer (never the one the
    /// server shows now), is pinned too, with the id of its signer.
    static func crossSigned(_ pin: inout Pins, _ devices: [SignedDevice]) {
        var more = true
        while more {
            more = false
            for d in devices {
                guard pinned(pin[d.user], d.kid, d.publicKey) == nil, let by = d.signedBy, let sig = d.sig else { continue }
                guard let signer = pin[d.user]?.map(parts).first(where: { $0[0] == by && $0.count > 2 && !$0[2].isEmpty }) else { continue }
                if verify(signer[2], deviceSigned(d.user, d.kid, d.publicKey, d.signPub), sig) {
                    pin[d.user, default: []].append(pinId(d.kid, d.publicKey, d.signPub, via: by))
                    more = true
                }
            }
        }
    }

    /// Removed devices lose their pins, and so does every device trusted through them (review #5524). `devices`: every
    /// live member device.
    static func dropGone(_ pin: inout Pins, _ devices: [SignedDevice]) {
        var live: [String: Set<String>] = [:]
        for d in devices { live[d.user, default: []].insert("\(d.kid)|\(d.publicKey)") }
        for (u, ids) in live {
            guard let list = pin[u] else { continue }
            var gone = Set<String>(), more = true
            while more {
                more = false
                for e in list {
                    let p = parts(e)
                    if gone.contains(p[0]) { continue }
                    if !ids.contains("\(p[0])|\(p.count > 1 ? p[1] : "")") || (p.count > 3 && gone.contains(p[3])) { gone.insert(p[0]); more = true }
                }
            }
            pin[u] = list.filter { !gone.contains(parts($0)[0]) }
        }
    }

    /// The signing key pinned here for one of my own devices, or nil (review #5592): a handoff counts only against it.
    static func ownSigner(_ pin: Pins, me: String, kid: String) -> String? {
        pin[me]?.map(parts).first { $0[0] == kid && $0.count > 2 && !$0[2].isEmpty }?[2]
    }

    /// This phone's pins hold only itself: a handoff signed by whoever the server says may be taken, once.
    static func knowsNobody(_ pin: Pins, me: String, kid: String) -> Bool {
        pin.keys.allSatisfy { $0 == me } && (pin[me] ?? []).allSatisfy { parts($0)[0] == kid }
    }

    /// Pins handed over, only for people never seen here (never appended to anyone's list, nor to mine).
    static func mergePins(_ pin: inout Pins, _ got: [String: Any], me: String) {
        for (u, v) in got {
            guard u != me, pin[u] == nil, let list = v as? [Any], u.range(of: "^[a-z0-9][a-z0-9_.-]{0,31}$", options: .regularExpression) != nil else { continue }
            var seen = Set<String>(), out: [String] = []
            for case let e as String in list where e.range(of: "^[a-z0-9-]{1,40}\\|[A-Za-z0-9+/]{43}=", options: .regularExpression) != nil && seen.insert(e).inserted { out.append(e) }
            pin[u] = out
        }
    }

    // MARK: - Fingerprints

    /// SHA-256 over `atteo fingerprint v1\n<public key>\n<signing key>`, the first 16 bytes as 8 groups of 4 hex digits.
    static func fingerprint(_ pub: String, _ spub: String?) -> String {
        let h = SHA256.hash(data: Data("atteo fingerprint v1\n\(pub)\n\(spub ?? "")".utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        return stride(from: 0, to: 32, by: 4).map { i in String(h.dropFirst(i).prefix(4)) }.joined(separator: " ")
    }

    /// What someone typed is that fingerprint (spaces, colons, dashes and case don't matter).
    static func sameFingerprint(_ typed: String, _ fp: String) -> Bool {
        let t = typed.lowercased().filter { !$0.isWhitespace && $0 != ":" && $0 != "-" }
        return !t.isEmpty && t == fp.replacingOccurrences(of: " ", with: "")
    }

    // MARK: - Signatures (never change these bytes: src/boardkeys.ts, cli/src/sealed.ts, src/e2eweb.ts)

    static func deviceSigned(_ user: String, _ kid: String, _ pub: String, _ spub: String?) -> Data { Data("atteo device v1\n\(user)\n\(kid)\n\(pub)\n\(spub ?? "")".utf8) }
    static func pinsSigned(_ user: String, _ kid: String, epk: String, iv: String, wrapped: String) -> Data { Data("atteo pins v1\n\(user)\n\(kid)\n\(epk)\n\(iv)\n\(wrapped)".utf8) }

    static func verify(_ spub: String, _ data: Data, _ sig: String) -> Bool {
        guard let k = Data(base64Encoded: spub), let s = Data(base64Encoded: sig), let key = try? Curve25519.Signing.PublicKey(rawRepresentation: k) else { return false }
        return key.isValidSignature(s, for: data)
    }

    // MARK: - Sealing to a device key (X25519 → HKDF-SHA256(salt epk ‖ device key, info) → AES-256-GCM)

    static let pinsInfo = Data("atteo pins v1".utf8)
    static let proofInfo = Data("atteo sign-key proof v1".utf8)
    static let boardInfo = Data("agent-soup board key v2".utf8)

    struct Sealed: Codable, Hashable { let epk: String; let iv: String; let wrapped: String }

    static func seal(_ plain: Data, to devicePub: String, info: Data) throws -> Sealed {
        guard let pub = Data(base64Encoded: devicePub) else { throw CryptoKitError.incorrectKeySize }
        let eph = Curve25519.KeyAgreement.PrivateKey()
        let shared = try eph.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: pub))
        let epk = eph.publicKey.rawRepresentation
        let box = try AES.GCM.seal(plain, using: shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: epk + pub, sharedInfo: info, outputByteCount: 32))
        return Sealed(epk: epk.base64EncodedString(), iv: Data(box.nonce).base64EncodedString(), wrapped: (box.ciphertext + box.tag).base64EncodedString())
    }

    static func open(_ g: Sealed, with priv: Curve25519.KeyAgreement.PrivateKey, info: Data) -> Data? {
        guard let epk = Data(base64Encoded: g.epk), let iv = Data(base64Encoded: g.iv), let w = Data(base64Encoded: g.wrapped), w.count >= 16,
              let shared = try? priv.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: epk)),
              let box = try? AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: w.dropLast(16), tag: w.suffix(16)) else { return nil }
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: epk + priv.publicKey.rawRepresentation, sharedInfo: info, outputByteCount: 32)
        return try? AES.GCM.open(box, using: key)
    }

    /// Pins sealed to another device of mine: `{v:1, pins}`.
    static func sealPins(_ pin: Pins, to devicePub: String) throws -> Sealed {
        try seal(try JSONSerialization.data(withJSONObject: ["v": 1, "pins": pin], options: [.sortedKeys]), to: devicePub, info: pinsInfo)
    }

    static func openPins(_ g: Sealed, with priv: Curve25519.KeyAgreement.PrivateKey) -> [String: Any]? {
        guard let d = open(g, with: priv, info: pinsInfo), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              j["v"] as? Int == 1, let p = j["pins"] as? [String: Any] else { return nil }
        return p
    }

    // MARK: - Invite links that carry the board key (E2E design §3.3)

    /// SHA-256 over each epoch (4 bytes, big endian) and its key, in epoch order; base64url. The link's "#" carries it, so
    /// the joiner takes exactly the keys the inviter handed over (review #5526).
    static func keysDigest(_ keys: [Int: Data]) -> String {
        var h = SHA256()
        for (e, k) in keys.sorted(by: { $0.key < $1.key }) {
            withUnsafeBytes(of: UInt32(e).bigEndian) { h.update(bufferPointer: $0) }
            h.update(data: k)
        }
        return base64url(Data(h.finalize()))
    }

    static func base64url(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    /// A one-time invite key: each epoch key wrapped to it, and the link's "#" (its private half and the keys' digest).
    static func inviteKey(_ keys: [Int: Data]) throws -> (publicKey: String, grants: [[String: Any]], fragment: String) {
        let k = Curve25519.KeyAgreement.PrivateKey()
        let pub = k.publicKey.rawRepresentation.base64EncodedString()
        let grants = try keys.sorted(by: { $0.key < $1.key }).map { e, raw -> [String: Any] in
            let g = try seal(raw, to: pub, info: boardInfo)
            return ["epoch": e, "epk": g.epk, "iv": g.iv, "wrapped": g.wrapped]
        }
        return (pub, grants, "#k=\(base64url(k.rawRepresentation)).\(keysDigest(keys))")
    }
}
