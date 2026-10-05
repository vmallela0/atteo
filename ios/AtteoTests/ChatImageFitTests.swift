// A picture in a message shows whole, never cropped (jxn #2992): ChatImage.fit sizes the frame to the picture's own
// shape, as wide as the column allows and at most ChatImage.maxHeight tall; extreme shapes letterbox in a minimum frame.

import XCTest
@testable import Atteo

final class ChatImageFitTests: XCTestCase {
    private let column: CGFloat = 300

    func testWidePictureUsesTheColumnAndKeepsItsShape() {
        let s = ChatImage.fit(aspect: 0.5, natural: 1280, column: column) // 2:1
        XCTAssertEqual(s.width, 300)
        XCTAssertEqual(s.height, 150)
    }

    func testTallPictureIsCappedAtMaxHeightAndNarrowsToKeepItsShape() {
        let s = ChatImage.fit(aspect: 3, natural: 600, column: column) // 1:3
        XCTAssertEqual(s.height, ChatImage.maxHeight)
        XCTAssertEqual(s.width, ChatImage.maxHeight / 3, accuracy: 0.5)
    }

    func testSmallPictureIsNotBlownUpToTheColumn() {
        let s = ChatImage.fit(aspect: 1, natural: 120, column: column)
        XCTAssertEqual(s.width, 120)
        XCTAssertEqual(s.height, 120)
    }

    func testExtremeShapesLetterboxInsideAMinimumFrame() {
        let thin = ChatImage.fit(aspect: 0.05, natural: 2000, column: column) // 20:1
        XCTAssertEqual(thin.width, 300)
        XCTAssertEqual(thin.height, 48) // the picture sits inside, fitted
        let needle = ChatImage.fit(aspect: 20, natural: 100, column: column) // 1:20
        XCTAssertEqual(needle.height, ChatImage.maxHeight)
        XCTAssertEqual(needle.width, 96)
    }

    func testUnknownShapeIsASquareUntilThePictureArrives() {
        let s = ChatImage.fit(aspect: nil, natural: nil, column: column)
        XCTAssertEqual(s.width, 200)
        XCTAssertEqual(s.height, 200)
        XCTAssertEqual(ChatImage.fit(aspect: nil, natural: nil, column: 150).width, 150)
    }

    func testBeforeTheColumnIsMeasuredAReasonableWidthIsUsed() {
        let s = ChatImage.fit(aspect: 0.5, natural: 1280, column: 0)
        XCTAssertEqual(s.width, 260)
        XCTAssertEqual(s.height, 130)
    }
}
