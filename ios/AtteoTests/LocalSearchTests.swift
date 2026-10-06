// Search on an encrypted board runs on the phone (LocalSearch.swift) and must find what the web page and the CLI find,
// with the same snippets: LocalSearchFixtures.swift holds src/localSearch.ts's answers (test/localSearch.test.ts).

import XCTest
@testable import Atteo

final class LocalSearchTests: XCTestCase {
    private struct Fixture: Decodable {
        struct E: Decodable { let seq: Int; let ts: Double; let author: String; let via: String?; let type: String; let text: String }
        struct H: Decodable { let seq: Int; let snippet: String }
        struct C: Decodable { let q: String; let from: String?; let agent: Bool?; let type: String?; let hits: [H] }
        let entries: [E]
        let cases: [C]
    }

    func testFindsWhatTheWebAndTheCLIFind() throws {
        let f = try JSONDecoder().decode(Fixture.self, from: XCTUnwrap(Data(base64Encoded: LocalSearchFixtures.json)))
        let entries = f.entries.map { LocalSearch.Entry(seq: $0.seq, ts: $0.ts, author: $0.author, via: $0.via, type: $0.type, text: $0.text) }
        XCTAssertGreaterThan(f.cases.count, 20)
        for c in f.cases {
            let got = LocalSearch.search(entries, c.q, from: c.from, agent: c.agent, type: c.type)
            XCTAssertEqual(got.map(\.seq), c.hits.map(\.seq), "“\(c.q)”")
            XCTAssertEqual(got.map(\.snippet), c.hits.map(\.snippet), "“\(c.q)”")
        }
    }

    func testAtMostFifty() {
        let many = (1...80).map { LocalSearch.Entry(seq: $0, ts: Double($0), author: "ann", via: nil, type: "note", text: "deploy \($0)") }
        let got = LocalSearch.search(many, "deploy")
        XCTAssertEqual(got.count, 50)
        XCTAssertEqual(got.first?.seq, 80, "newest first when matches tie")
    }
}
