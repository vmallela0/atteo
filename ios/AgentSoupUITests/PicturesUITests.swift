// QA for several pictures in one message: pasting three sends ONE message (the server has one entry with three
// attachments), shown as a grid; tapping a picture opens a viewer you swipe through ("2 of 3" → "3 of 3"). Five from
// someone else show as 2×2 with "+1". A single picture is unchanged (AgentSoupUITests.testAttachments).

import UIKit
import UniformTypeIdentifiers
import XCTest

final class PicturesUITests: AtteoUITestCase {
    func picture(_ color: UIColor, _ size: CGSize = CGSize(width: 320, height: 240)) -> Data {
        let f = UIGraphicsImageRendererFormat(); f.scale = 1
        return UIGraphicsImageRenderer(size: size, format: f).image { c in
            color.setFill(); c.fill(CGRect(origin: .zero, size: size))
            UIColor.white.withAlphaComponent(0.5).setFill(); c.cgContext.fillEllipse(in: CGRect(x: size.width / 2 - 40, y: size.height / 2 - 40, width: 80, height: 80))
        }.pngData()!
    }

    /// Several files as one message, the way the app and the web send them (multipart), as theo from his phone.
    func postPictures(_ board: String, _ datas: [Data], text: String) -> [String: Any] {
        let boundary = "qa-\(UUID().uuidString)"
        var body = Data()
        func field(_ k: String, _ v: String) { body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n".utf8)) }
        field("text", text)
        for (i, d) in datas.enumerated() {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"shot-\(i + 1).png\"\r\nContent-Type: image/png\r\n\r\n".utf8))
            body.append(d); body.append(Data("\r\n".utf8))
            field("w", "320"); field("h", "240"); field("name", "shot-\(i + 1).png")
        }
        body.append(Data("--\(boundary)--\r\n".utf8))
        return call("POST", "/api/boards/\(board)/upload", data: body, contentType: "multipart/form-data; boundary=\(boundary)", token: otherApp)
    }

    func testSeveralPicturesInOneMessage() throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let n = Int(Date().timeIntervalSince1970) % 100000

        // Three pictures on the clipboard: Paste → three chips → one message.
        let colors: [UIColor] = [.systemTeal, .systemOrange, .systemPurple]
        UIPasteboard.general.items = colors.map { [UTType.png.identifier: picture($0)] }
        let box = composer(a)
        box.tap()
        sleep(1)
        box.press(forDuration: 1.0)
        let paste = a.descendants(matching: .any).matching(NSPredicate(format: "label == 'Paste' AND (elementType == %d OR elementType == %d)",
                                                                        XCUIElement.ElementType.menuItem.rawValue, XCUIElement.ElementType.button.rawValue)).firstMatch
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "Paste is offered")
        paste.tap()
        let chips = a.descendants(matching: .any).matching(identifier: "attachment-chip")
        XCTAssertTrue(eventually(chips.element(boundBy: 2), "exists == true", timeout: 10), "three pictures wait in the box")
        let caption = "Three angles of the empty cart (\(n))"
        box.typeText(caption)
        shot("pics-01-three-chips")
        a.buttons["send"].tap()

        // One message on the server, with all three, in order.
        var entry: [String: Any]?
        for _ in 0..<20 {
            let entries = call("GET", "/api/boards/\(b1)/entries?after=0&limit=500")["entries"] as? [[String: Any]] ?? []
            let mine = entries.filter { ($0["text"] as? String) == caption }
            if !mine.isEmpty { XCTAssertEqual(mine.count, 1, "ONE message, not three"); entry = mine.first; break }
            sleep(1)
        }
        let atts = entry?["attachments"] as? [[String: Any]] ?? []
        XCTAssertEqual(atts.count, 3, "with three pictures")
        XCTAssertTrue(atts.allSatisfy { ($0["mime"] as? String ?? "").hasPrefix("image/") }, "stored as pictures")
        XCTAssertTrue(atts.allSatisfy { ($0["w"] as? Int ?? 0) > 0 && ($0["h"] as? Int ?? 0) > 0 }, "each with its size")

        // In the chat: a grid (one big, two small), shown.
        let grid = a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'picture-grid' AND label == '3 pictures'")).firstMatch
        XCTAssertTrue(grid.waitForExistence(timeout: 10), "a grid of three")
        XCTAssertTrue(eventually(grid, "value == 'shown'", timeout: 20), "sent")
        XCTAssertTrue(a.staticTexts[caption].exists, "the words under it")
        shot("pics-02-grid-of-three")

        // Tap the second: the viewer opens on it; swipe to the third; close.
        grid.descendants(matching: .any)["grid-picture-1"].tap()
        let position = a.staticTexts["gallery-position"]
        XCTAssertTrue(position.waitForExistence(timeout: 5), "the viewer opens")
        XCTAssertEqual(position.label, "2 of 3")
        XCTAssertTrue(a.descendants(matching: .any)["gallery-page"].waitForExistence(timeout: 10), "the picture loads")
        shot("pics-03-viewer")
        a.swipeLeft()
        XCTAssertTrue(eventually(position, "label == '3 of 3'"), "swipes to the next")
        a.buttons["Close"].tap()
        XCTAssertTrue(position.waitForNonExistence(timeout: 5), "closed")

        // Five from theo: 2×2 with "+1" on the last tile.
        let five = postPictures(b1, [UIColor.systemRed, .systemGreen, .systemBlue, .systemYellow, .systemPink].map { picture($0) }, text: "Five from staging (\(n))")
        XCTAssertEqual(((five["entry"] as? [String: Any])?["attachments"] as? [Any])?.count, 5)
        let grid5 = a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'picture-grid' AND label == '5 pictures'")).firstMatch
        XCTAssertTrue(grid5.waitForExistence(timeout: 10), "his five arrive as a grid")
        let more = grid5.descendants(matching: .any)["grid-picture-3"]
        XCTAssertTrue(more.waitForExistence(timeout: 3) && more.label.hasSuffix("and 1 more"), "+1 on the fourth tile")
        XCTAssertFalse(grid5.descendants(matching: .any)["grid-picture-4"].exists, "only four tiles")
        shot("pics-04-grid-of-five")
        more.tap()
        XCTAssertTrue(eventually(position, "label == '4 of 5'", timeout: 5), "the viewer goes through all five")
        a.swipeLeft()
        XCTAssertTrue(eventually(position, "label == '5 of 5'"), "including the fifth")
        a.buttons["Close"].tap()
    }
}
