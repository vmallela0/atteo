// Agent sessions read apart, as on the web (jxn #2589): two sessions of one person's agent posting in a row are two
// speakers, each with its own sender line ("theo/<session>"), in the chat and in a thread. And thread replies line up
// and never overlap (jxn #2594, #2595): equal insets, a gap between them, and a highlight that stays in its own row.

import XCTest

final class AgentSessionsUITests: AtteoUITestCase {
    private var theoAgent: String { env["AGENT_SOUP_OTHER_TOKEN"] ?? "" }
    private var n: Int { Int(Date().timeIntervalSince1970) % 100_000 }

    /// A session of theo's agent, named; returns its id and the name the server gave it.
    private func session(_ name: String) -> (id: String, name: String)? {
        let r = call("POST", "/api/sessions", json: ["name": name, "client": "Claude Code"], token: theoAgent)
        let s = (r["session"] as? [String: Any]) ?? r
        guard let id = s["id"] as? String else { return nil }
        return (id, s["name"] as? String ?? name)
    }

    /// A post from that session, over MCP (its posts then carry "<session> · Claude Code" as the web reads them).
    @discardableResult
    private func post(_ text: String, board: String, session: String, replyTo: Int? = nil) -> [String: Any] {
        guard let server = env["AGENT_SOUP_SERVER"], let url = URL(string: "\(server)/mcp?board=\(board)") else { return [:] }
        var args: [String: Any] = ["type": "note", "text": text]
        if let replyTo { args["reply_to"] = replyTo }
        var r = URLRequest(url: url)
        r.httpMethod = "POST"
        r.setValue("Bearer \(theoAgent)", forHTTPHeaderField: "authorization")
        r.setValue("application/json", forHTTPHeaderField: "content-type")
        r.setValue("application/json, text/event-stream", forHTTPHeaderField: "accept")
        r.setValue(session, forHTTPHeaderField: "x-atteo-session")
        r.httpBody = try? JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": ["name": "post", "arguments": args]])
        var out: [String: Any] = [:]
        let done = expectation(description: "post")
        URLSession.shared.dataTask(with: r) { d, _, _ in
            out = (d.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? [:]
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 20)
        return out
    }

    private func seq(_ r: [String: Any]) -> Int { (r["entry"] as? [String: Any])?["seq"] as? Int ?? 0 }

    func testTwoSessionsAreTwoSpeakersAndThreadRepliesLineUp() throws {
        continueAfterFailure = false
        guard !otherApp.isEmpty, !theoAgent.isEmpty, let b = boardId(titled: "Checkout bug") else { throw XCTSkip("needs the seeded server (OTHER_APP, OTHER_TOKEN)") }
        let n = n
        guard let s1 = session("scout\(n)"), let s2 = session("probe\(n)") else { return XCTFail("could not start two sessions") }
        let root = seq(call("POST", "/api/boards/\(b)/entries", json: ["type": "note", "text": "Sessions root \(n)"], token: otherApp))
        XCTAssertGreaterThan(root, 0)
        post("First answer \(n) from one session", board: b, session: s1.id, replyTo: root)
        post("Second answer \(n) from the other", board: b, session: s2.id, replyTo: root)

        let a = app()
        a.launch()
        openChat(a, "Checkout bug")
        // In the chat: two runs, each with its own sender line, not one merged speaker.
        let one = a.staticTexts["sender-theo/\(s1.name)"], two = a.staticTexts["sender-theo/\(s2.name)"]
        XCTAssertTrue(one.waitForExistence(timeout: 10), "the first session is named")
        XCTAssertTrue(two.waitForExistence(timeout: 5), "the second session has its own sender line")
        XCTAssertEqual(two.label, "theo's agent, \(s2.name)", "VoiceOver reads whose agent and which session")
        shot("sessions-01-chat")

        // The second answer's quote bar opens the thread on it, lit.
        let quote = a.buttons.matching(NSPredicate(format: "identifier == 'reply-quote' AND label CONTAINS %@", "Sessions root \(n)")).allElementsBoundByIndex.last
        XCTAssertNotNil(quote)
        quote!.tap()
        XCTAssertTrue(a.navigationBars["Thread"].waitForExistence(timeout: 5))
        // Read the highlight's frame first: it fades a moment after the thread opens.
        let lit = a.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'lit-'")).firstMatch
        let litFound = lit.waitForExistence(timeout: 3)
        let litFrame = litFound ? lit.frame : .zero
        let t1 = a.staticTexts.matching(identifier: "sender-theo/\(s1.name)").allElementsBoundByIndex.first { $0.isHittable }
        let t2 = a.staticTexts.matching(identifier: "sender-theo/\(s2.name)").allElementsBoundByIndex.first { $0.isHittable }
        let firstBody = a.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "First answer \(n)")).allElementsBoundByIndex.first { $0.isHittable }
        XCTAssertNotNil(t1, "the thread names the first session"); XCTAssertNotNil(t2, "and the second")
        XCTAssertNotNil(firstBody)
        guard let t1, let t2, let firstBody else { return }
        // Equal insets: both replies start at the same x (jxn #2594).
        XCTAssertEqual(t1.frame.minX, t2.frame.minX, accuracy: 0.5, "the replies line up (\(t1.frame) vs \(t2.frame))")
        // A gap: the second reply starts below where the first one's text ends.
        XCTAssertGreaterThanOrEqual(t2.frame.minY - firstBody.frame.maxY, 2, "a gap between the replies (\(firstBody.frame) then \(t2.frame))")
        // The highlight stays in its own row (jxn #2595): it doesn't reach up over the reply above.
        if litFound {
            XCTAssertGreaterThanOrEqual(litFrame.minY, firstBody.frame.maxY, "the highlight doesn't cover the reply above (\(litFrame) vs \(firstBody.frame))")
            XCTAssertGreaterThanOrEqual(litFrame.minY, t2.frame.minY - 1, "it starts at its own message (\(litFrame) vs \(t2.frame))")
        } else {
            XCTFail("the reply the quote bar opened on is lit")
        }
        shot("sessions-02-thread")
    }
}
