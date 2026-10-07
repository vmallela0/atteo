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

    /// #5542: a file id comes from another member's message, so it's never a path. Bad ids are dropped when the message
    /// opens, never become a URL on disk, and a sender's name is one safe path component.
    func testFileIdsAndNamesNeverEscapeTheCache() throws {
        let evil = "sf_real?/../../../../Library/x"
        XCTAssertFalse(BoardCrypto.isFileId(evil))
        XCTAssertTrue(BoardCrypto.isFileId("sf_0123456789abcdef0123"))
        let bad = SealedFile(id: evil, name: "x.png", mime: "image/png", size: 1, key: "AAAA")
        XCTAssertNil(BoardCrypto.fileURL(board: "b_abc", bad))
        let good = SealedFile(id: "sf_abc", name: "../../Library/Preferences/x.plist", mime: "text/plain", size: 1, key: "AAAA")
        let u = try XCTUnwrap(BoardCrypto.fileURL(board: "b_abc", good))
        XCTAssertEqual(u.standardizedFileURL.deletingLastPathComponent().lastPathComponent, "sf_abc")
        XCTAssertTrue(u.standardizedFileURL.path.contains("/sealed/b_abc/sf_abc/"))
        XCTAssertNil(BoardCrypto.fileURL(board: "b_abc/../..", good))
        XCTAssertEqual(BoardCrypto.safeName(".."), "file")
        XCTAssertEqual(BoardCrypto.safeName("a/b:c.txt"), "b_c.txt")

        // Opening a message: only well-formed references survive.
        let key = SymmetricKey(size: .bits256)
        func box(_ d: Data) throws -> [String: String] { let b = try AES.GCM.seal(d, using: key); return ["iv": Data(b.nonce).base64EncodedString(), "ct": (b.ciphertext + b.tag).base64EncodedString()] }
        let x = #"{"xv":1,"files":[{"id":"\#(evil)","name":"a","mime":"image/png","size":1,"key":"AAAA"},{"id":"sf_ok1","name":"b","mime":"image/png","size":1,"key":"AAAA"}]}"#
        var j: [String: Any] = try box(Data("hi".utf8))
        j["x"] = try box(Data(x.utf8))
        let o = try XCTUnwrap(BoardCrypto.opened(j, key: key))
        XCTAssertEqual(o.text, "hi")
        XCTAssertEqual(o.extras.files?.map(\.id), ["sf_ok1"])
    }

    /// Unsent: that message's decrypted files leave the phone, others stay. Left or removed: the whole board's go.
    func testUnsendAndLeavingWipeDecryptedFiles() throws {
        let board = "b_wipetest", fm = FileManager.default
        func put(_ id: String, _ name: String) throws -> String {
            let u = try XCTUnwrap(BoardCrypto.fileURL(board: board, SealedFile(id: id, name: name, mime: "image/png", size: 1, key: "AAAA")))
            try fm.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("x".utf8).write(to: u)
            return u.path
        }
        defer { BoardCrypto.wipe(board: board) }
        let a = try put("sf_a1", "a.png"), b = try put("sf_b1", "b.png"), c = try put("sf_c1", "c.png")
        func entry(_ seq: Int, local: String? = nil, attachments: [FileRef]? = nil, retracts: Int? = nil) -> Entry {
            var e = Entry(seq: seq, ts: 0, author: "a", type: "note", text: "", title: nil, to: nil, via: "person", artifactName: nil)
            e.local = local; e.attachments = attachments; e.retracts = retracts
            return e
        }
        // From an older app container: matched by the path's end.
        let moved = "/old/container/Library/Caches/sealed/\(board)/sf_b1/b.png"
        let shown = entry(1, local: a, attachments: [FileRef(name: "a.png", mime: "image/png", local: a), FileRef(name: "b.png", mime: "image/png", local: moved)])
        XCTAssertEqual(BoardCrypto.fileIds(of: shown, board: board), ["sf_a1", "sf_a1", "sf_b1"])
        XCTAssertEqual(BoardCrypto.fileIds(of: entry(9, local: "/tmp/outbox/x/a.png"), board: board), [])
        BoardCrypto.wipeUnsent(board: board, in: [entry(3, retracts: 1)], known: [shown, entry(2, local: c)])
        XCTAssertFalse(fm.fileExists(atPath: a)); XCTAssertFalse(fm.fileExists(atPath: b))
        XCTAssertTrue(fm.fileExists(atPath: c))
        BoardCrypto.wipe(board: "b_../..") // malformed: nothing
        XCTAssertTrue(fm.fileExists(atPath: c))
        BoardCrypto.wipe(board: board)
        XCTAssertFalse(fm.fileExists(atPath: BoardCrypto.sealedRoot.appendingPathComponent(board).path))
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
