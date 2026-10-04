// The preview's CSP must come before anything the page can put first (opus-d #2044).

import XCTest
@testable import Atteo

final class HTMLPreviewTests: XCTestCase {
    func testCspAfterAPlainDoctype() {
        let out = HTMLPreview.withCsp("<!DOCTYPE html><p>x")
        XCTAssertTrue(out.hasPrefix("<!DOCTYPE html>" + HTMLPreview.csp), out)
    }

    func testCspFirstWithoutADoctype() {
        XCTAssertTrue(HTMLPreview.withCsp("<p>x</p><head></head>").hasPrefix(HTMLPreview.csp))
    }

    /// A no-break space isn't whitespace to the HTML parser: the "doctype" after it is text, so the CSP goes first.
    func testNoBreakSpaceBeforeTheDoctypeDoesNotMoveTheCsp() {
        XCTAssertTrue(HTMLPreview.withCsp("\u{00A0}<!doctype html><script>fetch('https://example.com')</script>").hasPrefix(HTMLPreview.csp))
    }

    func testOrdinaryWhitespaceBeforeTheDoctype() {
        XCTAssertTrue(HTMLPreview.withCsp("\n  <!doctype html><p>x").hasPrefix("\n  <!doctype html>" + HTMLPreview.csp))
    }
}
