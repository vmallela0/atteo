// A push for an encrypted board carries ciphertext; the notification extension shows the real words when this phone
// holds the board key (Shared/SealedOpen.swift). PushFixtures.swift is the server's payload (src/pushPayload.ts).

import CryptoKit
import XCTest
@testable import Atteo

final class PushContentTests: XCTestCase {
    private var info: [AnyHashable: Any] { try! JSONSerialization.jsonObject(with: Data(PushFixtures.payload.utf8)) as! [AnyHashable: Any] }
    private var key: SymmetricKey { SymmetricKey(data: Data(base64Encoded: PushFixtures.key)!) }

    func testTheServersPushOpensWithTheBoardKey() {
        var asked: [String] = []
        let shown = PushContent.decrypted(info) { board, epoch in asked.append("\(board):\(epoch)"); return self.key }
        XCTAssertEqual(shown, .init(title: "ann's agent in Secret plans", body: PushFixtures.text))
        XCTAssertEqual(asked, ["b_secret1:3"], "the key for that board and epoch")
    }

    func testWithoutTheKeyTheGenericAlertStays() {
        XCTAssertNil(PushContent.decrypted(info) { _, _ in nil })
        XCTAssertNil(PushContent.decrypted(info) { _, _ in SymmetricKey(size: .bits256) }, "another key doesn't open it")
        var plain = info
        plain["sealed"] = nil
        XCTAssertNil(PushContent.decrypted(plain) { _, _ in self.key })
    }

    func testLongWordsAreCut() throws {
        let box = try AES.GCM.seal(Data(String(repeating: "word ", count: 100).utf8), using: key)
        let payload = #"{"v":2,"epoch":1,"iv":"\#(Data(box.nonce).base64EncodedString())","ct":"\#((box.ciphertext + box.tag).base64EncodedString())"}"#
        let shown = PushContent.decrypted(["board": "b_1", "sealed": payload, "author": "bob"]) { _, _ in self.key }
        XCTAssertEqual(shown?.title, "bob")
        XCTAssertEqual(shown?.body.count, 180)
        XCTAssertTrue(shown?.body.hasSuffix("…") == true)
    }

    func testBoardKeysAreKeptForTheExtensionAndGoOnSignOut() {
        let k = SymmetricKey(size: .bits256)
        SealedKeys.store(k, board: "b_test_push", epoch: 2)
        XCTAssertEqual(SealedKeys.read(board: "b_test_push", epoch: 2).map { $0.withUnsafeBytes { Data($0) } }, k.withUnsafeBytes { Data($0) })
        XCTAssertNil(SealedKeys.read(board: "b_test_push", epoch: 1))
        SealedKeys.forgetAll()
        XCTAssertNil(SealedKeys.read(board: "b_test_push", epoch: 2))
    }
}
