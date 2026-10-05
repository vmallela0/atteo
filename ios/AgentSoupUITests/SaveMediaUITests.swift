// QA for saving from a chat to the phone (jxn #2684, #2686): long-press a picture → Save to Photos (and Share…), the
// add-only Photos permission asked once, then "Saved to Photos"; the full-screen viewer has its own Save button; a
// file offers Save to Files and Share…. On theo's "Photo review" board, so other boards stay as seeded.

import UIKit
import XCTest

final class SaveMediaUITests: AtteoUITestCase {
    func picture(_ color: UIColor) -> Data {
        let size = CGSize(width: 320, height: 240)
        let f = UIGraphicsImageRendererFormat(); f.scale = 1
        return UIGraphicsImageRenderer(size: size, format: f).image { c in color.setFill(); c.fill(CGRect(origin: .zero, size: size)) }.pngData()!
    }

    /// One file as one message, as theo from his phone (the same multipart upload the app and the web use).
    @discardableResult
    func postFile(_ board: String, _ data: Data, name: String, mime: String, text: String) -> [String: Any] {
        let boundary = "qa-\(UUID().uuidString)"
        var body = Data()
        func field(_ k: String, _ v: String) { body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n".utf8)) }
        field("text", text)
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8))
        body.append(data); body.append(Data("\r\n".utf8))
        if mime.hasPrefix("image/") { field("w", "320"); field("h", "240") }
        field("name", name)
        body.append(Data("--\(boundary)--\r\n".utf8))
        return call("POST", "/api/boards/\(board)/upload", data: body, contentType: "multipart/form-data; boundary=\(boundary)", token: otherApp)
    }

    /// The system's Photos permission prompt (shown by SpringBoard): allow it.
    func allowPhotosIfAsked() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Allow' OR label == 'OK'")).firstMatch
        if allow.waitForExistence(timeout: 6) { allow.tap() }
    }

    func testSavePictureToPhotosAndFileToFiles() throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, let b = boardId(titled: "Photo review") else { throw XCTSkip("needs the seeded server (OTHER_APP, Photo review)") }
        let n = Int(Date().timeIntervalSince1970) % 100000
        postFile(b, picture(.systemGreen), name: "save-\(n).png", mime: "image/png", text: "Save me \(n)")
        postFile(b, Data("notes \(n)\n".utf8), name: "notes-\(n).txt", mime: "text/plain", text: "A file \(n)")

        let a = app()
        a.resetAuthorizationStatus(for: .photos) // ask fresh: the prompt shows, and is allowed below
        a.launch()
        openChat(a, "Photo review")

        // Long-press the picture: Save to Photos and Share… are offered.
        let pictures = a.descendants(matching: .any).matching(identifier: "chat-image")
        XCTAssertTrue(pictures.firstMatch.waitForExistence(timeout: 15), "the picture is in the chat")
        let pic = pictures.element(boundBy: max(0, pictures.count - 1)) // the newest: the one just posted
        XCTAssertTrue(eventually(pic, "value == 'shown'", timeout: 20), "the picture has loaded")
        pic.press(forDuration: 1.0)
        let save = a.buttons["save-to-photos"]
        XCTAssertTrue(save.waitForExistence(timeout: 5), "long-press offers Save to Photos")
        XCTAssertTrue(a.buttons["share-media"].exists, "and Share…")
        XCTAssertFalse(a.buttons["save-to-files"].exists, "a picture goes to Photos, not Files")
        shot("save-01-picture-menu")
        save.tap()
        allowPhotosIfAsked()
        let toast = a.staticTexts["toast"]
        XCTAssertTrue(eventually(toast, "label == 'Saved to Photos'", timeout: 10), "\"Saved to Photos\"")
        shot("save-02-saved-toast")

        // The full-screen viewer has its own Save button (permission granted now: no prompt).
        sleep(3) // the toast goes
        pic.tap()
        XCTAssertTrue(a.descendants(matching: .any)["image-viewer"].waitForExistence(timeout: 10), "the viewer opens")
        let viewerSave = a.buttons["viewer-save-photos"]
        XCTAssertTrue(eventually(viewerSave, "isEnabled == true", timeout: 10), "the viewer's Save to Photos is ready")
        viewerSave.tap()
        // (Two overlays carry the toast id, the app's and the viewer's: look for the words, wherever they show.)
        let saved = a.staticTexts.matching(NSPredicate(format: "label == 'Saved to Photos'")).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 10), "saved from the viewer, toast over it")
        shot("save-03-viewer-saved")
        a.buttons["Close"].firstMatch.tap()

        // A file: Save to Files and Share…, no Photos.
        let files = a.descendants(matching: .any).matching(identifier: "chat-file")
        XCTAssertTrue(files.firstMatch.waitForExistence(timeout: 10), "the file is in the chat")
        files.element(boundBy: max(0, files.count - 1)).press(forDuration: 1.0)
        XCTAssertTrue(a.buttons["save-to-files"].waitForExistence(timeout: 5), "long-press offers Save to Files")
        XCTAssertTrue(a.buttons["share-media"].exists, "and Share…")
        XCTAssertFalse(a.buttons["save-to-photos"].exists, "a text file doesn't go to Photos")
        shot("save-04-file-menu")
    }
}
