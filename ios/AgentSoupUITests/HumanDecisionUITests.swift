// QA for human decisions (#627): a decision a person posts is for the people to make. theo (his phone) asks one; maya
// sees "Human decision · waiting on you" and Agree / Object, agrees, and it reads "Decided by the people". maya asks one;
// she gets Close, theo objects (from his phone, with a note) and her card shows his ✕ and the note live; she closes it
// as Dropped. Same harness as the others (ios/qa/run.sh against a seeded local server).

import XCTest

final class HumanDecisionUITests: AtteoUITestCase {
    func testHumanDecisions() throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, let b1 = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP)") }
        let a = app()
        a.launch()
        openChat(a, "Checkout bug")

        // theo asks: maya is the one it's waiting on.
        let n = Int(Date().timeIntervalSince1970) % 100000
        let theirs = call("POST", "/api/boards/\(b1)/entries", json: ["type": "decision", "text": "Roll back v42 tonight (\(n))"], token: otherApp)
        let theirSeq = (theirs["entry"] as? [String: Any])?["seq"] as? Int ?? 0
        XCTAssertGreaterThan(theirSeq, 0)
        let pill = a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'decision-pill' AND label CONTAINS 'waiting on you'")).firstMatch
        XCTAssertTrue(pill.waitForExistence(timeout: 8), "his decision arrives, waiting on maya")
        let agree = a.buttons["decision-agree"].firstMatch
        XCTAssertTrue(agree.waitForExistence(timeout: 3) && a.buttons["decision-object"].firstMatch.exists, "Agree / Object for a voter")
        XCTAssertFalse(a.buttons.matching(NSPredicate(format: "identifier == 'decision-close'")).firstMatch.exists, "no Close: it isn't hers")
        shot("hd-01-waiting-on-you")
        agree.tap()
        let decided = a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'decision-pill' AND label == 'Decided by the people'")).firstMatch
        XCTAssertTrue(decided.waitForExistence(timeout: 8), "everyone agreed: decided")
        XCTAssertEqual(a.descendants(matching: .any)["voter-maya"].firstMatch.value as? String, "agreed")
        shot("hd-02-decided")

        // maya asks one: Close is hers; theo objects with a note from his phone, and her card shows it live.
        let mine = call("POST", "/api/boards/\(b1)/entries", json: ["type": "decision", "text": "Ship PAYMENTS_V2 to 5% on Monday (\(n))"])
        let mySeq = (mine["entry"] as? [String: Any])?["seq"] as? Int ?? 0
        XCTAssertGreaterThan(mySeq, 0)
        let waiting = a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'decision-pill' AND label == 'Human decision · waiting on theo'")).firstMatch
        XCTAssertTrue(waiting.waitForExistence(timeout: 8), "hers waits on theo")
        let close = a.buttons["decision-close"].firstMatch
        XCTAssertTrue(close.waitForExistence(timeout: 3), "Close for its author")
        let vote = call("POST", "/api/boards/\(b1)/entries/\(mySeq)/vote", json: ["vote": "object", "note": "Wait for the error budget reset"], token: otherApp)
        XCTAssertEqual(vote["ok"] as? Bool, true)
        let theo = a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'voter-theo' AND value == 'objected'")).firstMatch
        XCTAssertTrue(theo.waitForExistence(timeout: 8), "his ✕ shows live")
        XCTAssertTrue(a.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Wait for the error budget reset'")).firstMatch.waitForExistence(timeout: 3), "with his note")
        shot("hd-03-objected")
        close.tap()
        XCTAssertTrue(a.alerts["Close this decision"].waitForExistence(timeout: 5))
        a.alerts["Close this decision"].buttons["Dropped"].tap()
        let dropped = a.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'decision-pill' AND label == 'Dropped'")).firstMatch
        XCTAssertTrue(dropped.waitForExistence(timeout: 8), "closed as dropped")
        XCTAssertFalse(a.buttons.matching(NSPredicate(format: "identifier == 'decision-close'")).firstMatch.exists, "closed: no more Close")
        shot("hd-04-dropped")

        // The server agrees.
        let hd = ((call("GET", "/api/boards/\(b1)/entries?after=\(mySeq - 1)&limit=1")["entries"] as? [[String: Any]])?.first?["human_decision"] as? [String: Any])
        XCTAssertEqual(hd?["state"] as? String, "dropped")
    }
}
