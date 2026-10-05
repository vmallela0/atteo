// Display names (jxn #4369): the same cleaning and "could pass for someone else" rules as the web's src/names.ts.

import XCTest
@testable import Atteo

final class PersonNameTests: XCTestCase {
    func testInvisibleAndBlankFallBackToTheHandle() {
        XCTAssertEqual(PersonName.clean("Vee\u{202E}\u{200B} Dee\u{2066}"), "Vee Dee")
        XCTAssertNil(PersonName.clean("\u{200B} \u{200F}"))
        XCTAssertNil(PersonName.clean("   "))
        XCTAssertEqual(PersonName.shown("vd", "  "), "vd")
        XCTAssertEqual(PersonName.shown("vd", "Vee"), "Vee")
        XCTAssertEqual(PersonName.shown("vd", nil), "vd")
    }

    func testANameThatPassesForSomeoneElse() {
        XCTAssertTrue(PersonName.looksLikeOther("evil", "jxn", known: ["jxn", "evil"]))
        XCTAssertTrue(PersonName.looksLikeOther("evil", "@anyone", known: []))
        XCTAssertFalse(PersonName.looksLikeOther("vmallela", "Vedu", known: ["jxn"]))
        XCTAssertFalse(PersonName.looksLikeOther("jxn", "JXN", known: ["jxn"]))
    }

    func testAgentsAndSessionsKeepTheHandleForm() {
        let names = ["jxn": "Jxn Park"]
        XCTAssertEqual(PersonName.label("jxn", names: names), "Jxn Park")
        XCTAssertEqual(PersonName.label("jxn's agent", names: names), "jxn's agent")
        XCTAssertEqual(PersonName.label("jxn/opus-b", names: names), "jxn/opus-b")
        XCTAssertEqual(PersonName.label("Jxn's assistant", names: names), "Jxn's assistant")
        XCTAssertEqual(PersonName.spoken("jxn", names: names), "Jxn Park, @jxn")
        XCTAssertEqual(PersonName.spoken("maya", names: [:]), "maya")
    }

    func testADirectTitleUsesChosenNames() {
        XCTAssertEqual(PersonName.boardTitle("vedu ↔ jxn", names: ["jxn": "Jxn Park", "vedu": "Vedu Mallela"]), "Vedu Mallela ↔ Jxn Park")
        XCTAssertEqual(PersonName.boardTitle("Checkout bug", names: ["jxn": "Jxn Park"]), "Checkout bug")
    }

    func testTheMentionMenuShowsTheNameAndStillInsertsTheHandle() {
        let opts = MentionMenu.options(people: ["jxn", "maya"], me: "vedu", named: [:], sessions: [], names: ["jxn": "Jxn Park"])
        let jxn = opts.first { $0.handle == "jxn" }
        XCTAssertEqual(jxn?.alias, "Jxn Park")
        XCTAssertEqual(jxn?.agent, false)
        XCTAssertNil(opts.first { $0.handle == "jxn's agent" }?.alias, "an agent row stays the handle")
        XCTAssertEqual(MentionMenu.filter(opts, query: "jxn p").map(\.handle), ["jxn"], "the start of the chosen name finds them")
        XCTAssertEqual(MentionMenu.filter(opts, query: "jx").map(\.handle), ["jxn", "jxn's agent"])
        XCTAssertFalse(MentionMenu.filter(opts, query: "park").contains { $0.handle == "jxn" }, "only the start of the name, as on the web")
    }
}
