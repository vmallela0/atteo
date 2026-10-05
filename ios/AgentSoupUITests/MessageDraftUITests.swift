import XCTest

final class MessageDraftUITests: AtteoUITestCase {
    func testBoardDraftAppearsInChatRowAndRestores() {
        continueAfterFailure = false
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        let box = composer(a)
        box.tap()
        let typed = "Draft stays when I leave \(Int(Date().timeIntervalSince1970))"
        box.typeText(typed)
        XCTAssertTrue(eventually(box, "value == '\(typed)'"))
        a.navigationBars.buttons.element(boundBy: 0).tap()
        let row = a.buttons["chat-Checkout bug"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(eventually(row, "label CONTAINS 'Draft: \(String(typed.prefix(40)))'"), row.label)
        row.tap()
        XCTAssertTrue(eventually(composer(a), "value == '\(typed)'"))
    }
}
