import XCTest
@testable import Atteo

/// Atteo in the share sheet (vedu #4110): what's shared becomes the same requests the app makes (ShareCore.swift).
final class ShareCoreTests: XCTestCase {
    private let base = URL(string: "https://atteo.example")!

    private func body(_ r: URLRequest) -> String { String(decoding: r.httpBody ?? Data(), as: UTF8.self) }

    func testWordsAloneAreANote() throws {
        let r = try ShareCore.request(board: "b_1", payloads: [.text("https://example.com/a?b=1")], note: " look at this ", base: base, token: "tok", idempotencyKey: "k1")
        XCTAssertEqual(r.httpMethod, "POST")
        XCTAssertEqual(r.url?.absoluteString, "https://atteo.example/api/boards/b_1/entries")
        XCTAssertEqual(r.value(forHTTPHeaderField: "authorization"), "Bearer tok")
        XCTAssertEqual(r.value(forHTTPHeaderField: "idempotency-key"), "k1")
        XCTAssertEqual(r.value(forHTTPHeaderField: "content-type"), "application/json")
        let json = try JSONSerialization.jsonObject(with: r.httpBody!) as! [String: String]
        XCTAssertEqual(json, ["type": "note", "text": "look at this\nhttps://example.com/a?b=1"], "your note first, then the link")
    }

    func testOnePictureIsTheRawBodyWithItsDetailsInTheQuery() throws {
        let jpeg = Data(repeating: 7, count: 300)
        let r = try ShareCore.request(board: "b_1", payloads: [.file(name: "photo.jpg", mime: "image/jpeg", data: jpeg, width: 640, height: 480)],
                                      note: "a+b & c=d", base: base, token: "tok")
        let c = URLComponents(url: r.url!, resolvingAgainstBaseURL: false)!
        XCTAssertEqual(c.path, "/api/boards/b_1/upload")
        let q = Dictionary(uniqueKeysWithValues: (c.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(q, ["name": "photo.jpg", "w": "640", "h": "480", "text": "a+b & c=d"])
        XCTAssertFalse(r.url!.absoluteString.contains("a+b"), "a literal + is sent as %2B, or the server reads a space")
        XCTAssertEqual(r.value(forHTTPHeaderField: "content-type"), "image/jpeg")
        XCTAssertEqual(r.httpBody, jpeg)
    }

    func testSeveralFilesAreOneMultipartMessage() throws {
        let r = try ShareCore.request(board: "b_1", payloads: [
            .file(name: "a.jpg", mime: "image/jpeg", data: Data("AAA".utf8), width: 10, height: 20),
            .file(name: "notes.pdf", mime: "application/pdf", data: Data("PDF".utf8), width: nil, height: nil),
        ], note: "two things", base: base, token: "tok")
        XCTAssertEqual(r.url?.absoluteString, "https://atteo.example/api/boards/b_1/upload")
        let ct = r.value(forHTTPHeaderField: "content-type") ?? ""
        XCTAssertTrue(ct.hasPrefix("multipart/form-data; boundary=atteo-"))
        let b = body(r)
        XCTAssertTrue(b.contains("name=\"text\"\r\n\r\ntwo things\r\n"))
        let a = b.range(of: "filename=\"a.jpg\"")!, pdf = b.range(of: "filename=\"notes.pdf\"")!
        XCTAssertLessThan(a.lowerBound, pdf.lowerBound, "in the order shared")
        XCTAssertTrue(b.contains("name=\"w\"\r\n\r\n10\r\n") && b.contains("name=\"h\"\r\n\r\n20\r\n"))
        XCTAssertTrue(b.hasSuffix("--\r\n"))
    }

    func testRefusesWhatTheServerWould() {
        let big = Data(count: ShareCore.maxFile + 1)
        XCTAssertThrowsError(try ShareCore.request(board: "b", payloads: [.file(name: "huge.mov", mime: "video/quicktime", data: big, width: nil, height: nil)], note: "", base: base, token: "t")) {
            XCTAssertEqual($0 as? ShareError, .tooLarge("huge.mov"))
        }
        let many = (0..<11).map { SharedPayload.file(name: "f\($0).txt", mime: "text/plain", data: Data("x".utf8), width: nil, height: nil) }
        XCTAssertThrowsError(try ShareCore.request(board: "b", payloads: many, note: "", base: base, token: "t")) { XCTAssertEqual($0 as? ShareError, .tooMany(11)) }
        XCTAssertThrowsError(try ShareCore.request(board: "b", payloads: [.text("  ")], note: " ", base: base, token: "t")) { XCTAssertEqual($0 as? ShareError, .nothing) }
    }

    func testPickableIsRecentFirstWithoutEncryptedOrArchived() {
        let list = [
            ShareBoard(id: "old", title: "Old", lastActivity: 1),
            ShareBoard(id: "sealed", title: "Sealed", lastActivity: 9, encrypted: true),
            ShareBoard(id: "gone", title: "Gone", lastActivity: 8, archived: true),
            ShareBoard(id: "new", title: "New", lastActivity: 5),
        ]
        XCTAssertEqual(ShareCore.pickable(list).map(\.id), ["new", "old"])
    }

    func testSearchMatchesTheNameYouSee() {
        let dm = ShareBoard(id: "dm", title: "maya ↔ priya", kind: "direct", lastActivity: 2)
        let board = ShareBoard(id: "ck", title: "Checkout bug", lastActivity: 1)
        XCTAssertEqual(ShareCore.displayName(dm, me: "maya"), "priya")
        XCTAssertEqual(ShareCore.filter([dm, board], query: "pri", me: "maya").map(\.id), ["dm"])
        XCTAssertEqual(ShareCore.filter([dm, board], query: "maya", me: "maya").map(\.id), [], "a chat isn't found by your own name")
        XCTAssertEqual(ShareCore.filter([dm, board], query: "checkout BUG", me: "maya").map(\.id), ["ck"])
        XCTAssertEqual(ShareCore.filter([dm, board], query: " ", me: nil).count, 2)
    }

    func testReadsTheServersBoardList() throws {
        // GET /api/me/boards as the server answers it: snake_case, with fields the extension doesn't use.
        let json = #"{"user":"maya","boards":[{"live_agents":0,"id":"b_1","title":"Checkout bug","kind":null,"entry_count":3,"last_activity":1791231577896,"last":{"by":"theo","text":"hi"},"encrypted":false,"created_by":"maya","archived":false,"pinned":false,"picture":null,"status":"member"}]}"#
        struct List: Decodable { var user: String? = nil; let boards: [ShareBoard] }
        let l = try ShareCore.decoder.decode(List.self, from: Data(json.utf8))
        XCTAssertEqual(l.user, "maya")
        XCTAssertEqual(l.boards, [ShareBoard(id: "b_1", title: "Checkout bug", kind: nil, lastActivity: 1791231577896, encrypted: false, archived: false)])
    }

    func testFileNamesAreCleanedLikeTheServer() {
        XCTAssertEqual(ShareCore.cleanName("Screenshot 2026-10-05 at 1.09.3…"), "Screenshot 2026-10-05 at 1.09.3-")
        XCTAssertEqual(ShareCore.cleanName("   "), "file")
    }
}
