import Foundation

/// An O(1) key for a native Swift array. Caches must retain the keyed array: that keeps its address alive and makes
/// subsequent edits copy its storage, including edits in the middle that leave the count and last seq unchanged.
struct ArrayStorageIdentity: Equatable {
    private let address: UInt?
    private let count: Int

    init<Element>(_ array: [Element]) {
        address = array.withUnsafeBufferPointer { $0.baseAddress.map { UInt(bitPattern: $0) } }
        count = array.count
    }
}

/// The board structure depends only on these inputs, not draft, scroll position, reactions, or other app updates.
final class BoardRowsCache {
    struct Options: Equatable {
        let me: String?
        let peopleOnly: Bool
        let repliesInThread: Bool
        // rows only reads whether chips exist; their labels and recipients are read separately by each row.
        let hasQuickChips: Bool
    }
    private struct Key: Equatable {
        let entries: ArrayStorageIdentity
        let lastSeq: Int?
        let options: Options
    }

    private var source: [Entry] = [] // retains the storage represented by key
    private var key: Key?
    private var rows: BoardView.Rows?
    private(set) var buildCount = 0

    func value(_ entries: [Entry], options: Options) -> BoardView.Rows {
        let next = Key(entries: ArrayStorageIdentity(entries), lastSeq: entries.last?.seq, options: options)
        if next == key, let rows { return rows }
        let rows = Self.build(entries, options: options)
        source = entries
        key = next
        self.rows = rows
        buildCount += 1
        return rows
    }

    static func build(_ entries: [Entry], options: Options) -> BoardView.Rows {
        let bySeq = Dictionary(entries.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })
        // Retractions aren't messages: their targets read "Unsent" instead.
        let gone = Set(entries.compactMap(\.retracts))
        func filteredOut(_ e: Entry) -> Bool { options.peopleOnly && e.byAgent }
        func folded(_ e: Entry) -> Bool {
            guard options.repliesInThread, e.replyTo != nil, e.retracts == nil,
                  let root = bySeq[ThreadIndex.root(of: e, in: bySeq)], root.seq != e.seq,
                  root.retracts == nil, !filteredOut(root) else { return false }
            return true
        }
        // People's replies still quote hidden agents. A reply stays in the chat if its root isn't loaded or is hidden.
        let shown = entries.filter { $0.retracts == nil && !filteredOut($0) && !folded($0) }
        let replies = Dictionary(grouping: entries.filter { $0.replyTo != nil && $0.retracts == nil && $0.seq > 0 && !gone.contains($0.seq) }, by: { ThreadIndex.root(of: $0, in: bySeq) })
        let latestMine = shown.last { $0.author == options.me && $0.via != "agent" && $0.seq > 0 && $0.type != "task" && !gone.contains($0.seq) }?.seq
        let open = options.hasQuickChips ? Set(ChatSummary.open(entries).questions.map(\.seq)) : []
        return BoardView.Rows(shown: shown, bySeq: bySeq, gone: gone, replies: replies, latestMine: latestMine, openQuestions: open)
    }
}
