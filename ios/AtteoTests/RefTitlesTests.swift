import XCTest
@testable import Atteo

final class RefTitlesTests: XCTestCase {
    private func entry(_ seq: Int = 1, text: String = "plain message", title: String? = nil,
                       artifact: String? = nil, retracts: Int? = nil) -> Entry {
        Entry(seq: seq, ts: 0, author: "me", type: "note", text: text, title: title,
              to: nil, via: nil, artifactName: artifact, retracts: retracts)
    }

    private func task(_ seq: Int, title: String) -> WorkTask {
        WorkTask(seq: seq, status: "todo", assignee: nil, assigneeAgent: nil, priority: nil,
                 title: title, body: "", updatedAt: 0)
    }

    private func originalShort(_ e: Entry, words: Int) -> String {
        if let t = e.title?.trimmingCharacters(in: .whitespaces), !t.isEmpty { return t }
        let line = (e.text.split(separator: "\n").first.map(String.init) ?? e.text)
            .replacingOccurrences(of: "@[A-Za-z0-9][A-Za-z0-9_.-]*(?:['’]s\\s+agent)?", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "[*`]", with: "", options: .regularExpression)
        let w = line.split(whereSeparator: \.isWhitespace)
        return w.isEmpty ? (e.artifactName ?? String(localized: "A message", bundle: .l10n)) : w.prefix(words).joined(separator: " ") + (w.count > words ? "…" : "")
    }

    private func originalMap(_ entries: [Entry], _ tasks: [WorkTask]) -> RefTitles {
        var map: [Int: String] = [:]
        for e in entries where e.seq > 0 && e.retracts == nil { map[e.seq] = originalShort(e, words: 6) }
        for t in tasks { map[t.seq] = t.title }
        return RefTitles(map: map)
    }

    func testShortMatchesOriginalWithAndWithoutRegexCharacters() {
        let samples = [
            entry(text: "one two three four five six seven eight"),
            entry(text: "hello @theo and @maya's agent"),
            entry(text: "@theo’s agent **check** the `cart`"),
            entry(text: "**bold** and `code` without mentions"),
            entry(text: "plain first line\n@theo **second** `line`"),
            entry(text: "\n\nleading blank lines then words\nignored"),
            entry(text: "你好 👋  café\t is ready"),
            entry(text: "mail me@theo.com or @ or @_"),
            entry(text: "***```@theo", artifact: "photo.png"),
            entry(text: " \t\n"), entry(text: ""),
            entry(text: "ignored @theo `body`", title: "  Author's title  "),
            entry(text: "use this body", title: " \t "),
        ]
        for sample in samples {
            for words in [1, 6, 7] {
                XCTAssertEqual(ChatSummary.short(sample, words: words), originalShort(sample, words: words), sample.text)
            }
        }
        XCTAssertEqual(ChatSummary.short(entry(text: "@theo’s agent **check** the `cart`")), "check the cart")
    }

    func testOnlyNewOrChangedEntriesAreShortened() {
        var calls: [Int] = []
        let cache = RefTitles.Cache { e in calls.append(e.seq); return ChatSummary.short(e, words: 6) }
        var list = [entry(1, text: "@theo **first**"), entry(2, text: "second")]
        XCTAssertEqual(cache.value(list, []), originalMap(list, []))
        XCTAssertEqual(calls, [1, 2])
        for _ in 0..<100 { _ = cache.value(list, []) }
        XCTAssertEqual(calls, [1, 2])
        list.append(entry(3, text: "`new` message"))
        XCTAssertEqual(cache.value(list, []), originalMap(list, []))
        XCTAssertEqual(calls, [1, 2, 3])
        list.insert(entry(4, text: "older history"), at: 0)
        XCTAssertEqual(cache.value(list, []), originalMap(list, []))
        XCTAssertEqual(calls, [1, 2, 3, 4])
        list[2].text = "edited" // old middle entry, with unchanged count and last seq
        XCTAssertEqual(cache.value(list, []), originalMap(list, []))
        XCTAssertEqual(calls, [1, 2, 3, 4, 2])
        list[2].pending = true // not a title input
        XCTAssertEqual(cache.value(list, []), originalMap(list, []))
        XCTAssertEqual(calls, [1, 2, 3, 4, 2])
    }

    func testTaskOverridesUpdateWithoutShorteningEntriesAgain() {
        var calls = 0
        let cache = RefTitles.Cache { e in calls += 1; return ChatSummary.short(e, words: 6) }
        let list = [entry(1), entry(2)]
        var tasks = [task(1, title: "task title")]
        XCTAssertEqual(cache.value(list, tasks), originalMap(list, tasks))
        XCTAssertEqual(calls, 2)
        tasks[0] = task(1, title: "renamed task") // count and updatedAt unchanged
        XCTAssertEqual(cache.value(list, tasks)(1), "renamed task")
        XCTAssertEqual(calls, 2)
        tasks.append(task(3, title: "task outside the messages"))
        XCTAssertEqual(cache.value(list, tasks), originalMap(list, tasks))
        XCTAssertEqual(cache.value(list, []), originalMap(list, []))
        XCTAssertEqual(calls, 2)
    }

    func testReplacementListsRetractionsAndDuplicateNumbersMatchOriginal() {
        let cache = RefTitles.Cache()
        let lists: [[Entry]] = [
            [entry(1, text: "board one"), entry(2)],
            [entry(1, text: "board two"), entry(2)], // identical old summary key, different board/title
            [entry(1, title: "explicit title"), entry(2)],
            [entry(1, text: "", artifact: "one.png"), entry(2)],
            [entry(1, text: "", artifact: "two.png"), entry(2)],
            [entry(1, retracts: 2), entry(2), entry(-1), entry(0)],
            [entry(2, text: "first duplicate"), entry(2, text: "last duplicate")],
            [entry(2, text: "last duplicate"), entry(2, text: "first duplicate")],
            [], [entry(1)],
        ]
        for list in lists { XCTAssertEqual(cache.value(list, []), originalMap(list, [])) }
    }

    @MainActor func testSharedCacheDetectsAnEarlierDecryptedMessage() {
        var list = [entry(101, text: "ciphertext"), entry(102)]
        XCTAssertEqual(RefTitles.cached(list, []), originalMap(list, []))
        list[0].text = "decrypted words" // the old key never noticed this change
        XCTAssertEqual(RefTitles.cached(list, []), originalMap(list, []))
    }

    // jxn #4181: a row holds only the titles its own "#123"s need, so a new message (a new title in the chat's map)
    // doesn't make every row again.
    func testOnlyKeepsWhatTheTextsReferTo() {
        let all = RefTitles(map: [1: "Deploy plan", 2: "Retry budget", 3: "Release notes"])
        XCTAssertEqual(all.only("see #2 and #3").map, [2: "Retry budget", 3: "Release notes"])
        XCTAssertEqual(all.only("no refs here", nil).map, [:])
        XCTAssertEqual(all.only("about #9", "answers #1").map, [1: "Deploy plan"], "an unknown number has no title")
        XCTAssertEqual(all.only("issue#2 and &#3;").map, [:], "not a message ref")
        var grown = all
        grown.map[4] = "A new message"
        XCTAssertEqual(grown.only("see #2"), all.only("see #2"), "a new message elsewhere: this row's titles are the same")
    }
}
