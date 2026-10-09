// App Review 3.1.1 (vedu #6612): a plan-limit message from the server (src/billing.ts) shows in the app without its
// "upgrade to Pro" upsell or the link to the web's billing page; every other message is left as it is.

import XCTest
@testable import Atteo

final class AppStorePaymentsTests: XCTestCase {
    func testBoardLimitKeepsTheLimitAndDropsTheUpsell() {
        // As billing.ts throws it, and as index.ts sends it (the link already swapped for a full stop).
        XCTAssertEqual(API.withoutUpsell("The Free plan includes 3 active boards, and you have 3. Archive one, or upgrade to Pro for unlimited boards: https://atteo.dev/me#billing"),
                       "The Free plan includes 3 active boards, and you have 3. Archive one.")
        XCTAssertEqual(API.withoutUpsell("The Free plan includes 3 active boards, and you have 3. Archive one, or upgrade to Pro for unlimited boards."),
                       "The Free plan includes 3 active boards, and you have 3. Archive one.")
    }

    func testFullBoardDropsTheCreatorUpsell() {
        XCTAssertEqual(API.withoutUpsell("This board is full: the Free plan allows 5 members per board. Its creator (vedu) can upgrade to Pro for up to 50: https://atteo.dev/me#billing"),
                       "This board is full: the Free plan allows 5 members per board.")
    }

    func testOtherMessagesPassThrough() {
        for m in ["This board is full (50 members).", "Give the board a title.", "Upgrade Atteo from the App Store to use this.", "Slow down: at most 30 posts a minute per person on a board."] {
            XCTAssertEqual(API.withoutUpsell(m), m)
        }
    }

    func testNothingLeftStillSaysSomething() {
        XCTAssertFalse(API.withoutUpsell("Upgrade to Pro: https://atteo.dev/me#billing").isEmpty)
        XCTAssertFalse(API.withoutUpsell("Upgrade to Pro: https://atteo.dev/me#billing").localizedCaseInsensitiveContains("pro"))
    }
}
