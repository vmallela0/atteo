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
    struct Missing: Decodable {
        let kid: String; let user: String; let publicKey: String; let firstDevice: Bool; let epochs: [Int]
        var label: String? = nil; var signPub: String? = nil; var signedBy: String? = nil; var sig: String? = nil
        var device: SignedDevice { SignedDevice(kid: kid, user: user, publicKey: publicKey, label: label, signPub: signPub, signedBy: signedBy, sig: sig) }
    }
    let current: Int
    let rotateNeeded: Bool
    let mine: [Grant]
    let missing: [Missing]
    let keys: [SignedDevice] // every live member device
}

private struct SealedResponse: Decodable {
    struct Item: Decodable { let seq: Int; let payload: String; var ts: Double? = nil; var author: String? = nil; var via: String? = nil; var type: String? = nil }
    let entries: [Item]
}

/// A file of an encrypted message, as its extras name it (docs/SPEC.md §16): the server has only `id`'s ciphertext.
struct SealedFile: Codable, Hashable {
    let id: String
    let name: String
    let mime: String
    let size: Int
    let key: String // base64, 32 bytes: this file's own key
    var chunk: Int? = 65536
    var w: Int? = nil
    var h: Int? = nil
}

/// What an envelope's `x` carries besides the text: a title, files. Old readers skip it and still read the text.
struct SealedExtras: Codable, Hashable {
    var xv: Int? = 1
    var title: String? = nil
    var files: [SealedFile]? = nil
    var isEmpty: Bool { (title ?? "").isEmpty && (files ?? []).isEmpty }
}

/// An opened envelope: the text and its extras.
struct Opened: Hashable { let text: String; let extras: SealedExtras }

/// Files on encrypted boards: a fresh key per file, 64 KB chunks, each AES-256-GCM with the nonce 0⁸ ‖ chunk index
/// (big-endian), stored as ciphertext‖tag one after the other; same as the CLI (cli/src/sealed.ts) and the web.
enum SealedFiles {
    static let chunk = 65536
    private static func nonce(_ i: Int) throws -> AES.GCM.Nonce {
        var n = Data(count: 8)
        withUnsafeBytes(of: UInt32(i).bigEndian) { n.append(contentsOf: $0) }
        return try AES.GCM.Nonce(data: n)
    }

    /// Encrypts with a new key: (key, blob for POST …/sealed-files).
    static func encrypt(_ plain: Data) throws -> (key: Data, blob: Data) {
        let key = SymmetricKey(size: .bits256)
        var out = Data(), i = 0
        repeat {
            let lo = plain.startIndex + i * chunk, part = plain[lo..<min(lo + chunk, plain.endIndex)]
            let box = try AES.GCM.seal(part, using: key, nonce: nonce(i))
            out += box.ciphertext + box.tag
            i += 1
        } while i * chunk < plain.count
        return (key.withUnsafeBytes { Data($0) }, out)
    }

    /// Decrypts a blob; throws if any chunk was changed or the size isn't what the message said.
    static func decrypt(_ blob: Data, key raw: Data, size: Int) throws -> Data {
        let key = SymmetricKey(data: raw)
        var out = Data(), off = blob.startIndex, i = 0
        while off < blob.endIndex {
            let end = min(off + chunk + 16, blob.endIndex), c = blob[off..<end]
            guard c.count >= 16 else { throw CryptoKitError.incorrectParameterSize }
            out += try AES.GCM.open(AES.GCM.SealedBox(nonce: nonce(i), ciphertext: c.dropLast(16), tag: c.suffix(16)), using: key)
            off = end; i += 1
        }
        guard out.count == size else { throw CryptoKitError.incorrectParameterSize }
        return out
    }
}

enum BoardCryptoError: LocalizedError {
    case waitingForApproval
    case rolledBack(shown: Int, seen: Int)
    var errorDescription: String? {
        switch self {
        case .waitingForApproval:
            String(localized: "This phone can't read this board yet. Approve it on one of your devices that already can (the web's encryption bar, or atteo keys approve), after checking its fingerprint in Settings → Encryption.", bundle: .l10n)
        case let .rolledBack(shown, seen):
            String(localized: "The server shows this board at key epoch \(shown), but this phone has seen epoch \(seen): it may be replaying an old key, so nothing was encrypted. Tell the board's members.", bundle: .l10n)
        }
    }
}

