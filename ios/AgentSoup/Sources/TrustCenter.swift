// What Settings → Encryption shows and does (E2E 1c, docs/SPEC.md §16): this phone's fingerprint, your devices (Approve
// one after comparing its fingerprint: it's signed into your device list and handed this phone's pins), devices on
// your boards nothing here vouches for (Trust only with the fingerprint their owner reads you), and, after another
// device of yours approved this one, its label and fingerprint until you say they match. BoardCrypto.sync feeds it.

import CryptoKit
import Foundation
import Security

/// Small things this phone keeps for encrypted boards (its signing key, pins, the newest epochs seen): in the board keys'
/// own Keychain group, this device only; in the app's group on a build without it (none ships so).
enum E2EItem {
    private static let service = "com.agentsoup.app"

    static func read(_ account: String) -> Data? {
        guard var q = SealedKeys.query(account) else { return Keychain.data(account) }
        q[kSecReturnData as String] = true
        var out: AnyObject?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    static func write(_ account: String, _ d: Data?) {
        let q = SealedKeys.query(account) ?? [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(q as CFDictionary)
        guard let d else { return }
        var add = q
        add[kSecValueData as String] = d
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}

@MainActor
final class TrustCenter: ObservableObject {
    static let shared = TrustCenter()

    /// The device that approved this one, as the server named it, until you say its fingerprint matches.
    struct Approved: Codable, Equatable { let label: String; let kid: String; let fingerprint: String }
    /// One of your devices (`GET /api/me/keys`).
    struct Mine: Decodable, Identifiable, Hashable {
        let id: String
        let publicKey: String
        var label: String? = nil
        var signPub: String? = nil
        var sig: String? = nil
        var fingerprint: String { DeviceTrust.fingerprint(publicKey, signPub) }
    }
    /// Someone else's device on a board that none of their devices this phone trusted vouches for (review #5558).
    struct Check: Identifiable, Hashable {
        let board: String
        let device: SignedDevice
        var id: String { "\(board):\(device.kid)" }
        var fingerprint: String { DeviceTrust.fingerprint(device.publicKey, device.signPub) }
    }

    @Published var kid: String?
    @Published var devices: [Mine] = []
    @Published private(set) var approvedHere: Set<String> = [] // "kid|public key" of your devices pinned here
    @Published var checks: [String: [Check]] = [:]
    @Published var waiting: Set<String> = [] // boards this phone has no key for yet (it trusts no one there yet)
    @Published var approvedBy: Approved?
    @Published var signMismatch = false

    private var me: String? { BoardCrypto.shared.user }

    /// What a sync of `board` found: the devices it won't hand keys to.
    func saw(board: String, me: String, untrusted: [SignedDevice], pin: Pins, waiting w: Bool) {
        let c = untrusted.filter { $0.user != me && DeviceTrust.noneLeft(pin, $0.user) }.map { Check(board: board, device: $0) }
        if checks[board] ?? [] != c { checks[board] = c.isEmpty ? nil : c }
        if w { waiting.insert(board) } else { waiting.remove(board) }
        setApproved(pin[me] ?? [])
        if approvedBy == nil { approvedBy = Self.loadApproved(me) }
    }

    private func setApproved(_ own: [String]) {
        let s = Set(own.map { $0.split(separator: "|", omittingEmptySubsequences: false).prefix(2).joined(separator: "|") })
        if s != approvedHere { approvedHere = s }
    }

    func isApprovedHere(_ d: Mine) -> Bool { approvedHere.contains("\(d.id)|\(d.publicKey)") }

    func setApprovedBy(_ a: Approved, me: String) {
        E2EItem.write("approved-by:\(me)", try? JSONEncoder().encode(a))
        approvedBy = a
    }

    private static func loadApproved(_ me: String) -> Approved? {
        E2EItem.read("approved-by:\(me)").flatMap { try? JSONDecoder().decode(Approved.self, from: $0) }
    }

    /// You compared the approver's fingerprint with that device: the line goes.
    func itMatches() {
        if let me { E2EItem.write("approved-by:\(me)", nil) }
        approvedBy = nil
    }

    func refresh() async {
        kid = try? await BoardCrypto.shared.deviceId()
        struct R: Decodable { let keys: [Mine] }
        if let r = try? await API.shared.get("/api/me/keys", as: R.self) { devices = r.keys }
        if let me {
            setApproved(BoardCrypto.pins(me)[me] ?? [])
            approvedBy = Self.loadApproved(me)
        }
    }

    /// Your own new device, after you compared its fingerprint: pinned here, signed into your device list (other
    /// members' devices then hand it keys too, and your encrypted boards show the change), handed this phone's pins
    /// (sealed to it, signed by this phone), and handed the keys this phone holds.
    func approve(_ d: Mine) async throws {
        let mine = try await BoardCrypto.shared.deviceId()
        guard let me, d.id != mine else { return }
        var p = BoardCrypto.pins(me)
        if DeviceTrust.pinned(p[me], d.id, d.publicKey) == nil { p[me, default: []].append(DeviceTrust.pinId(d.id, d.publicKey, d.signPub)) }
        BoardCrypto.savePins(p, me)
        if d.sig == nil {
            let sig = try BoardCrypto.shared.sign(DeviceTrust.deviceSigned(me, d.id, d.publicKey, d.signPub))
            _ = try? await API.shared.send("/api/me/keys/\(d.id)/sign", body: ["by": mine, "sig": sig], retries: false)
        }
        let g = try DeviceTrust.sealPins(p, to: d.publicKey)
        let sig = try BoardCrypto.shared.sign(DeviceTrust.pinsSigned(me, d.id, epk: g.epk, iv: g.iv, wrapped: g.wrapped))
        _ = try? await API.shared.send("/api/me/keys/\(d.id)/pins", body: ["by": mine, "epk": g.epk, "iv": g.iv, "wrapped": g.wrapped, "sig": sig], retries: false)
        await BoardCrypto.shared.syncAll()
        await refresh()
    }

    /// Someone else's device, on their word: only with the fingerprint they read you. False when it doesn't match.
    func trust(_ c: Check, typed: String) async throws -> Bool {
        guard let me, c.device.user != me, DeviceTrust.sameFingerprint(typed, c.fingerprint) else { return false }
        var p = BoardCrypto.pins(me)
        if DeviceTrust.pinned(p[c.device.user], c.device.kid, c.device.publicKey) == nil {
            p[c.device.user, default: []].append(DeviceTrust.pinId(c.device.kid, c.device.publicKey, c.device.signPub))
        }
        BoardCrypto.savePins(p, me)
        _ = try await BoardCrypto.shared.sync(c.board)
        return true
    }

    /// Signing out: nothing of the last person's stays on screen (their pins stay, per person, as on the CLI and web).
    func reset() {
        kid = nil; devices = []; approvedHere = []; checks = [:]; waiting = []; approvedBy = nil; signMismatch = false
    }
}
