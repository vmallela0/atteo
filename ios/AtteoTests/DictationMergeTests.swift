// Dictation into the message box (Voice.swift, DictationMerge): what's heard goes after what was there, and what you
// change by hand while it listens (or before its last words land) is never overwritten.

import XCTest
@testable import Atteo

final class DictationMergeTests: XCTestCase {
    func testEmptyBoxTakesWhatsHeard() {
        var m = DictationMerge("")
        XCTAssertEqual(m.merge("", into: ""), "")
        XCTAssertEqual(m.merge("hello", into: ""), "hello")
        XCTAssertEqual(m.merge("hello wor", into: "hello"), "hello wor")
        XCTAssertEqual(m.merge("hello world", into: "hello wor"), "hello world") // partials revise each other
    }

    func testGoesAfterWhatWasThere() {
        var m = DictationMerge("Ship it  ")
        XCTAssertEqual(m.base, "Ship it ")
        XCTAssertEqual(m.merge("after lunch", into: "Ship it  "), "Ship it after lunch")
    }

    /// Dictate, edit by hand, dictate again (a new listen): the edit is where the second one starts.
    func testANewListenStartsFromTheEditedText() {
        var first = DictationMerge("")
        let said = first.merge("deploy the build", into: "")
        let edited = said.replacingOccurrences(of: "build", with: "staging build") + "."
        var second = DictationMerge(edited)
        XCTAssertEqual(second.merge("then ping maya", into: edited), "deploy the staging build. then ping maya")
    }

    /// Edited while it's still listening: the next words go after the edit instead of rewriting the box.
    func testAHandEditWhileListeningStays() {
        var m = DictationMerge("")
        var box = m.merge("please check the", into: "")
        box = "Please check the logs" // typed by hand
        box = m.merge("please check the deploy", into: box)
        XCTAssertEqual(box, "Please check the logs deploy")
        box = m.merge("please check the deploy and roll back", into: box)
        XCTAssertEqual(box, "Please check the logs deploy and roll back")
    }

    /// The final transcript only changes words already in the box (before the edit): the edit wins.
    func testAFinalThatRevisesOldWordsKeepsTheEdit() {
        var m = DictationMerge("")
        var box = m.merge("hello wor", into: "")
        box = "Hello, world!" // fixed by hand
        box = m.merge("hello world", into: box) // the recognizer's final for the same two words
        XCTAssertEqual(box, "Hello, world!")
        box = m.merge("hello world see you", into: box)
        XCTAssertEqual(box, "Hello, world! see you")
    }

    /// Cleared by hand while it listens: only what's said next goes in.
    func testClearedWhileListening() {
        var m = DictationMerge("draft")
        _ = m.merge("one two", into: "draft")
        XCTAssertEqual(m.merge("one two three", into: ""), "three")
    }

    /// "at vedu" → "@vedu" applies to the new words only.
    func testMentionsApplyToNewWords() {
        var m = DictationMerge("hi ")
        let say: (String) -> String = { $0.replacingOccurrences(of: "at vedu", with: "@vedu") }
        XCTAssertEqual(m.merge("at vedu look", into: "hi ", say), "hi @vedu look")
    }

    func testAfter() {
        XCTAssertEqual(DictationMerge.after("", in: " a b "), "a b")
        XCTAssertEqual(DictationMerge.after("a b", in: "a b c"), "c")
        XCTAssertEqual(DictationMerge.after("a b", in: "a bc d"), "d") // not at a word's end: by word count
        XCTAssertEqual(DictationMerge.after("a b", in: "a b"), "")
    }
}
