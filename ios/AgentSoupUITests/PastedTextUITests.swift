// Pasted rich text shows as text (vedu #5225): a message of "rich text with attachments -RTFD- data" files (what Macs
// posted before the paste fix) shows one quoted "Pasted text" block, a line per file, not file chips. A file with no
// RTF in it shows its name. Same harness as the others: a local server seeded by ios/qa/seed.mjs, run by ios/qa/run.sh.

import UIKit
import XCTest

final class PastedTextUITests: AtteoUITestCase {
    /// A real flat RTFD written by AppKit (444 bytes): "deploy is green ✅" / "merging now".
    let flat = Data(base64Encoded: "cnRmZAAAAAADAAAAAgAAAAcAAABUWFQucnRmAQAAAC5pAQAAKwAAAAEAAABhAQAAe1xydGYxXGFuc2lcYW5zaWNwZzEyNTJcY29jb2FydGYyOTA3Clxjb2NvYXRleHRzY2FsaW5nMFxjb2NvYXBsYXRmb3JtMHtcZm9udHRibFxmMFxmbmlsXGZjaGFyc2V0MCBIZWx2ZXRpY2FOZXVlO30Ke1xjb2xvcnRibDtccmVkMjU1XGdyZWVuMjU1XGJsdWUyNTU7fQp7XCpcZXhwYW5kZWRjb2xvcnRibDs7fQpccGFyZFx0eDU2MFx0eDExMjBcdHgxNjgwXHR4MjI0MFx0eDI4MDBcdHgzMzYwXHR4MzkyMFx0eDQ0ODBcdHg1MDQwXHR4NTYwMFx0eDYxNjBcdHg2NzIwXHBhcmRpcm5hdHVyYWxccGFydGlnaHRlbmZhY3RvcjAKClxmMFxmczI2IFxjZjAgZGVwbG95IGlzIGdyZWVuIFx1YzBcdTk5ODkgXAptZXJnaW5nIG5vd30BAAAAIwAAAAEAAAAHAAAAVFhULnJ0ZhAAAABqJMVqtgEAAAAAAAAAAAAA")!

    func multipart(_ files: [(String, Data)]) -> (Data, String) {
        let boundary = "atteo-\(UUID().uuidString)"
        var body = Data()
        for (name, data) in files {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: application/octet-stream\r\n\r\n".utf8))
            body.append(data)
            body.append(Data("\r\n".utf8))
        }
        body.append(Data("--\(boundary)--\r\n".utf8))
        return (body, "multipart/form-data; boundary=\(boundary)")
    }

    func testPastedRichTextShowsAsOneQuote() throws {
        let board = try XCTUnwrap(boardId(titled: "Checkout bug"), "the seeded board")
        let words = NSAttributedString(string: "Ship the café fix today 🚀\nthen tell support", attributes: [.font: UIFont.boldSystemFont(ofSize: 15)])
        let rtf = try words.data(from: NSRange(location: 0, length: words.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
        let n = "rich text with attachments -RTFD- data"
        let (body, type) = multipart([(n, flat), ("\(n)-2", rtf), ("\(n)-3", Data([0x9a, 0x11, 0x7b, 0x00, 0x5c, 0x42]))])
        let r = call("POST", "/api/boards/\(board)/upload", data: body, contentType: type)
        XCTAssertTrue((200..<300).contains(r["_status"] as? Int ?? 0), "posted: \(r)")

        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let quote = a.descendants(matching: .any)["pasted-text"].firstMatch
        XCTAssertTrue(quote.waitForExistence(timeout: 15), "the files show as a quote")
        XCTAssertTrue(a.staticTexts["Pasted text"].firstMatch.exists, "labelled Pasted text")
        let line = { (s: String) in a.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", s)).firstMatch }
        XCTAssertTrue(line("deploy is green ✅").waitForExistence(timeout: 10), "a flat RTFD's words")
        XCTAssertTrue(line("Ship the café fix today 🚀").waitForExistence(timeout: 10), "RTF with accents and emoji")
        XCTAssertTrue(a.staticTexts["\(n)-3"].waitForExistence(timeout: 10), "bytes with no RTF show the file's name")
        XCTAssertEqual(a.buttons.matching(identifier: "pasted-original").count, 3, "each line can open its original")
        XCTAssertFalse(a.staticTexts[n].exists, "no file chip named like the pasteboard type")
        shot("pasted-text")
        if let dir = env["AGENT_SOUP_SHOT_DIR"] {
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("pasted-text-ios.png"))
        }
    }
}
