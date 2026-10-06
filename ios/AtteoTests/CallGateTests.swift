// The call's Atteo gate (CallGate.swift): the same cases as test/calls.test.ts, so the app, the web page and the server
// agree on which words reach Atteo.

import XCTest
@testable import Atteo

final class CallGateTests: XCTestCase {
    func testSaidToAtteo() {
        for t in ["Atteo, what's next?", "atteo what did we decide", "Hey Atteo, summarize", "ok so atteo can you check", "@atteo status?",
                  "What's on the roadmap, Atteo?", "Ateo, are you there", "  \"Atteo, hi\"", "Atteo"] {
            XCTAssertTrue(CallGate.addressesAtteo(t), t)
        }
    }

    func testOnlyAboutAtteo() {
        for t in ["I asked Atteo yesterday", "Atteo's summary was good", "atteolike", "let's ask atteo later about it", "", "what's next",
                  "the atteo app", "Atteo\u{2019}s reply"] {
            XCTAssertFalse(CallGate.addressesAtteo(t), t)
        }
    }
}
