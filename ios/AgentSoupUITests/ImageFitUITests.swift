// QA for jxn #2992: a picture in a message shows whole, never cropped. An agent's upload carries no width/height, so
// the app used to draw it as a cropped square; now the frame takes the picture's own shape (a 2:1 picture is twice as
// wide as tall, a 1:3 one is capped at the max height and three times as tall as wide). On theo's "Photo review" board.

import UIKit
import XCTest

final class ImageFitUITests: AtteoUITestCase {
    func picture(_ size: CGSize, _ color: UIColor) -> Data {
        let f = UIGraphicsImageRendererFormat(); f.scale = 1
        return UIGraphicsImageRenderer(size: size, format: f).image { c in
            color.setFill(); c.fill(CGRect(origin: .zero, size: size))
            UIColor.white.setFill(); c.cgContext.fillEllipse(in: CGRect(x: 4, y: 4, width: 24, height: 24)) // marks a corner
        }.pngData()!
    }

    /// One picture as its own message, the way an agent's CLI shares it: no w/h fields.
    func postPicture(_ board: String, _ data: Data, name: String) -> [String: Any] {
        let boundary = "qa-\(UUID().uuidString)"
        var body = Data()
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: image/png\r\n\r\n".utf8))
        body.append(data); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return call("POST", "/api/boards/\(board)/upload", data: body, contentType: "multipart/form-data; boundary=\(boundary)", token: otherApp)
    }

    func testPicturesShowWholeInTheirOwnShape() throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, let board = boardId(titled: "Photo review") else { throw XCTSkip("needs the seeded server (OTHER_APP, Photo review)") }
        let n = Int(Date().timeIntervalSince1970) % 100000
        XCTAssertEqual(postPicture(board, picture(CGSize(width: 1280, height: 640), .systemIndigo), name: "wide-\(n).png")["_status"] as? Int, 201)
        XCTAssertEqual(postPicture(board, picture(CGSize(width: 300, height: 900), .systemTeal), name: "tall-\(n).png")["_status"] as? Int, 201)

        let a = app()
        a.launch()
        openChat(a, "Photo review")
        let wide = a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'chat-image' AND label == %@", "wide-\(n).png")).firstMatch
        let tall = a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'chat-image' AND label == %@", "tall-\(n).png")).firstMatch
        XCTAssertTrue(wide.waitForExistence(timeout: 15), "the wide picture is in the chat")
        XCTAssertTrue(tall.waitForExistence(timeout: 15), "the tall picture is in the chat")
        // The frame follows the picture once it has loaded ("shown").
        XCTAssertTrue(eventually(wide, "value == 'shown'", timeout: 15), "the wide picture loads")
        XCTAssertTrue(eventually(tall, "value == 'shown'", timeout: 15), "the tall picture loads")
        sleep(1)

        let w = wide.frame, t = tall.frame
        XCTAssertEqual(w.width / w.height, 2, accuracy: 0.08, "a 2:1 picture is drawn 2:1, not a cropped square (\(w))")
        XCTAssertGreaterThan(w.width, 232, "a wide picture uses the message column's width (\(w))")
        XCTAssertEqual(t.height, 360, accuracy: 1, "a tall picture is capped at the max height (\(t))")
        XCTAssertEqual(t.height / t.width, 3, accuracy: 0.12, "a 1:3 picture keeps its shape (\(t))")
        if !tall.isHittable { a.swipeDown() }
        shot("image-fit-01-wide-and-tall")
    }
}
