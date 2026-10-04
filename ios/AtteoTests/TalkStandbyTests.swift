// A long voice call standing by (TalkStandby.swift, jxn #2071): the quiet timer, play/pause from AirPods and the lock
// screen, the recap the next session gets, and which new messages are read aloud while it waits.

import XCTest
@testable import Atteo

final class TalkStandbyTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)
    private func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

    // MARK: The timer

    func testQuietForFiveSecondsStandsBy() {
        let quiet = TalkStandby.Activity()
        XCTAssertEqual(TalkStandby.defaultIdle, 5)
        XCTAssertFalse(TalkStandby.shouldStandBy(now: at(4.9), lastActive: t0, quiet, idle: 5), "not yet")
        XCTAssertTrue(TalkStandby.shouldStandBy(now: at(5), lastActive: t0, quiet, idle: 5), "five quiet seconds")
        XCTAssertTrue(TalkStandby.shouldStandBy(now: at(60), lastActive: t0, quiet, idle: 5))
        // The clock is from the last moment anything happened, not from the start.
        XCTAssertFalse(TalkStandby.shouldStandBy(now: at(60), lastActive: at(57), quiet, idle: 5))
    }

    func testAnythingGoingOnKeepsItLive() {
        let long = at(120)
        var a = TalkStandby.Activity()
        a.hearing = true
        XCTAssertFalse(TalkStandby.shouldStandBy(now: long, lastActive: t0, a, idle: 5), "the person is talking")
        a = TalkStandby.Activity(); a.speaking = true
        XCTAssertFalse(TalkStandby.shouldStandBy(now: long, lastActive: t0, a, idle: 5), "Atteo is talking")
        a = TalkStandby.Activity(); a.thinking = true
        XCTAssertFalse(TalkStandby.shouldStandBy(now: long, lastActive: t0, a, idle: 5), "an answer is coming")
        a = TalkStandby.Activity(); a.toolsRunning = 1
        XCTAssertFalse(TalkStandby.shouldStandBy(now: long, lastActive: t0, a, idle: 5), "a tool is running")
        a = TalkStandby.Activity(); a.confirmWaiting = true
        XCTAssertFalse(TalkStandby.shouldStandBy(now: long, lastActive: t0, a, idle: 5), "a Yes/No card waits")
        a = TalkStandby.Activity(); a.handsFree = false
        XCTAssertFalse(TalkStandby.shouldStandBy(now: long, lastActive: t0, a, idle: 5), "hold to talk never stands by")
        XCTAssertFalse(a.busy, "hold to talk isn't 'busy', it just has no standby")
        a = TalkStandby.Activity(hearing: false, speaking: false, thinking: false, toolsRunning: 0, confirmWaiting: false)
        XCTAssertFalse(a.busy)
        XCTAssertTrue(TalkStandby.shouldStandBy(now: long, lastActive: t0, a, idle: 5))
    }

    // MARK: Play and pause

    func testPlayPauseFromAirPodsAndTheLockScreen() {
        typealias S = TalkStandby
        XCTAssertEqual(S.action(.play, .standby, handsFree: true), .resume)
        XCTAssertEqual(S.action(.toggle, .standby, handsFree: true), .resume)
        XCTAssertEqual(S.action(.pause, .standby, handsFree: true), .none, "already standing by")
        XCTAssertEqual(S.action(.pause, .live, handsFree: true), .standBy, "pause on AirPods while live: stand by now")
        XCTAssertEqual(S.action(.toggle, .live, handsFree: true), .standBy)
        XCTAssertEqual(S.action(.play, .live, handsFree: true), .none, "already live")
        XCTAssertEqual(S.action(.pause, .live, handsFree: false), .none, "hold to talk has no standby")
        XCTAssertEqual(S.action(.toggle, .live, handsFree: false), .none)
        for c in [S.Command.play, .pause, .toggle] {
            XCTAssertEqual(S.action(c, .connecting, handsFree: true), .none, "connecting: wait")
            XCTAssertEqual(S.action(c, .ended, handsFree: true), .none, "ended: nothing")
        }
    }

    // MARK: The recap

    func testRecapIsShortAndInOrder() {
        XCTAssertEqual(TalkStandby.recap([]), "", "nothing said: nothing added")
        XCTAssertEqual(TalkStandby.recap([("The user", "…"), ("You (Atteo)", "  ")]), "")
        let r = TalkStandby.recap([("The user", "What's waiting for me?"), ("You (Atteo)", "Two messages on Checkout bug."), ("Read aloud to the user while paused", "theo: The deploy is green")])
        XCTAssertTrue(r.contains("picking up again"), r)
        let lines = r.split(separator: "\n").dropFirst()
        XCTAssertEqual(lines, ["The user: What's waiting for me?", "You (Atteo): Two messages on Checkout bug.", "Read aloud to the user while paused: theo: The deploy is green"])
    }

    func testRecapKeepsTheLastFewTurnsWithinBudget() {
        let turns = (1...20).map { ("The user", "Turn \($0) " + String(repeating: "word ", count: 60)) }
        let r = TalkStandby.recap(turns)
        let lines = r.split(separator: "\n").dropFirst()
        XCTAssertLessThanOrEqual(lines.count, 6)
        XCTAssertLessThanOrEqual(lines.joined(separator: "\n").count, 700 + 6, "about 700 characters at most")
        XCTAssertTrue(lines.last!.hasPrefix("The user: Turn 20 "), "the newest is kept")
        XCTAssertTrue(lines.allSatisfy { $0.count <= "The user: ".count + 160 }, "each turn cut short")
        XCTAssertTrue(lines.last!.hasSuffix("…"))
        XCTAssertFalse(r.contains("  "), "whitespace folded")
    }

    // MARK: Which messages are read

    private func entry(_ seq: Int, _ author: String, via: String = "person", text: String = "hello", replyTo: Int? = nil, mentions: [EntryMention]? = nil, pending: Bool? = nil, retracts: Int? = nil) -> Entry {
        var e = Entry(seq: seq, ts: 0, author: author, type: "note", text: text, title: nil, to: nil, via: via, artifactName: nil)
        e.replyTo = replyTo; e.mentions = mentions; e.pending = pending; e.retracts = retracts
        return e
    }

    func testWhichNewMessagesAreRead() {
        let mine: Set<Int> = [3]
        func reads(_ e: Entry, agentChat: Bool = false) -> Bool {
            TalkStandby.worthReading(e, me: "maya", agentChat: agentChat, parentIsMine: { mine.contains($0) })
        }
        XCTAssertTrue(reads(entry(10, "theo")), "a person's message")
        XCTAssertFalse(reads(entry(11, "maya")), "your own")
        XCTAssertFalse(reads(entry(11, "Maya")), "your own, any case")
        XCTAssertFalse(reads(entry(12, "theo", text: "  ")), "nothing to say")
        XCTAssertFalse(reads(entry(-5, "theo")), "still sending")
        XCTAssertFalse(reads(entry(13, "theo", pending: true)))
        XCTAssertFalse(reads(entry(14, "theo", retracts: 10)), "an unsend")
        // Agents: only what's addressed to you.
        XCTAssertFalse(reads(entry(15, "theo", via: "agent")), "agents' chatter")
        XCTAssertFalse(reads(entry(16, "maya", via: "agent")), "your own agent's chatter on a board")
        XCTAssertTrue(reads(entry(17, "theo", via: "agent", mentions: [EntryMention(user: "maya", agent: false)])), "names you")
        XCTAssertFalse(reads(entry(18, "theo", via: "agent", mentions: [EntryMention(user: "maya", agent: true)])), "names your agent, not you")
        XCTAssertTrue(reads(entry(19, "theo", via: "agent", replyTo: 3)), "answers something you wrote")
        XCTAssertFalse(reads(entry(20, "theo", via: "agent", replyTo: 10)), "answers someone else")
        // Your agent's chat: everything your agent says.
        XCTAssertTrue(reads(entry(21, "maya", via: "agent"), agentChat: true))
        XCTAssertFalse(reads(entry(22, "maya"), agentChat: true), "your own words there")
    }
}