/// MainActor tasks may overlap at an await. Queue the whole pin read, handoff, and save so a later sync reads the
/// previous sync's result, including tombstones and newly trusted devices.
@MainActor
final class PinMutationQueue {
    private var tail: Task<Void, Never>?
    private var generation = 0

    func run<T>(_ mutation: @escaping @MainActor () async -> T) async -> T {
        let previous = tail
        generation += 1
        let ticket = generation
        let current = Task {
            await previous?.value
            return await mutation()
        }
        tail = Task {
            _ = await current.value
            if self.generation == ticket { self.tail = nil }
        }
        return await current.value
    }
}

@MainActor
final class BoardCrypto {
    static let shared = BoardCrypto()
    private static let info = Data("agent-soup board key v2".utf8)
    private var keys: [String: [Int: SymmetricKey]] = [:] // board → epoch → key (memory only)
    private let pinUpdates = PinMutationQueue()

    /// A pin change made outside a sync (Approve, Trust) waits its turn, so a sync paused mid-adopt can't save an older copy over it (opus-a #5779).
    func mutatePins<T>(_ change: @escaping @MainActor () -> T) async -> T { await pinUpdates.run { change() } }

    // MARK: - This phone's device key

    /// In the .e2e Keychain group (DeviceKeyStore: not the share extension's), moved there once from the app's group.
    /// A build without that group (none ships so) keeps it where earlier builds did, rather than a new key each time.
    private var privateKey: Curve25519.KeyAgreement.PrivateKey {
        guard SealedKeys.group != nil else {
            if let raw = Keychain.data(DeviceKeyStore.account), let k = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw) { return k }
            let k = Curve25519.KeyAgreement.PrivateKey()
            Keychain.setData(k.rawRepresentation, for: DeviceKeyStore.account)
            return k
        }
        if !Self.migrated { DeviceKeyStore.migrate(); Self.migrated = true }
        if let raw = DeviceKeyStore.read(), let k = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw) { return k }
        let k = Curve25519.KeyAgreement.PrivateKey()
        DeviceKeyStore.store(k.rawRepresentation)
        return k
    }
    private static var migrated = false
    private var publicKey: Data { privateKey.publicKey.rawRepresentation }
    var publicKeyB64: String { publicKey.base64EncodedString() }

    /// Its Ed25519 signing key (cross-signed device lists, E2E design §2.2), kept next to the device key.
    private var signKey: Curve25519.Signing.PrivateKey {
        if let raw = E2EItem.read("device-sign-key"), let k = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw) { return k }
        let k = Curve25519.Signing.PrivateKey()
        E2EItem.write("device-sign-key", k.rawRepresentation)
        return k
    }
    var signPubB64: String { signKey.publicKey.rawRepresentation.base64EncodedString() }
    /// This phone's fingerprint, from the keys it holds (never the server's copy).
    var fingerprint: String { DeviceTrust.fingerprint(publicKeyB64, signPubB64) }
    func sign(_ data: Data) throws -> String { try signKey.signature(for: data).base64EncodedString() }

    /// The person signed in (AppState sets it): pins are kept per person.
    var user: String?
    private var registering: Task<String, Error>?
    /// Pins the device that approved this one handed it (review #5567), as the server last returned them.
    struct Handed: Decodable { let by: String; let epk: String; let iv: String; let wrapped: String; let sig: String; let bySignPub: String; var byPublicKey: String? = nil; var byLabel: String? = nil }
    private var handed: Handed?
    private var pinsLooked: [String: Int] = [:] // board → keys held when this phone last asked for handed-over pins

    /// This phone's key id on the server, registered once per launch with its signing key (set only with proof this
    /// phone holds the device key: it opens the server's challenge and sends it back). The answer carries any pins
    /// another device of yours handed this one.
    func deviceId() async throws -> String {
        if let r = registering, let kid = try? await r.value { return kid }
        let t = Task { () throws -> String in
            struct R: Decodable { let id: String; var signChallenge: DeviceTrust.Sealed? = nil; var pins: Handed? = nil }
            let d = try await API.shared.send("/api/me/keys", body: ["public_key": publicKeyB64, "label": UIDevice.current.name, "sign_pub": signPubB64])
            let r = try JSONDecoder.soup.decode(R.self, from: d)
            if let c = r.signChallenge, let nonce = DeviceTrust.open(c, with: privateKey, info: DeviceTrust.proofInfo) {
                _ = try? await API.shared.send("/api/me/keys/\(r.id)/sign-key", body: ["nonce": nonce.base64EncodedString()], retries: false)
            }
            handed = r.pins
            UserDefaults.standard.set(r.id, forKey: "agent-soup-device-kid")
            return r.id
        }
        registering = t
        do { return try await t.value } catch { registering = nil; throw error }
    }

    // MARK: - Board keys

    /// Gets this phone's board keys; hands keys on to the devices it trusts that lack them (newcomers read the
    /// history); and, when about to write, opens the board's first or next key (after someone left) for the devices
    /// it trusts. The CLI's boardKeys and the web's epochKeys (docs/SPEC.md §16): pins, first sight only once this phone
    /// holds the board's key, cross-signed devices, removals, the pins your other device handed this one.
    @discardableResult
    func sync(_ board: String, forWriting: Bool = false) async throws -> EpochState {
        let kid = try await deviceId()
        var st = try await API.shared.get("/api/boards/\(board)/epochs", as: EpochState.self)
        // Only AppState's authenticated identity chooses the pin namespace. The server's device list is untrusted.
        let me = user
        // A server showing an older key epoch than this phone has seen may be replaying an old key (review #5526).
        let seen = me.map { Self.epochsSeen($0)[board] ?? 0 } ?? 0
        if st.current < seen { throw BoardCryptoError.rolledBack(shown: st.current, seen: seen) }
        var mine: [Int: SymmetricKey] = [:]
        for g in st.mine where g.kid == kid { if let k = try? unwrap(g) { mine[g.epoch] = k } }
        var trusted: (SignedDevice) -> Bool = { _ in false }
        var waiting = st.current > 0 && mine.isEmpty
        if let me {
            let pinState = st, held = mine.count, pinWaiting = waiting
            if let pin = await pinUpdates.run({ await self.updatePins(me: me, kid: kid, board: board, held: held, waiting: pinWaiting, state: pinState) }) {
                trusted = { DeviceTrust.isPinned(pin, $0) }
                TrustCenter.shared.saw(board: board, me: me, untrusted: st.missing.filter { !trusted($0.device) }.map(\.device), pin: pin, waiting: waiting)
            }
        }
        if forWriting && (st.current == 0 || (st.rotateNeeded && !waiting)) {
            if !st.keys.contains(where: { $0.kid == kid }) || me == nil || user != me { throw BoardCryptoError.waitingForApproval }
            let fresh = SymmetricKey(size: .bits256)
            let grants = try st.keys.filter(trusted).map { k -> [String: Any] in try ["kid": k.kid].merging(wrap(fresh, to: k.publicKey)) { a, _ in a } }
            _ = try await API.shared.send("/api/boards/\(board)/epochs", body: ["epoch": st.current + 1, "grants": grants], retries: false)
            st = try await API.shared.get("/api/boards/\(board)/epochs", as: EpochState.self)
            for g in st.mine where g.kid == kid { if let k = try? unwrap(g) { mine[g.epoch] = k } }
            waiting = false
        }
        // Kept for the notification extension too (Shared/SealedOpen.swift), this device only.
        for (e, k) in mine where keys[board]?[e] == nil { SealedKeys.store(k, board: board, epoch: e) }
        keys[board] = mine
        // Hand on what we hold to the trusted devices that lack it (the server only lists what we're allowed to grant).
        let out = try st.missing.filter { me != nil && user == me && trusted($0.device) }.flatMap { m in try m.epochs.compactMap { e -> [String: Any]? in
            guard let k = mine[e] else { return nil }
            return try ["epoch": e, "kid": m.kid].merging(wrap(k, to: m.publicKey)) { a, _ in a }
        } }
        if !out.isEmpty { _ = try? await API.shared.send("/api/boards/\(board)/grants", body: ["grants": out], retries: false) }
        if let me, st.current > seen { Self.saveEpochSeen(me, board, st.current) }
        // If identity arrived while this sync was in flight, AppState's syncAll may have run before this board was
        // added to `keys`. Revisit it now under the authenticated pin namespace.
        if me == nil && user != nil { Task { _ = try? await self.sync(board) } }
        return st
    }

    private func updatePins(me: String, kid: String, board: String, held: Int, waiting: Bool, state: EpochState) async -> Pins? {
        guard user == me else { return nil }
        var pin = Self.pins(me)
        let before = pin
        await adoptPins(&pin, me: me, kid: kid, board: board, held: held) // before anyone's trusted on first sight
        guard user == me else { return nil }
        let own = DeviceTrust.pinned(pin[me], kid, publicKeyB64), mePin = DeviceTrust.pinId(kid, publicKeyB64, signPubB64)
        if own != mePin { pin[me] = (pin[me] ?? []).filter { $0 != own } + [mePin] }
        // The server showing this phone with someone else's signing key could sign devices as you: say so.
        if let shown = state.keys.first(where: { $0.kid == kid }), shown.signPub != nil, shown.signPub != signPubB64 { TrustCenter.shared.signMismatch = true }
        // First sight only once this phone holds the board's key: until then it hands nothing on, so it pins no one.
        if !waiting { DeviceTrust.firstSight(&pin, me: me, state.keys + state.missing.filter(\.firstDevice).map(\.device)) }
        DeviceTrust.dropGone(&pin, state.keys)
        DeviceTrust.crossSigned(&pin, state.keys + state.missing.map(\.device))
        if pin != before { Self.savePins(pin, me) }
        return pin
    }

    /// Takes the pins the device that approved this one handed it (review #5567), only for people never seen here. The
    /// signature counts against a signing key pinned here for one of your own devices; the server's word for the
    /// signer counts only while this phone knows nobody and never took a bundle (review #5592). Then the approver's
    /// label and fingerprint stay in Settings → Encryption until you say they match.
    private func adoptPins(_ pin: inout Pins, me: String, kid: String, board: String, held: Int) async {
        let doneKey = "pins-from:\(me):\(kid)"
        let done = E2EItem.read(doneKey).flatMap { String(data: $0, encoding: .utf8) }
        let canSigner = (pin[me] ?? []).contains { e in let p = e.split(separator: "|", omittingEmptySubsequences: false); return p.count > 2 && p[0] != kid && !p[2].isEmpty }
        let fresh = done == nil && DeviceTrust.knowsNobody(pin, me: me, kid: kid)
        guard canSigner || fresh else { return }
        // Asked again when this phone's first keys for the board arrive (the approval came after it opened the board).
        if handed == nil, pinsLooked[board] != held {
            pinsLooked[board] = held
            struct R: Decodable { var pins: Handed? = nil }
            handed = (try? await API.shared.get("/api/me/keys?pins=\(kid)", as: R.self))?.pins
        }
        guard user == me else { return }
        guard let h = handed, h.sig != done else { return }
        let signer = DeviceTrust.ownSigner(pin, me: me, kid: h.by)
        guard signer != nil || fresh else { return }
        guard DeviceTrust.verify(signer ?? h.bySignPub, DeviceTrust.pinsSigned(me, kid, epk: h.epk, iv: h.iv, wrapped: h.wrapped), h.sig),
              let got = DeviceTrust.openPins(.init(epk: h.epk, iv: h.iv, wrapped: h.wrapped), with: privateKey) else { return }
        DeviceTrust.mergePins(&pin, got, me: me)
        E2EItem.write(doneKey, Data(h.sig.utf8))
        if signer == nil { TrustCenter.shared.setApprovedBy(.init(label: h.byLabel ?? String(localized: "another device of yours", bundle: .l10n), kid: h.by, fingerprint: DeviceTrust.fingerprint(h.byPublicKey ?? "", h.bySignPub)), me: me) }
    }

    // MARK: - Pins, kept per person in the .e2e Keychain group

    static func pins(_ me: String) -> Pins {
        E2EItem.read("pins:\(me)").flatMap { try? JSONDecoder().decode(Pins.self, from: $0) } ?? [:]
    }
    static func savePins(_ p: Pins, _ me: String) {
        if let d = try? JSONEncoder().encode(p) { E2EItem.write("pins:\(me)", d) }
    }
    static func epochsSeen(_ me: String) -> [String: Int] {
        E2EItem.read("epochs-seen:\(me)").flatMap { try? JSONDecoder().decode([String: Int].self, from: $0) } ?? [:]
    }
    static func saveEpochSeen(_ me: String, _ board: String, _ e: Int) {
        var m = epochsSeen(me); m[board] = e
        if let d = try? JSONEncoder().encode(m) { E2EItem.write("epochs-seen:\(me)", d) }
    }

    /// The keys this phone holds for a board, raw (for an invite link that carries them).
    func heldKeys(_ board: String) async -> [Int: Data] {
        if keys[board] == nil { _ = try? await sync(board) }
        return (keys[board] ?? [:]).mapValues { $0.withUnsafeBytes { Data($0) } }
    }

    /// Re-syncs every encrypted board this phone holds keys for (after you approve or trust a device: it gets them now).
    func syncAll() async {
        for b in SealedKeys.boards().union(keys.keys) { _ = try? await sync(b) }
    }

    /// The board's encrypted messages from `after`, decrypted where this phone holds the key (seq → text).
    func decrypt(_ board: String, after: Int) async -> [Int: String] { (await opened(board, after: after)).mapValues(\.text) }

    /// The same, with each message's extras (title, files).
    func opened(_ board: String, after: Int) async -> [Int: Opened] {
        do {
            if keys[board] == nil { try await sync(board) }
            let r = try await API.shared.get("/api/boards/\(board)/sealed?after=\(after)", as: SealedResponse.self)
            var out: [Int: Opened] = [:]
            for e in r.entries { if let o = open(e.payload, board: board) { out[e.seq] = o } }
            return out
        } catch { return [:] }
    }

    /// One encrypted message's words, if this phone can read it (a notification shows them: Notifications.swift).
    func text(_ board: String, seq: Int) async -> String? {
        do {
            if keys[board] == nil { try await sync(board) }
            let r = try await API.shared.get("/api/boards/\(board)/sealed?after=\(seq - 1)", as: SealedResponse.self, timeout: 8)
            return r.entries.first { $0.seq == seq }.flatMap { open($0.payload, board: board)?.text }
        } catch { return nil }
    }

    /// The board's whole history that this phone can read, for searching it here (LocalSearch.swift): every page of
    /// encrypted messages (200 each, at most 10,000), decrypted in memory and never written anywhere.
    func history(_ board: String) async -> [LocalSearch.Entry] {
        var out: [LocalSearch.Entry] = []
        do {
            try await sync(board)
            var after = 0
            for _ in 0..<50 {
                let r = try await API.shared.get("/api/boards/\(board)/sealed?after=\(after)", as: SealedResponse.self)
                for e in r.entries {
                    if let t = open(e.payload, board: board)?.text { out.append(.init(seq: e.seq, ts: e.ts ?? 0, author: e.author ?? "", via: e.via, type: e.type ?? "note", text: t)) }
                }
                guard let last = r.entries.last?.seq, r.entries.count >= 200 else { break }
                after = last
            }
        } catch {}
        return out
    }

    /// Encrypts a message with the board's current key (opening one first if needed) as a v2 payload; extras, when
    /// there are any, go in `x` under the same key.
    func seal(_ text: String, board: String, extras: SealedExtras? = nil) async throws -> String {
        let st = try await sync(board, forWriting: true)
        guard let key = keys[board]?[st.current] else { throw BoardCryptoError.waitingForApproval }
        let box = try AES.GCM.seal(Data(text.utf8), using: key)
        var payload: [String: Any] = ["v": 2, "epoch": st.current, "iv": Data(box.nonce).base64EncodedString(), "ct": (box.ciphertext + box.tag).base64EncodedString()]
        if let extras, !extras.isEmpty {
            let enc = JSONEncoder(); enc.outputFormatting = .sortedKeys
            let x = try AES.GCM.seal(try enc.encode(extras), using: key)
            payload["x"] = ["iv": Data(x.nonce).base64EncodedString(), "ct": (x.ciphertext + x.tag).base64EncodedString()]
        }
        return String(data: try JSONSerialization.data(withJSONObject: payload), encoding: .utf8)!
    }

    /// Whether a string is a file id as the server issues them (sf_ and 1–40 of a–z, 0–9) or a board id. Ids come from
    /// other members' messages, so nothing else is ever used in a request or a path (#5542).
    nonisolated static func isFileId(_ s: String) -> Bool { s.range(of: "^sf_[a-z0-9]{1,40}$", options: .regularExpression) != nil }
    nonisolated static func isBoardId(_ s: String) -> Bool { s.range(of: "^b_[a-z0-9]{1,40}$", options: .regularExpression) != nil }

    /// A sender's file name as one safe path component: its last part, no separators, never "." or "..".
    nonisolated static func safeName(_ name: String) -> String {
        let n = (name as NSString).lastPathComponent.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
            .replacingOccurrences(of: "\0", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
        return n.isEmpty || n.allSatisfy({ $0 == "." }) ? "file" : String(n.prefix(120))
    }

    /// Where an encrypted message's file lives on this phone once decrypted (named as it's called, for Quick Look); nil
    /// when the message's id or the board isn't well-formed.
    nonisolated static func fileURL(board: String, _ f: SealedFile) -> URL? {
        guard isFileId(f.id), isBoardId(board) else { return nil }
        return sealedRoot.appendingPathComponent(board, isDirectory: true).appendingPathComponent(f.id, isDirectory: true)
            .appendingPathComponent(safeName(f.name), isDirectory: false)
    }
    nonisolated static var sealedRoot: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("sealed", isDirectory: true)
    }

    /// Deletes this phone's decrypted copies of these files (an unsent message's), or all of a board's when `files` is
    /// nil (you left it or were removed). A malformed board or id deletes nothing.
    nonisolated static func wipe(board: String, files: [String]? = nil) {
        guard isBoardId(board) else { return }
        let dir = sealedRoot.appendingPathComponent(board, isDirectory: true)
        guard let files else { try? FileManager.default.removeItem(at: dir); return }
        for id in files where isFileId(id) { try? FileManager.default.removeItem(at: dir.appendingPathComponent(id, isDirectory: true)) }
    }

    /// The ids of the decrypted files a message shows from this phone (its copies at …/sealed/<board>/<id>/<name>).
    /// Read from the path's end, since the app's container moves between launches.
    nonisolated static func fileIds(of e: Entry, board: String) -> [String] {
        ([e.local] + (e.attachments ?? []).map(\.local)).compactMap { $0 }.compactMap { p in
            let c = URL(fileURLWithPath: p).pathComponents
            guard c.count >= 4, c[c.count - 4] == "sealed", c[c.count - 3] == board, isFileId(c[c.count - 2]) else { return nil }
            return c[c.count - 2]
        }
    }

    /// Unsent messages' files: deleted from this phone. `list` has the unsends; `known` the messages they may unsend.
    nonisolated static func wipeUnsent(board: String, in list: [Entry], known: [Entry]) {
        let gone = Set(list.compactMap(\.retracts))
        guard !gone.isEmpty else { return }
        let ids = (list + known).filter { gone.contains($0.seq) }.flatMap { fileIds(of: $0, board: board) }
        if !ids.isEmpty { wipe(board: board, files: ids) }
    }

    /// The file decrypted on this phone: from its cache, else downloaded (ciphertext) and decrypted here.
    func file(board: String, _ f: SealedFile) async throws -> URL {
        guard let u = Self.fileURL(board: board, f) else { throw CryptoKitError.incorrectParameterSize }
        if FileManager.default.fileExists(atPath: u.path) { return u }
        guard let key = Data(base64Encoded: f.key), key.count == 32 else { throw CryptoKitError.incorrectKeySize }
        let blob = try await API.shared.download("/api/boards/\(board)/sealed-files/\(f.id)")
        let plain = try await Task.detached { try SealedFiles.decrypt(blob, key: key, size: f.size) }.value
        try FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
        try plain.write(to: u, options: [.atomic, .completeFileProtection])
        return u
    }

    /// Encrypts a file here and uploads only its ciphertext: its reference for the message's extras.
    func upload(board: String, name: String, mime: String, data: Data, w: Int?, h: Int?, progress: (@Sendable (Double) -> Void)? = nil) async throws -> SealedFile {
        struct R: Decodable { let id: String }
        let (key, blob) = try await Task.detached { try SealedFiles.encrypt(data) }.value
        let d = try await API.shared.upload("/api/boards/\(board)/sealed-files", data: blob, contentType: "application/octet-stream", progress: progress)
        let f = SealedFile(id: try JSONDecoder.soup.decode(R.self, from: d).id, name: name, mime: mime, size: data.count, key: key.base64EncodedString(), chunk: SealedFiles.chunk, w: w, h: h)
        // Already here: keep the plaintext where the message will look for it, so it doesn't download again.
        guard let u = Self.fileURL(board: board, f) else { throw CryptoKitError.incorrectParameterSize }
        try? FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: u, options: [.atomic, .completeFileProtection])
        return f
    }

    /// Whether this phone can read the board right now (false: waiting for one of your devices to add it).
    func canRead(_ board: String) -> Bool { !(keys[board]?.isEmpty ?? true) }

    // MARK: - The scheme

    /// A message as this phone shows it: a credential someone sent is redacted (ClientScan.swift, review #5551 item 6).
    private func open(_ payload: String, board: String) -> Opened? {
        guard let d = payload.data(using: .utf8),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
              j["v"] as? Int == 2, let epoch = j["epoch"] as? Int, let key = keys[board]?[epoch] else { return nil }
        return Self.opened(j, key: key).map { o in
            var x = o.extras
            x.title = x.title.map(ClientScan.redact)
            return Opened(text: ClientScan.redact(o.text), extras: x)
        }
    }

    /// An envelope's text and extras under `key`. The extras are optional: a message without them, or with ones this
    /// phone can't read, still shows its text; they're a member's writing, so only well-formed file references stay.
    nonisolated static func opened(_ j: [String: Any], key: SymmetricKey) -> Opened? {
        guard let plain = gcmOpen(j["iv"], j["ct"], key), let text = String(data: plain, encoding: .utf8) else { return nil }
        let x = j["x"] as? [String: Any]
        var extras = gcmOpen(x?["iv"], x?["ct"], key).flatMap { try? JSONDecoder().decode(SealedExtras.self, from: $0) } ?? SealedExtras()
        extras.files = extras.files?.filter { isFileId($0.id) && $0.size >= 0 }
        return Opened(text: text, extras: extras)
    }

    nonisolated private static func gcmOpen(_ iv: Any?, _ ct: Any?, _ key: SymmetricKey) -> Data? {
        guard let iv = (iv as? String).flatMap({ Data(base64Encoded: $0) }), let ct = (ct as? String).flatMap({ Data(base64Encoded: $0) }), ct.count >= 16,
              let box = try? AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ct.dropLast(16), tag: ct.suffix(16)) else { return nil }
        return try? AES.GCM.open(box, using: key)
    }

    private func kek(_ shared: SharedSecret, epk: Data, devicePublic: Data, info: Data = BoardCrypto.info) -> SymmetricKey {
        shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: epk + devicePublic, sharedInfo: info, outputByteCount: 32)
    }

    /// Opens a v1 envelope sealed to this person's devices (an approval's details on an encrypted board, #5542): nil when
    /// it isn't one, or this phone isn't among its recipients.
    func openForMe(_ envelope: String) -> Data? {
        guard let d = envelope.data(using: .utf8), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], j["v"] as? Int == 1,
              let rs = j["recipients"] as? [[String: Any]] else { return nil }
        let kid = UserDefaults.standard.string(forKey: "agent-soup-device-kid")
        for r in rs where kid == nil || r["kid"] as? String == kid {
            guard let epk = (r["epk"] as? String).flatMap({ Data(base64Encoded: $0) }), let iv = (r["iv"] as? String).flatMap({ Data(base64Encoded: $0) }),
                  let w = (r["wrapped"] as? String).flatMap({ Data(base64Encoded: $0) }), w.count == 48,
                  let shared = try? privateKey.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: epk)),
                  let box = try? AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: w.prefix(32), tag: w.suffix(16)),
                  let content = try? AES.GCM.open(box, using: kek(shared, epk: epk, devicePublic: publicKey, info: Data("agent-soup seal v1".utf8))) else { continue }
            return Self.gcmOpen(j["iv"], j["ct"], SymmetricKey(data: content))
        }
        return nil
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

    /// Off a board (you left, were removed, it was deleted): its keys leave memory and the .e2e Keychain group, and
    /// its decrypted files this phone.
    func forget(board: String) { keys[board] = nil; SealedKeys.forget(board: board); Self.wipe(board: board) }

    /// The encrypted boards you're on now: any other board's keys go (AppState.refreshBoards).
    func keep(only boards: Set<String>) {
        for b in keys.keys where !boards.contains(b) { keys[b] = nil }
        SealedKeys.keep(only: boards)
    }

    /// Signing out: every board key (the .e2e group) and every decrypted file go with the person.
    func forget() {
        keys = [:]
        SealedKeys.forgetAll()
        UserDefaults.standard.removeObject(forKey: "agent-soup-device-kid")
        registering = nil; handed = nil; pinsLooked = [:]; user = nil
        try? FileManager.default.removeItem(at: Self.sealedRoot)
    }
}
