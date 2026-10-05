import XCTest
@testable import Atteo

final class ChatRowsTests: XCTestCase {
    private func entry(_ seq: Int, author: String = "me", agent: Bool = false, type: String = "note",
                       replyTo: Int? = nil, retracts: Int? = nil, resolves: [Int]? = nil, supersedes: Int? = nil) -> Entry {
        Entry(seq: seq, ts: Double(seq), author: author, type: type, text: "message \(seq)", title: nil,
              to: nil, via: agent ? "agent" : nil, artifactName: nil, replyTo: replyTo, retracts: retracts,
              resolves: resolves, supersedes: supersedes)
    }

    private var entries: [Entry] {
        [entry(1, agent: true, type: "question"), entry(2, author: "other", replyTo: 1),
         entry(3, replyTo: 2), entry(4, agent: true, type: "question"), entry(5, replyTo: 90),
         entry(6), entry(7, retracts: 6), entry(8, type: "task"), entry(-1),
         entry(9, replyTo: 1), entry(10, retracts: 9), entry(11, type: "question"),
         entry(12, agent: true, resolves: [11]), entry(13, type: "question"),
         entry(14, type: "question", supersedes: 13), entry(15, author: "other", type: "question")]
    }

    // The pre-cache implementation, kept as a parity oracle for filtering, folding, retractions and quick questions.
    private func original(_ list: [Entry], _ options: BoardRowsCache.Options) -> BoardView.Rows {
        let bySeq = Dictionary(list.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })
        let gone = Set(list.compactMap(\.retracts))
        func filteredOut(_ e: Entry) -> Bool { options.peopleOnly && e.byAgent }
        func folded(_ e: Entry) -> Bool {
            guard options.repliesInThread, e.replyTo != nil, e.retracts == nil,
                  let root = bySeq[ThreadIndex.root(of: e, in: bySeq)], root.seq != e.seq,
                  root.retracts == nil, !filteredOut(root) else { return false }
            return true
        }
        let shown = list.filter { $0.retracts == nil && !filteredOut($0) && !folded($0) }
        let replies = Dictionary(grouping: list.filter { $0.replyTo != nil && $0.retracts == nil && $0.seq > 0 && !gone.contains($0.seq) }, by: { ThreadIndex.root(of: $0, in: bySeq) })
        let latest = shown.last { $0.author == options.me && $0.via != "agent" && $0.seq > 0 && $0.type != "task" && !gone.contains($0.seq) }?.seq
        let open = options.hasQuickChips ? Set(ChatSummary.open(list).questions.map(\.seq)) : []
        return BoardView.Rows(shown: shown, bySeq: bySeq, gone: gone, replies: replies, latestMine: latest, openQuestions: open)
    }

    func testMatchesOriginalForEveryDisplayOption() {
        let cache = BoardRowsCache()
        let list = entries
        for me: String? in [nil, "me", "other"] {
            for peopleOnly in [false, true] {
                for repliesInThread in [false, true] {
                    for hasQuickChips in [false, true] {
                        let options = BoardRowsCache.Options(me: me, peopleOnly: peopleOnly, repliesInThread: repliesInThread, hasQuickChips: hasQuickChips)
                        XCTAssertEqual(cache.value(list, options: options), original(list, options))
                    }
                }
            }
        }
    }

    func testHiddenOrMissingRootsKeepPeoplesRepliesVisible() {
        let cache = BoardRowsCache()
        let rows = cache.value(entries, options: .init(me: "me", peopleOnly: true, repliesInThread: true, hasQuickChips: true))
        XCTAssertEqual(rows.shown.map(\.seq), [2, 3, 5, 6, 8, -1, 9, 11, 13, 14, 15])
        XCTAssertEqual(rows.replies.mapValues { $0.map(\.seq) }, [1: [2, 3], 90: [5]])
        XCTAssertEqual(rows.gone, [6, 9])
        XCTAssertEqual(rows.latestMine, 14)
        XCTAssertEqual(rows.openQuestions, [4, 14, 15])
    }

    func testUnchangedStorageIsReusedAcrossBodyPasses() {
        let cache = BoardRowsCache()
        let list = entries
        let options = BoardRowsCache.Options(me: "me", peopleOnly: false, repliesInThread: false, hasQuickChips: false)
        let first = cache.value(list, options: options)
        let sharedCopy = list
        for _ in 0..<100 { XCTAssertEqual(cache.value(sharedCopy, options: options), first) }
        XCTAssertEqual(cache.buildCount, 1)
    }

    func testInvalidatesForEachOption() {
        let cache = BoardRowsCache()
        let list = entries
        let variants: [BoardRowsCache.Options] = [
            .init(me: "me", peopleOnly: false, repliesInThread: false, hasQuickChips: false),
            .init(me: "other", peopleOnly: false, repliesInThread: false, hasQuickChips: false),
            .init(me: "other", peopleOnly: true, repliesInThread: false, hasQuickChips: false),
            .init(me: "other", peopleOnly: true, repliesInThread: true, hasQuickChips: false),
            .init(me: "other", peopleOnly: true, repliesInThread: true, hasQuickChips: true),
        ]
        for (index, options) in variants.enumerated() {
            XCTAssertEqual(cache.value(list, options: options), original(list, options))
            XCTAssertEqual(cache.buildCount, index + 1)
        }
    }

    func testInvalidatesForEditsInTheMiddleAndHistoryChanges() {
        let cache = BoardRowsCache()
        var list = entries
        let options = BoardRowsCache.Options(me: "me", peopleOnly: false, repliesInThread: true, hasQuickChips: true)
        var builds = 0
        func check() {
            builds += 1
            XCTAssertEqual(cache.value(list, options: options), original(list, options))
            XCTAssertEqual(cache.buildCount, builds)
        }
        check()
        list[2].text = "decrypted" // same count and last seq; rows must carry the updated entry
        check()
        list[2].replyTo = 4 // ancestor walks and folding change
        check()
        list.insert(entry(0), at: 0) // prepend older history; last seq is unchanged
        check()
        list.append(entry(16))
        check()
        list.removeFirst()
        check()
        list[list.count - 1] = entry(17) // same count, different last seq
        check()
        list[1].retracts = 1
        check()
    }

    func testEmptyDuplicateAndUnavailableRootListsMatchOriginal() {
        let cache = BoardRowsCache()
        let options = BoardRowsCache.Options(me: nil, peopleOnly: false, repliesInThread: true, hasQuickChips: true)
        let lists: [[Entry]] = [[], [entry(1), entry(1, agent: true), entry(2, replyTo: 1)],
                              [entry(1, replyTo: 99), entry(2, replyTo: 1)],
                              [entry(1, replyTo: 2), entry(2, replyTo: 1)]]
        for list in lists { XCTAssertEqual(cache.value(list, options: options), original(list, options)) }
    }
}
