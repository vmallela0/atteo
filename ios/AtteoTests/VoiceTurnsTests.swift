import XCTest
@testable import Atteo

/// When Atteo answers (vedu #2460): where a turn starts and ends from the mic level (TalkTurns), AirPods' press ending
/// a turn in "tap", and the setting in display prefs.
final class VoiceTurnsTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)
    private func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }

    func testSpeechNeedsTwoLoudValuesThenThePauseRunsOut() {
        var t = TalkTurns(pause: 1.5)
        XCTAssertEqual(t.feed(0.8, atteoTalking: false, now: at(0)), .none, "one loud value is a click, not you")
        XCTAssertEqual(t.feed(0.1, atteoTalking: false, now: at(0.1)), .none)
        XCTAssertFalse(t.heard)
        XCTAssertEqual(t.feed(0.7, atteoTalking: false, now: at(0.2)), .none)
        XCTAssertEqual(t.feed(0.7, atteoTalking: false, now: at(0.3)), .started)
        XCTAssertTrue(t.heard && t.hearing)
        XCTAssertNil(t.progress(now: at(0.4)), "no wait while you talk")
        XCTAssertEqual(t.feed(0.38, atteoTalking: false, now: at(0.4)), .none, "between loud and quiet: still talking")
        XCTAssertEqual(t.feed(0.1, atteoTalking: false, now: at(1.0)), .quiet)
        XCTAssertEqual(t.progress(now: at(1.75)) ?? -1, 0.5, accuracy: 0.001)
        XCTAssertFalse(t.due(now: at(2.4)))
        XCTAssertTrue(t.due(now: at(2.5)), "1.5 s of quiet after speaking ends the turn")
        t.reset()
        XCTAssertFalse(t.heard)
        XCTAssertNil(t.progress(now: at(9)))
    }

    func testTalkingAgainStartsThePauseOver() {
        var t = TalkTurns(pause: 1.5)
        _ = t.feed(0.7, atteoTalking: false, now: at(0)); _ = t.feed(0.7, atteoTalking: false, now: at(0.1))
        XCTAssertEqual(t.feed(0.0, atteoTalking: false, now: at(0.2)), .quiet)
        XCTAssertEqual(t.feed(0.7, atteoTalking: false, now: at(1.2)), .none)
        XCTAssertEqual(t.feed(0.7, atteoTalking: false, now: at(1.3)), .again)
        XCTAssertNil(t.progress(now: at(1.9)))
        XCTAssertEqual(t.feed(0.0, atteoTalking: false, now: at(2.0)), .quiet)
        XCTAssertFalse(t.due(now: at(3.4)), "counted from the last quiet, not the first")
        XCTAssertTrue(t.due(now: at(3.5)))
    }

    func testAtteoTalkingNeedsALouderVoiceToBargeIn() {
        var t = TalkTurns()
        _ = t.feed(0.5, atteoTalking: true, now: at(0))
        XCTAssertEqual(t.feed(0.5, atteoTalking: true, now: at(0.1)), .none, "what's left of Atteo's voice isn't you")
        XCTAssertFalse(t.heard)
        _ = t.feed(0.75, atteoTalking: true, now: at(0.2))
        XCTAssertEqual(t.feed(0.75, atteoTalking: true, now: at(0.3)), .started, "you, over it: barge in")
    }

    func testTheFakesLineCountsAsSaidAndQuiet() {
        var t = TalkTurns(pause: 1.5)
        t.spoke(now: at(0))
        XCTAssertTrue(t.heard)
        XCTAssertFalse(t.hearing)
        XCTAssertTrue(t.due(now: at(1.5)))
    }

    func testAirPodsPressEndsATurnInTap() {
        for c in [TalkStandby.Command.play, .pause, .toggle] {
            XCTAssertEqual(TalkStandby.action(c, .live, handsFree: true, endsTurn: true), .endTurn, "\(c)")
        }
        XCTAssertEqual(TalkStandby.action(.pause, .live, handsFree: true, endsTurn: false), .standBy, "nothing said: pause stands by, as before")
        XCTAssertEqual(TalkStandby.action(.play, .standby, handsFree: true, endsTurn: true), .resume, "standing by: play resumes")
    }

    func testVoiceTurnsInDisplayPrefs() throws {
        let d = try JSONDecoder().decode(DisplayPrefs.self, from: Data(#"{"text":"m","voice_turns":"tap"}"#.utf8))
        XCTAssertEqual(d.voiceTurns, "tap")
        XCTAssertTrue(d.voiceTurnsKnown)
        XCTAssertEqual(d.body()["voice_turns"], "tap")
        let old = try JSONDecoder().decode(DisplayPrefs.self, from: Data(#"{"text":"m"}"#.utf8))
        XCTAssertEqual(old.voiceTurns, "pause", "the default")
        XCTAssertFalse(old.voiceTurnsKnown, "a server from before it")
        XCTAssertNil(old.body(turns: false)["voice_turns"], "left out for a server that doesn't take it")
        let odd = try JSONDecoder().decode(DisplayPrefs.self, from: Data(#"{"voice_turns":"called"}"#.utf8))
        XCTAssertEqual(odd.voiceTurns, "pause", "an unknown value is the default")
        XCTAssertEqual(VoiceTurns(server: nil), .quick, "an older server runs its VAD")
        XCTAssertEqual(VoiceTurns(server: "pause"), .pause)
    }

    /// vedu #5329: on the loudspeaker at arm's length speech stayed under the old fixed 0.45, nothing was heard and the
    /// call stood by. In a quiet room, softer speech (0.3, about -38 dBFS) counts.
    func testSoftSpeechInAQuietRoomCounts() {
        var t = TalkTurns(pause: 1.5)
        for i in 0..<30 { _ = t.feed(0.02, atteoTalking: false, now: at(Double(i) * 0.1)) }
        XCTAssertLessThan(t.startAbove, 0.3)
        XCTAssertGreaterThanOrEqual(t.startAbove, TalkTurns.minLoud, "never below -40 dBFS: breathing isn't you")
        _ = t.feed(0.32, atteoTalking: false, now: at(3.1))
        XCTAssertEqual(t.feed(0.33, atteoTalking: false, now: at(3.2)), .started)
        XCTAssertEqual(t.feed(0.05, atteoTalking: false, now: at(3.6)), .quiet)
    }

    func testANoisyRoomKeepsTheOldBar() {
        var t = TalkTurns(pause: 1.5)
        for i in 0..<100 { _ = t.feed(0.38, atteoTalking: false, now: at(Double(i) * 0.1)) }
        XCTAssertEqual(t.startAbove, TalkTurns.loudAbove, "a hum at 0.38 doesn't lower it, nor raise it past 0.45")
        XCTAssertFalse(t.heard, "the room's hum isn't you")
        _ = t.feed(0.6, atteoTalking: false, now: at(10.1))
        XCTAssertEqual(t.feed(0.6, atteoTalking: false, now: at(10.2)), .started)
    }

    func testAtteosVoiceDoesNotMoveTheRoomLevel() {
        var t = TalkTurns(pause: 1.5)
        let before = t.floor
        for i in 0..<50 { _ = t.feed(0.2, atteoTalking: true, now: at(Double(i) * 0.1)) }
        XCTAssertEqual(t.floor, before)
    }
}
