// Delete account in the app (App Review 5.1.1(v), jxn #4329): the handle typed back unlocks it, and a deleted
// person's messages read as "Deleted user".

import XCTest
@testable import Atteo

final class DeleteAccountTests: XCTestCase {
    func testTheHandleMustBeTypedBack() {
        XCTAssertTrue(deleteConfirmMatches("maya", handle: "maya"))
        XCTAssertTrue(deleteConfirmMatches(" @Maya ", handle: "maya"))
        XCTAssertFalse(deleteConfirmMatches("may", handle: "maya"))
        XCTAssertFalse(deleteConfirmMatches("theo", handle: "maya"))
        XCTAssertFalse(deleteConfirmMatches("", handle: ""))
    }

    func testTombstonesReadAsDeletedUser() {
        XCTAssertTrue(isDeletedAuthor("deleted-3f9a1c2b7e"))
        XCTAssertFalse(isDeletedAuthor("deleted-user")) // a handle someone could have had before tombstones
        XCTAssertFalse(isDeletedAuthor("deletedfan"))
        XCTAssertFalse(isDeletedAuthor("maya"))
    }
}
