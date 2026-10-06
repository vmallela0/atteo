// QA for the SVG preview (jxn #4265; the web's rule, jxn's agent #4271/#4274): an .svg file posted to Checkout bug shows
// Preview beside it; the sheet draws it as a picture (no Full / Phone, the drawing scales to fit), and a script in the
// file never runs (in an <img> it can't, and the page has JavaScript off). Screenshots also go to
// TEST_RUNNER_PREVIEW_SHOTS=<dir> when it's set.

import XCTest

final class SVGPreviewUITests: AtteoUITestCase {
    /// A drawing with a script that would add a visible "SCRIPT RAN" text if it ever ran, and a remote image it would load.
    static let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160" onload="document.documentElement.appendChild(Object.assign(document.createElementNS('http://www.w3.org/2000/svg','text'),{textContent:'SCRIPT RAN'}))">
      <rect x="10" y="10" width="220" height="140" rx="16" fill="none" stroke="#6a1b24" stroke-width="6"/>
      <circle cx="80" cy="80" r="34" fill="#6a1b24"/>
      <path d="M140 110 L170 50 L200 110 Z" fill="none" stroke="#1c1b19" stroke-width="5" stroke-linejoin="round"/>
      <image href="https://example.com/x.png" x="0" y="0" width="10" height="10"/>
      <script>document.documentElement.appendChild(document.createElementNS('http://www.w3.org/2000/svg','text')).textContent='SCRIPT RAN'</script>
    </svg>
    """

    var shotsDir: String { env["PREVIEW_SHOTS"] ?? "" }

    func save(_ name: String) {
        shot(name)
        guard !shotsDir.isEmpty else { return }
        try? FileManager.default.createDirectory(atPath: shotsDir, withIntermediateDirectories: true)
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: shotsDir).appendingPathComponent("\(name).png"))
    }

    func testSvgPreviewsAsAPicture() throws {
        continueAfterFailure = false
        guard let b = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded Checkout bug board") }
        let name = "drawing-\(Int(Date().timeIntervalSince1970) % 100000).svg"
        let up = call("POST", "/api/boards/\(b)/upload?name=\(name)", data: Data(Self.svg.utf8), contentType: "image/svg+xml")
        XCTAssertEqual(up["_status"] as? Int, 201, "uploaded: \(up)")

        let a = app()
        a.launch()
        openChat(a, "Checkout bug")

        let chip = a.buttons.matching(NSPredicate(format: "identifier == 'chat-file' AND label CONTAINS %@", name)).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 15), "the file is in the chat")
        let previews = a.buttons.matching(identifier: "file-preview")
        XCTAssertTrue(previews.firstMatch.waitForExistence(timeout: 5), "Preview is offered")
        let preview = try XCTUnwrap(previews.allElementsBoundByIndex.min { abs($0.frame.midY - chip.frame.midY) < abs($1.frame.midY - chip.frame.midY) })
        XCTAssertLessThan(abs(preview.frame.midY - chip.frame.midY), 20, "beside this file")
        preview.tap()

        let any = a.descendants(matching: .any)
        XCTAssertTrue(any["preview-sheet"].firstMatch.waitForExistence(timeout: 10), "the preview sheet")
        XCTAssertTrue(a.staticTexts[name].exists, "named")
        XCTAssertFalse(a.buttons["preview-width-full"].exists, "no Full / Phone for a drawing")
        XCTAssertTrue(a.webViews.firstMatch.images.firstMatch.waitForExistence(timeout: 15), "drawn as a picture")
        sleep(1)
        XCTAssertFalse(a.webViews.firstMatch.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'SCRIPT RAN'")).firstMatch.exists, "its script never ran")
        save("svg-preview-01-sheet")

        a.buttons["preview-close"].tap()
        XCTAssertTrue(eventually(any["preview-sheet"].firstMatch, "exists == false"), "closed")
    }
}
