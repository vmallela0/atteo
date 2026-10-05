// The Settings drawer's motion (SettingsDrawer.swift): its width, how far a drag opens it, where a release settles, and
// which drags count as sideways (so a scroll never pulls the drawer).

import XCTest
@testable import Atteo

final class DrawerMotionTests: XCTestCase {
    func testWidthLeavesAPeekAndHasLimits() {
        XCTAssertEqual(DrawerMotion.width(for: 390), 390 - DrawerMotion.peek, "a phone: the screen shows beside it")
        XCTAssertEqual(DrawerMotion.width(for: 1024), 420, "an iPad: not wider than 420")
        XCTAssertEqual(DrawerMotion.width(for: 200), 240, "never narrower than 240")
    }

    func testProgressFollowsTheFingerAndStaysInRange() {
        XCTAssertEqual(DrawerMotion.progress(start: 0, dx: 163, width: 326), 0.5, accuracy: 0.001)
        XCTAssertEqual(DrawerMotion.progress(start: 0, dx: -50, width: 326), 0, "can't go past closed")
        XCTAssertEqual(DrawerMotion.progress(start: 0, dx: 900, width: 326), 1, "or past open")
        XCTAssertEqual(DrawerMotion.progress(start: 1, dx: -163, width: 326), 0.5, accuracy: 0.001, "closing from open")
    }

    func testReleaseSettlesPastHalfway() {
        XCTAssertTrue(DrawerMotion.settlesOpen(predicted: 0.7))
        XCTAssertFalse(DrawerMotion.settlesOpen(predicted: 0.3))
        // A short pull flicked hard is predicted past half way: it opens.
        XCTAssertTrue(DrawerMotion.settlesOpen(predicted: DrawerMotion.progress(start: 0, dx: 260, width: 326)))
    }

    func testOnlySidewaysDragsCount() {
        XCTAssertTrue(DrawerMotion.isSideways(CGSize(width: 40, height: 5)))
        XCTAssertFalse(DrawerMotion.isSideways(CGSize(width: 10, height: 40)), "a scroll")
        XCTAssertFalse(DrawerMotion.isSideways(CGSize(width: 30, height: 20)), "diagonal: not enough across")
    }
}
