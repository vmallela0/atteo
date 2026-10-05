// jxn #2604: a picture waiting in the message box opens full screen when tapped, before it's sent, and the message
// you're writing (its words and its other attachments) is exactly as it was when the picture closes.

import UniformTypeIdentifiers
import XCTest

final class ComposerPictureUITests: AtteoUITestCase {
    func testTapAnAttachedPictureWhileWriting() throws {
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let box = composer(a)

        // A picture on the clipboard, pasted into the message box.
        let size = CGSize(width: 160, height: 100)
        let png = UIGraphicsImageRenderer(size: size).image { c in
            UIColor(red: 0.20, green: 0.55, blue: 0.85, alpha: 1).setFill(); c.fill(CGRect(origin: .zero, size: size))
        }.pngData()!
        UIPasteboard.general.items = [[UTType.png.identifier: png]]
        box.tap()
        sleep(1)
        box.press(forDuration: 1.0)
        let paste = a.descendants(matching: .any).matching(NSPredicate(format: "label == 'Paste' AND (elementType == %d OR elementType == %d)",
                                                                        XCUIElement.ElementType.menuItem.rawValue, XCUIElement.ElementType.button.rawValue)).firstMatch
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "Paste is offered with a picture on the clipboard")
        paste.tap()
        let chip = a.buttons["attachment-chip"]
        XCTAssertTrue(chip.waitForExistence(timeout: 10), "the picture waits in the message box")

        // Words with it, then a look at the picture.
        let words = "still writing \(Int.random(in: 1000...9999))"
        box.typeText(words)
        XCTAssertTrue(eventually(box, "value CONTAINS '\(words)'"))
        chip.tap()
        let picture = a.descendants(matching: .any)["draft-picture"]
        XCTAssertTrue(picture.waitForExistence(timeout: 5), "the picture opens full screen")
        shot("cp-01-picture-open")

        // Closed: the message is as it was.
        a.buttons["draft-picture-close"].tap()
        XCTAssertTrue(eventually(picture, "exists == false"), "the picture closes")
        XCTAssertTrue(chip.exists, "the picture is still attached")
        XCTAssertTrue(eventually(box, "value CONTAINS '\(words)'"), "the words are still there")
        shot("cp-02-closed")
    }
}
