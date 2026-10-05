import XCTest
@testable import Atteo

final class FileChatJumpTests: XCTestCase {
    private func metadata(seq: String = "") -> String {
        """
        {"name":"notes.md","version":2,"updated_by":"maya","updated_at":1234,
         "via":"agent","size":42\(seq)}
        """
    }

    private func document(version: Int = 2, seq: String = "") -> String {
        """
        {"name":"notes.md","version":\(version),"latest":2,"content":"notes",
         "updated_by":"maya","updated_at":1234,"via":"agent"\(seq)}
        """
    }

    func testFilesResponseDecodesPostingSequence() throws {
        let json = "{\"docs\":[\(metadata(seq: ",\"seq\":4359"))]}"
        let response = try JSONDecoder.soup.decode(DocsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.docs.first?.seq, 4359)
        XCTAssertEqual(response.docs.first?.updatedBy, "maya")
    }

    func testViewerUsesTheViewedVersionsPostingSequence() throws {
        let latest = try JSONDecoder.soup.decode(Doc.self, from: Data(document(seq: ",\"seq\":4359").utf8))
        let older = try JSONDecoder.soup.decode(Doc.self, from: Data(document(version: 1, seq: ",\"seq\":123").utf8))
        XCTAssertEqual(latest.seq, 4359)
        XCTAssertEqual(older.seq, 123)
        XCTAssertEqual(older.version, 1)
        XCTAssertEqual(older.latest, 2)
    }

    func testMissingPostingSequenceHidesChatAction() throws {
        // Both the row menu and viewer toolbar require `if let seq`. Older servers omit the field;
        // private (People only / Just mine), unsent and unposted versions return null.
        for field in ["", ",\"seq\":null"] {
            let file = try JSONDecoder.soup.decode(DocMeta.self, from: Data(metadata(seq: field).utf8))
            let viewer = try JSONDecoder.soup.decode(Doc.self, from: Data(document(seq: field).utf8))
            XCTAssertNil(file.seq, "No row action without a visible posting message")
            XCTAssertNil(viewer.seq, "No toolbar action without a visible posting message")
        }
    }
}
