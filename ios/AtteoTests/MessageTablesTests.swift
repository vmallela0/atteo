import XCTest
@testable import Atteo

/// Pipe tables in a message (MessageBlocks), including ones with no "|---|" line under the header (vedu #5446).
final class MessageTablesTests: XCTestCase {
    private func tables(_ s: String) -> [MarkdownTable] {
        MessageBlocks.parse(s).compactMap { if case .table(let t) = $0 { return t } else { return nil } }
    }

    func testNoSeparatorIsATable() {
        let s = """
        Timed from the start of A's post until B has it, in ms:
        | path | min | p50 | p90 | p99 (n) |
        | ws (channel push's socket) | 441 | 485 | 601 | 842 (n=100) |
        | long-poll (atteo/MCP wait) | 591 | 655 | 939 | 1621 (n=100) |
        The ws push usually reaches B first.
        """
        let blocks = MessageBlocks.parse(s)
        XCTAssertEqual(blocks.count, 3)
        guard case .text(let before) = blocks[0], case .table(let t) = blocks[1], case .text(let after) = blocks[2] else { return XCTFail("\(blocks)") }
        XCTAssertEqual(before, "Timed from the start of A's post until B has it, in ms:")
        XCTAssertEqual(t.header, ["path", "min", "p50", "p90", "p99 (n)"])
        XCTAssertEqual(t.rows.count, 2)
        XCTAssertEqual(t.rows[0][4], "842 (n=100)")
        XCTAssertEqual(t.aligns, [])
        XCTAssertEqual(after, "The ws push usually reaches B first.")
    }

    func testSeparatorPathUnchanged() {
        let t = tables("| Region | p50 |\n|:--|--:|\n| us-east | 41 |")
        XCTAssertEqual(t.count, 1)
        XCTAssertEqual(t.first?.header, ["Region", "p50"])
        XCTAssertEqual(t.first?.aligns, [.leading, .trailing])
        XCTAssertEqual(t.first?.rows, [["us-east", "41"]])
    }

    func testNotTables() {
        XCTAssertTrue(tables("| just one line |").isEmpty)
        XCTAssertTrue(tables("| a | b |").isEmpty, "a single row")
        XCTAssertTrue(tables("| a | b |\n| c | d | e |").isEmpty, "different cell counts")
        XCTAssertTrue(tables("| a |\n| b |").isEmpty, "one cell each")
        XCTAssertTrue(tables("```\n| a | b |\n| c | d |\n```").isEmpty, "inside a code fence")
        XCTAssertEqual(MessageBlocks.parse("no pipes here"), [.text("no pipes here")])
    }

    func testRunStopsAtMismatch() {
        let blocks = MessageBlocks.parse("| a | b |\n| 1 | 2 |\n| x | y | z |")
        guard blocks.count == 2, case .table(let t) = blocks[0], case .text(let rest) = blocks[1] else { return XCTFail("\(blocks)") }
        XCTAssertEqual(t.rows, [["1", "2"]])
        XCTAssertEqual(rest, "| x | y | z |")
    }

    func testNumericCells() {
        for c in ["41", "1,200", "-3.5", "$5", "12%", "485 ms", "842 (n=100)", "~40ms"] { XCTAssertTrue(MarkdownTable.isNumeric(c), c) }
        for c in ["ws", "us-east", "2026-10-06", "p50", "n/a"] { XCTAssertFalse(MarkdownTable.isNumeric(c), c) }
    }
}
