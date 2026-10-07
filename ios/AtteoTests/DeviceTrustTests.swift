import CryptoKit
import XCTest
@testable import Atteo

/// The phone's device trust (DeviceTrust.swift) must match the CLI (cli/src/crosssign.ts, cli/src/sealed.ts) and the web
/// byte for byte. The vectors come from the CLI's own functions in node: X25519 d = 05…05, Ed25519 seed = 03…03.
final class DeviceTrustTests: XCTestCase {
    let A = String(repeating: "A", count: 43) + "=", B = String(repeating: "B", count: 43) + "="
    let xpub = "UKYUCbHd0DJemxa3AOcZ6XcsBwALG9d4bpB8ZT0gSV0=", epub = "7UkoxijRwsbq6QM4kFmVYSlZJzpcY/k2NsFGFKyHN9E="
    var x: Curve25519.KeyAgreement.PrivateKey { try! .init(rawRepresentation: Data(repeating: 5, count: 32)) }
    var ed: Curve25519.Signing.PrivateKey { try! .init(rawRepresentation: Data(repeating: 3, count: 32)) }

    /// CryptoKit's raw private keys are the JWK `d` the CLI and the web use (an invite link's "#" carries it).
    func testKeysAreTheCLIs() {
        XCTAssertEqual(x.publicKey.rawRepresentation.base64EncodedString(), xpub)
        XCTAssertEqual(ed.publicKey.rawRepresentation.base64EncodedString(), epub)
    }

    func testFingerprints() {
        XCTAssertEqual(DeviceTrust.fingerprint(A, B), "d9ee 50b8 e87b c897 9cfd 5228 b85c 2ce0")
        XCTAssertEqual(DeviceTrust.fingerprint(xpub, nil), "fdfd 5762 720e 29cb 18c4 2916 21b3 24eb")
        XCTAssertTrue(DeviceTrust.sameFingerprint("D9EE:50B8-e87b c897 9cfd5228 b85c 2ce0", "d9ee 50b8 e87b c897 9cfd 5228 b85c 2ce0"))
        XCTAssertFalse(DeviceTrust.sameFingerprint("d9ee 50b8", "d9ee 50b8 e87b c897 9cfd 5228 b85c 2ce0"))
        XCTAssertFalse(DeviceTrust.sameFingerprint("", ""))
    }

    /// A device signature the CLI made checks here, and one made here checks with the same key.
    func testDeviceSignatures() throws {
        let cli = "K7dgi2DUy6VPt29WLDAk7NR9MJxsAKJUMINnS17pp2uBT1s3Yg3G5tKFYme3uU8h2I5FYU1kNnizLzZv05sbBw=="
        XCTAssertTrue(DeviceTrust.verify(epub, DeviceTrust.deviceSigned("ana", "k1", xpub, epub), cli))
        XCTAssertFalse(DeviceTrust.verify(epub, DeviceTrust.deviceSigned("ana", "k2", xpub, epub), cli))
        let mine = try ed.signature(for: DeviceTrust.deviceSigned("ana", "k9", A, nil)).base64EncodedString()
        XCTAssertTrue(DeviceTrust.verify(epub, DeviceTrust.deviceSigned("ana", "k9", A, nil), mine))
    }

    /// Pins the CLI sealed to this key, and signed, open here; ones sealed here open with the key they're sealed to.
    func testPinsHandoff() throws {
        let g = DeviceTrust.Sealed(epk: "gnIww4sQ0Lq8KEeiRj8DFqlQ+/bA0u1HeHOVY6+gQzc=", iv: "t26PudWM1OjTsweL",
                                   wrapped: "SAi5dBxSDF6zLxCubIgz/vnLxykgsO41Lr4MC1sSRMu1hZ23+rI7ckuOmNd70cDcOfsvCRjWf3WivYrW/zntiT5UdjJn/XbghwoamgSj9aMkp1It6xmqAZ7Qm26hx7UAFwGEoYZenXiKe9uY4m78h6CtJxa3GgPJU5bxH9dH7GFViHT4WiO19FqM26KtAg==")
        XCTAssertTrue(DeviceTrust.verify(epub, DeviceTrust.pinsSigned("ana", "k2", epk: g.epk, iv: g.iv, wrapped: g.wrapped),
                                         "ZwAHPJh35P5DGiRnEjcvoNstQRnFCtOZkb2QbQ8jpqnoOHYGxwvne9q1BzFKEoFje1+mWsjzOSSfurS6ZDB7DQ=="))
        let got = try XCTUnwrap(DeviceTrust.openPins(g, with: x))
        XCTAssertEqual(got["bo"] as? [String], ["b1|\(A)|\(A)"])
        XCTAssertEqual(got["cy"] as? [String], [])
        XCTAssertNil(DeviceTrust.openPins(g, with: Curve25519.KeyAgreement.PrivateKey()))
        let back = try DeviceTrust.sealPins(["dee": ["d1|\(B)"]], to: xpub)
        XCTAssertEqual(DeviceTrust.openPins(back, with: x)?["dee"] as? [String], ["d1|\(B)"])
    }

