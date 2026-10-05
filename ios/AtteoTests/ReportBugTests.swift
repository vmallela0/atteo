// Report a bug (jxn #3336, #3337): the screenshot always fits the server's 2 MB cap, and the form POST /api/bugs reads
// (#3363) carries the note (capped), where you were and the app's facts, with the open board's id only.

import UIKit
import XCTest
@testable import Atteo

@MainActor
final class ReportBugTests: XCTestCase {
    /// A big, noisy picture (noise compresses badly, the worst case for JPEG size).
    private func noisy(_ w: Int, _ h: Int) -> UIImage {
        let fmt = UIGraphicsImageRendererFormat.default()
        fmt.scale = 3
        return UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: fmt).image { ctx in
            var g = SystemRandomNumberGenerator()
            for y in stride(from: 0, to: h, by: 2) {
                for x in stride(from: 0, to: w, by: 2) {
                    UIColor(red: .random(in: 0...1, using: &g), green: .random(in: 0...1, using: &g), blue: .random(in: 0...1, using: &g), alpha: 1).setFill()
                    ctx.fill(CGRect(x: x, y: y, width: 2, height: 2))
                }
            }
        }
    }

    private func field(_ fields: [(name: String, value: String)], _ name: String) -> String? {
        fields.first { $0.name == name }?.value
    }

    func testScreenshotFitsTheServersCap() throws {
        let jpeg = try XCTUnwrap(BugScreenshot.jpeg(noisy(430, 932)))
        XCTAssertLessThanOrEqual(jpeg.count, 1_900_000, "under the 2 MB cap with room to spare")
        XCTAssertEqual(Array(jpeg.prefix(2)), [0xFF, 0xD8], "a JPEG")
        XCTAssertNotNil(UIImage(data: jpeg))
    }

    func testSmallScreenshotKeepsItsSize() throws {
        let img = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 200)).image { ctx in
            UIColor.white.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 100, height: 200))
        }
        let back = try XCTUnwrap(UIImage(data: try XCTUnwrap(BugScreenshot.jpeg(img))))
        XCTAssertEqual(back.size.width * back.scale, img.size.width * img.scale, accuracy: 1, "not shrunk when it already fits")
    }

    func testFieldsCarryTheFactsAndOnlyTheBoardsID() throws {
        BugContext.board = "b_test123"
        defer { BugContext.board = nil }
        let f = BugReportContext.fields(note: "  " + String(repeating: "x", count: 2500))
        XCTAssertEqual(field(f, "note")?.count, 2000, "trimmed and capped at 2000")
        XCTAssertEqual(field(f, "path"), "/b/b_test123")
        let raw = try XCTUnwrap(field(f, "context"))
        XCTAssertLessThanOrEqual(raw.count, 1000, "within the server's context cap")
        let ctx = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: String])
        XCTAssertEqual(Set(ctx.keys), ["app_version", "device", "os", "board"], "the facts, nothing from the chat")
        XCTAssertEqual(ctx["board"], "b_test123")
        XCTAssertTrue(ctx["os"]?.hasPrefix("iOS ") ?? false)
    }

    func testFormIsMultipartWithTheScreenshotOnlyWhenIncluded() throws {
        BugContext.board = nil
        var with = BugReportContext.form(note: "hello", screenshot: Data([0xFF, 0xD8, 0xFF, 0xD9]))
        let a = String(decoding: with.finish(), as: UTF8.self)
        XCTAssertTrue(with.contentType.hasPrefix("multipart/form-data; boundary="))
        XCTAssertTrue(a.contains("name=\"note\"\r\n\r\nhello\r\n"))
        XCTAssertTrue(a.contains("name=\"path\"\r\n\r\napp\r\n"))
        XCTAssertTrue(a.contains("name=\"screenshot\"; filename=\"screenshot.jpg\"\r\nContent-Type: image/jpeg"))
        var without = BugReportContext.form(note: "hello", screenshot: nil)
        XCTAssertFalse(String(decoding: without.finish(), as: UTF8.self).contains("screenshot"), "not ticked: not sent at all")
    }
}
