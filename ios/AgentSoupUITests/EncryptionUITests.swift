import CryptoKit
import XCTest

/// Settings → Encryption (E2E 1c): this phone's fingerprint, and approving a new device of maya's after comparing its
/// fingerprint: the phone signs it into her device list and hands it its pins, sealed to it (as `atteo keys approve`).
final class EncryptionUITests: AtteoUITestCase {
    private func fingerprint(_ pub: String, _ spub: String?) -> String {
        let h = SHA256.hash(data: Data("atteo fingerprint v1\n\(pub)\n\(spub ?? "")".utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        return stride(from: 0, to: 32, by: 4).map { String(h.dropFirst($0).prefix(4)) }.joined(separator: " ")
    }

    func testApproveANewDevice() throws {
        // maya's new laptop: a device key, unsigned (its signing key would take proof of the device key; skipped here).
        let pub = Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation.base64EncodedString()
        let kid = try XCTUnwrap(call("POST", "/api/me/keys", json: ["public_key": pub, "label": "maya's laptop"])["id"] as? String)
        defer { call("DELETE", "/api/me/keys/\(kid)") }
        let fp = fingerprint(pub, nil)

        let a = app()
        a.launch()
        XCTAssertTrue(a.navigationBars["Chats"].waitForExistence(timeout: 15))
        a.buttons["Settings"].firstMatch.tap()
        let row = a.buttons["settings-encryption"]
        for _ in 0..<10 where !(row.exists && row.isHittable) { a.swipeUp(velocity: .slow) }
        row.tap()
        let mine = a.staticTexts["encryption-fingerprint"]
        XCTAssertTrue(mine.waitForExistence(timeout: 10))
        XCTAssertNotNil(mine.label.wholeMatch(of: /[0-9a-f]{4}( [0-9a-f]{4}){7}/), "this phone's fingerprint: \(mine.label)")
        shot("encryption-settings")

        let approve = a.buttons["encryption-approve-\(kid)"]
        XCTAssertTrue(approve.waitForExistence(timeout: 10), "the new laptop waits for an Approve")
        approve.tap()
        let alert = a.alerts.firstMatch
        XCTAssertTrue(alert.waitForExistence(timeout: 5))
        XCTAssertTrue(alert.staticTexts.allElementsBoundByIndex.contains { $0.label.contains(fp) }, "the alert shows the new device's fingerprint before the yes")
        shot("encryption-approve")
        alert.buttons["Approve"].tap()
        XCTAssertTrue(a.staticTexts["Approved here"].waitForExistence(timeout: 15), "approved on this phone")

        // Signed into maya's device list by this phone, and handed this phone's pins (sealed: the server can't read them).
        let keys = call("GET", "/api/me/keys?pins=\(kid)")
        let laptop = (keys["keys"] as? [[String: Any]] ?? []).first { $0["id"] as? String == kid }
        let phone = laptop?["signed_by"] as? String
        XCTAssertNotNil(phone, "signed: \(String(describing: laptop))")
        XCTAssertNotNil(laptop?["sig"] as? String)
        let pins = keys["pins"] as? [String: Any]
        XCTAssertEqual(pins?["by"] as? String, phone, "pins from this phone: \(String(describing: pins))")
        XCTAssertNotNil(pins?["wrapped"] as? String)
    }
}
