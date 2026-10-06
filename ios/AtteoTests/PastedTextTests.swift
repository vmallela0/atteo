import UIKit
import XCTest
@testable import Atteo

/// Pasted rich text shows as text (vedu #5225): "rich text with attachments -RTFD- data" files read as their words.
final class PastedTextTests: XCTestCase {
    /// A real 444-byte flat RTFD written by AppKit, like the files in #5225.
    private let flat = Data(base64Encoded: "cnRmZAAAAAADAAAAAgAAAAcAAABUWFQucnRmAQAAAC5pAQAAKwAAAAEAAABhAQAAe1xydGYxXGFuc2lcYW5zaWNwZzEyNTJcY29jb2FydGYyOTA3Clxjb2NvYXRleHRzY2FsaW5nMFxjb2NvYXBsYXRmb3JtMHtcZm9udHRibFxmMFxmbmlsXGZjaGFyc2V0MCBIZWx2ZXRpY2FOZXVlO30Ke1xjb2xvcnRibDtccmVkMjU1XGdyZWVuMjU1XGJsdWUyNTU7fQp7XCpcZXhwYW5kZWRjb2xvcnRibDs7fQpccGFyZFx0eDU2MFx0eDExMjBcdHgxNjgwXHR4MjI0MFx0eDI4MDBcdHgzMzYwXHR4MzkyMFx0eDQ0ODBcdHg1MDQwXHR4NTYwMFx0eDYxNjBcdHg2NzIwXHBhcmRpcm5hdHVyYWxccGFydGlnaHRlbmZhY3RvcjAKClxmMFxmczI2IFxjZjAgZGVwbG95IGlzIGdyZWVuIFx1YzBcdTk5ODkgXAptZXJnaW5nIG5vd30BAAAAIwAAAAEAAAAHAAAAVFhULnJ0ZhAAAABqJMVqtgEAAAAAAAAAAAAA")!

    func testKnowsRichTextFilesByNameOrType() {
        for n in ["rich text with attachments -RTFD- data", "rich text with attachments -RTFD- data-2", "Rich Text Format -RTF- data", "notes.rtf", "Notes.RTFD"] {
            XCTAssertTrue(PastedText.isRich(name: n, mime: "application/octet-stream"), n)
        }
        XCTAssertTrue(PastedText.isRich(name: "x", mime: "text/rtf"))
        XCTAssertTrue(PastedText.isRich(name: "x", mime: "com.apple.flat-rtfd"))
        for n in ["report.pdf", "rtfd-notes.txt", "photo.png"] { XCTAssertFalse(PastedText.isRich(name: n, mime: "application/octet-stream"), n) }
        XCTAssertFalse(PastedText.isRich(name: nil, mime: nil))
    }

    func testAFlatRTFDReadsAsItsWords() {
        XCTAssertEqual(PastedText.text(from: flat), "deploy is green ✅\nmerging now")
    }

    func testCocoaRTFWithEmojiAccentsAndAPicture() throws {
        let a = NSMutableAttributedString(string: "Ship the café fix today 🚀\n日本語 “quotes”\n\n<b>not bold</b> ", attributes: [.font: UIFont.boldSystemFont(ofSize: 15)])
        let att = NSTextAttachment()
        att.image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { $0.fill(CGRect(x: 0, y: 0, width: 4, height: 4)) }
        a.append(NSAttributedString(attachment: att))
        let want = "Ship the café fix today 🚀\n日本語 “quotes”\n\n<b>not bold</b>"
        let rtf = try a.data(from: NSRange(location: 0, length: a.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
        XCTAssertEqual(PastedText.text(from: rtf), want)
        let rtfd = try a.data(from: NSRange(location: 0, length: a.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtfd])
        XCTAssertEqual(PastedText.text(from: rtfd), want, "a flat RTFD with a picture: the words, the picture dropped")
    }

    func testBytesWithoutRTFAreNotText() {
        XCTAssertNil(PastedText.text(from: Data([0x9a, 0x11, 0x7b, 0x00, 0x5c])), "an encrypted board's ciphertext keeps its name")
        XCTAssertNil(PastedText.text(from: Data("<html><body>hi</body></html>".utf8)), "never read as HTML")
        XCTAssertNil(PastedText.text(from: Data()))
    }
}
