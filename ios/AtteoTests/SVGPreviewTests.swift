// An .svg file previews as an <img> of its own bytes inside a script-free page (jxn #4265; the web's rule, #4271).

import XCTest
@testable import Atteo

final class SVGPreviewTests: XCTestCase {
    private func src(_ page: String) -> Data? {
        guard let r = page.range(of: #"src="data:image/svg\+xml;base64,([A-Za-z0-9+/=]*)""#, options: .regularExpression) else { return nil }
        let attr = String(page[r]).dropFirst(#"src="data:image/svg+xml;base64,"#.count).dropLast()
        return Data(base64Encoded: String(attr))
    }

    func testSvgNamesOnly() {
        XCTAssertTrue(SVGPreview.isSVG("Logo.SVG"))
        XCTAssertTrue(SVGPreview.isSVG("diagrams/flow.svg"))
        XCTAssertFalse(SVGPreview.isSVG("flow.svgz"))
        XCTAssertFalse(SVGPreview.isSVG("notes.html"))
        XCTAssertFalse(SVGPreview.isSVG(nil))
    }

    /// A script in the drawing never reaches the page as markup: it rides inside the base64 image, where an SVG
    /// can't run it.
    func testScriptStaysInsideTheImage() {
        let svg = #"<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>fetch('https://evil.example')</script><image href="https://evil.example/x.png"/></svg>"#
        let page = SVGPreview.page(svg)
        XCTAssertFalse(page.lowercased().contains("<script"), page)
        XCTAssertFalse(page.contains("onload"), page)
        XCTAssertFalse(page.contains("evil.example"), page)
        XCTAssertEqual(src(page), Data(svg.utf8), "the drawing is the file's own bytes")
    }

    /// The CSP is the page's first element after the doctype, and it allows no script and no connection.
    func testCspFirstAndStrict() {
        let page = SVGPreview.page("<svg/>")
        XCTAssertTrue(page.hasPrefix("<!doctype html>" + SVGPreview.csp), page)
        XCTAssertTrue(SVGPreview.csp.contains("default-src 'none'"))
        XCTAssertTrue(SVGPreview.csp.contains("img-src data:"))
        XCTAssertFalse(SVGPreview.csp.contains("script-src"))
        XCTAssertFalse(SVGPreview.csp.contains("connect-src"))
    }

    /// Bytes that aren't UTF-8 (UTF-16 with a BOM, Latin-1) go through untouched: the SVG parser reads their encoding.
    func testNonUtf8BytesPassThroughUnchanged() {
        let utf16 = "<?xml version=\"1.0\" encoding=\"UTF-16\"?><svg xmlns=\"http://www.w3.org/2000/svg\"><text>café</text></svg>".data(using: .utf16)!
        XCTAssertEqual(src(SVGPreview.page(utf16)), utf16)
        let latin1 = "<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><svg xmlns=\"http://www.w3.org/2000/svg\"><text>café</text></svg>".data(using: .isoLatin1)!
        XCTAssertEqual(src(SVGPreview.page(latin1)), latin1)
        XCTAssertNotNil(src(SVGPreview.page(Data([0xFF, 0xFE, 0x00, 0xD8]))), "even broken bytes make a page")
    }
}
