// On an end-to-end encrypted board the phone refuses a credential itself (ClientScan.swift), with the server's own
// rules and words (ClientScan.js, generated from src/secrets.ts; test/clientScan.test.ts checks they agree).

import XCTest
@testable import Atteo

@MainActor
final class ClientScanTests: XCTestCase {
    func testTheRulesShipInTheApp() {
        XCTAssertTrue(ClientScan.ready)
    }

    func testACredentialIsRefusedInTheServersWords() throws {
        let hit = try XCTUnwrap(ClientScan.blocked("deploy with AKIAABCDEFGHIJKLMNOP please"))
        XCTAssertTrue(hit.message.hasPrefix("Blocked: this looks like it contains an AWS access key (line 1)"), hit.message)
        XCTAssertTrue(hit.localizedDescription.contains("nothing was encrypted or sent"))
        XCTAssertNotNil(ClientScan.blocked("notes\npassword = hunter2abc9"))
        XCTAssertNotNil(ClientScan.blocked("-----BEGIN OPENSSH PRIVATE KEY-----"))
    }

    func testOrdinaryWordsGoThrough() {
        XCTAssertNil(ClientScan.blocked("hello there"))
        XCTAssertNil(ClientScan.blocked("password = <your password>"), "a placeholder isn't a secret")
        XCTAssertNil(ClientScan.blocked("db: postgres://admin:${PASS}@db.example.com/app"))
        XCTAssertNil(ClientScan.blocked(""))
    }
}
