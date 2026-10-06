import CryptoKit
import XCTest
@testable import Atteo

/// Files on encrypted boards (docs/SPEC.md §16): the phone's chunked AES-GCM must match the CLI's and the web's byte for byte.
final class SealedFilesTests: XCTestCase {
    /// 64 KB + 10 bytes (i % 251) under the key 07…07, encrypted by the CLI's scheme (node, cli/src/sealed.ts encryptFile).
    func testMatchesTheCLI() throws {
        let plain = Data((0..<(65536 + 10)).map { UInt8($0 % 251) })
        let key = SymmetricKey(data: Data(repeating: 7, count: 32))
        var out = Data()
        for i in 0..<2 {
            var n = Data(count: 8); withUnsafeBytes(of: UInt32(i).bigEndian) { n.append(contentsOf: $0) }
            let part = plain[(i * 65536)..<min((i + 1) * 65536, plain.count)]
            let box = try AES.GCM.seal(part, using: key, nonce: AES.GCM.Nonce(data: n))
            out += box.ciphertext + box.tag
        }
        XCTAssertEqual(out.count, 65578)
        XCTAssertEqual(SHA256.hash(data: out).map { String(format: "%02x", $0) }.joined(), "cf37a630e42a8df4651ba029b636018282701603d76b5b6bbca4e6070c5f2e3f")
        XCTAssertEqual(try SealedFiles.decrypt(out, key: Data(repeating: 7, count: 32), size: plain.count), plain)
    }

    func testRoundTripAndEmpty() throws {
        for size in [0, 1, 65536, 65537, 200_000] {
            let plain = Data((0..<size).map { _ in UInt8.random(in: 0...255) })
            let (key, blob) = try SealedFiles.encrypt(plain)
            XCTAssertEqual(key.count, 32)
            XCTAssertEqual(blob.count, size + 16 * max(1, (size + 65535) / 65536), "a 16-byte tag per 64 KB chunk (\(size))")
            XCTAssertEqual(try SealedFiles.decrypt(blob, key: key, size: size), plain)
        }
        // The empty file is one chunk: just the tag (the CLI's: XttReVbhN/4Ul87AqXUMeQ== under 07…07).
        XCTAssertEqual(try SealedFiles.decrypt(Data(base64Encoded: "XttReVbhN/4Ul87AqXUMeQ==")!, key: Data(repeating: 7, count: 32), size: 0), Data())
    }

    func testTamperedOrWrongSizeFails() throws {
        let (key, blob) = try SealedFiles.encrypt(Data("the plan".utf8))
        var bad = blob; bad[0] ^= 1
        XCTAssertThrowsError(try SealedFiles.decrypt(bad, key: key, size: 8))
        XCTAssertThrowsError(try SealedFiles.decrypt(blob, key: key, size: 9))
    }

    /// The extras as the CLI and the web write them; unknown fields are ignored.
    func testExtrasDecode() throws {
        let j = #"{"xv":1,"title":"Q3","files":[{"id":"sf_0123456789abcdef0123","name":"a.png","mime":"image/png","size":3,"key":"AAAA","chunk":65536,"w":2,"h":2}],"later":true}"#
        let x = try JSONDecoder().decode(SealedExtras.self, from: Data(j.utf8))
        XCTAssertEqual(x.title, "Q3")
        XCTAssertEqual(x.files?.first?.w, 2)
        XCTAssertFalse(x.isEmpty)
        XCTAssertTrue(SealedExtras().isEmpty)
    }
}