    func testInviteDigest() throws {
        XCTAssertEqual(DeviceTrust.keysDigest([2: Data(repeating: 9, count: 32), 1: Data(repeating: 7, count: 32)]), "rnuSX-EUfWuG_2L617DsYaxN4SQi4-ynf2P3shF5Nvo")
        let ik = try DeviceTrust.inviteKey([1: Data(repeating: 7, count: 32)])
        let m = try XCTUnwrap(ik.fragment.wholeMatch(of: /#k=([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})/))
        var d = String(m.1).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/"); d += "="
        let k = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: XCTUnwrap(Data(base64Encoded: d)))
        XCTAssertEqual(k.publicKey.rawRepresentation.base64EncodedString(), ik.publicKey)
        let g = ik.grants[0]
        let raw = DeviceTrust.open(.init(epk: g["epk"] as! String, iv: g["iv"] as! String, wrapped: g["wrapped"] as! String), with: k, info: DeviceTrust.boardInfo)
        XCTAssertEqual(raw, Data(repeating: 7, count: 32))
    }

    /// The CLI's pinning rules: first sight, cross-signing against the pinned signing key, removals, tombstones.
    func testPinning() throws {
        let b1 = SignedDevice(kid: "b1", user: "bo", publicKey: A, signPub: epub)
        var pin: Pins = [:]
        DeviceTrust.firstSight(&pin, me: "ana", [SignedDevice(kid: "a1", user: "ana", publicKey: B), b1])
        XCTAssertEqual(pin, ["bo": ["b1|\(A)|\(epub)"]])
        // b2, signed by b1 (whose signing key is pinned): pinned too, via b1. A forged signature isn't.
        let sig = try ed.signature(for: DeviceTrust.deviceSigned("bo", "b2", B, nil)).base64EncodedString()
        let b2 = SignedDevice(kid: "b2", user: "bo", publicKey: B, signedBy: "b1", sig: sig)
        let b3 = SignedDevice(kid: "b3", user: "bo", publicKey: xpub, signedBy: "b1", sig: sig)
        DeviceTrust.crossSigned(&pin, [b1, b2, b3])
        XCTAssertEqual(pin["bo"], ["b1|\(A)|\(epub)", "b2|\(B)||b1"])
        // b1 removed: b2, trusted through it, goes too, and bo's entry stays (a tombstone).
        DeviceTrust.dropGone(&pin, [b2])
        XCTAssertEqual(pin["bo"], [])
        XCTAssertTrue(DeviceTrust.noneLeft(pin, "bo"))
        DeviceTrust.firstSight(&pin, me: "ana", [SignedDevice(kid: "b9", user: "bo", publicKey: xpub)])
        XCTAssertEqual(pin["bo"], [], "a person seen once is never trusted on first sight again")
    }

    /// Review #5592: a handoff counts against my own pinned device's signing key; otherwise only into nothing.
    func testHandoffRules() {
        let pin: Pins = ["ana": ["a1|\(A)|\(epub)", "a2|\(B)"]]
        XCTAssertEqual(DeviceTrust.ownSigner(pin, me: "ana", kid: "a1"), epub)
        XCTAssertNil(DeviceTrust.ownSigner(pin, me: "ana", kid: "a2"))
        XCTAssertNil(DeviceTrust.ownSigner(pin, me: "ana", kid: "zz"))
        XCTAssertNil(DeviceTrust.ownSigner(["bo": ["b1|\(A)|\(epub)"]], me: "ana", kid: "b1"))
        XCTAssertTrue(DeviceTrust.knowsNobody([:], me: "ana", kid: "a1"))
        XCTAssertTrue(DeviceTrust.knowsNobody(["ana": ["a1|\(A)"]], me: "ana", kid: "a1"))
        XCTAssertFalse(DeviceTrust.knowsNobody(["ana": ["a2|\(A)"]], me: "ana", kid: "a1"))
        XCTAssertFalse(DeviceTrust.knowsNobody(["bo": []], me: "ana", kid: "a1"))
        var mine: Pins = ["cy": ["c1|\(A)"]]
        DeviceTrust.mergePins(&mine, ["bo": ["b1|\(B)", "junk", 7], "cy": ["c9|\(B)"], "ana": ["evil|\(B)"], "dee": [], "Bad Name": ["x|\(B)"]], me: "ana")
        XCTAssertEqual(mine, ["cy": ["c1|\(A)"], "bo": ["b1|\(B)"], "dee": []])
    }
}
