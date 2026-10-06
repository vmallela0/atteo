// Starting voice chat's audio (TalkAudio.swift, vedu #5249): CoreAudio's 'what' (2003329396) while the route settles is
// tried again, the last try without echo cancelling, and only then does the sheet say why, in words.

import AVFoundation
import XCTest
@testable import Atteo

@MainActor
final class TalkAudioStartTests: XCTestCase {
    private let what = NSError(domain: "com.apple.coreaudio.avfaudio", code: 2003329396)

    /// vedu #5338: a configuration change restarts the same engine; it never builds a new one (whose voice processing
    /// moves the route and changes the configuration again).
    func testAConfigurationChangeRestartsTheSameEngine() {
        XCTAssertEqual(TalkAudioStart.onConfigChange(running: false), .restart)
        XCTAssertEqual(TalkAudioStart.onConfigChange(running: true), .nothing)
    }

    func testThreeTriesWithAShortWaitBetween() {
        XCTAssertEqual(TalkAudioStart.delay(beforeAttempt: 0), 0)
        XCTAssertEqual(TalkAudioStart.delay(beforeAttempt: 1), 0.3)
        XCTAssertEqual(TalkAudioStart.delay(beforeAttempt: 2), 0.8)
        XCTAssertNil(TalkAudioStart.delay(beforeAttempt: 3))
    }

    func testTheLastTryGoesWithoutEchoCancelling() {
        XCTAssertEqual(TalkAudioStart.mic(attempt: 0), .echoCancelled)
        XCTAssertEqual(TalkAudioStart.mic(attempt: 1), .echoCancelled)
        XCTAssertEqual(TalkAudioStart.mic(attempt: 2), .plain)
    }

    func testAMicFormatNeedsARateAndAChannel() {
        XCTAssertTrue(TalkAudioStart.usable(sampleRate: 48_000, channels: 1))
        XCTAssertTrue(TalkAudioStart.usable(sampleRate: 24_000, channels: 2))
        XCTAssertFalse(TalkAudioStart.usable(sampleRate: 0, channels: 0), "no mic route yet")
        XCTAssertFalse(TalkAudioStart.usable(sampleRate: 48_000, channels: 0))
        XCTAssertFalse(TalkAudioStart.usable(sampleRate: 0, channels: 1))
    }

    func testFailsTwiceThenStarts() async {
        var tries: [Int] = [], waits: [TimeInterval] = []
        let error = await TalkAudioStart.run(attempt: { n in
            tries.append(n)
            if n < 2 { throw self.what }
        }, sleep: { d in waits.append(d); return true })
        XCTAssertNil(error)
        XCTAssertEqual(tries, [0, 1, 2])
        XCTAssertEqual(waits, [0.3, 0.8])
    }

    func testStartsFirstTimeWithoutWaiting() async {
        var waits: [TimeInterval] = []
        let error = await TalkAudioStart.run(attempt: { _ in }, sleep: { d in waits.append(d); return true })
        XCTAssertNil(error)
        XCTAssertEqual(waits, [])
    }

    func testGivesUpAfterThreeTriesWithTheLastError() async {
        var tries = 0
        let error = await TalkAudioStart.run(attempt: { n in
            tries += 1
            throw NSError(domain: "t", code: n)
        }, sleep: { _ in true })
        XCTAssertEqual(tries, 3)
        XCTAssertEqual((error as NSError?)?.code, 2)
    }

    func testStopsWhenTheCallEndsWhileWaiting() async {
        var tries = 0
        let error = await TalkAudioStart.run(attempt: { _ in
            tries += 1
            throw self.what
        }, sleep: { _ in false })
        XCTAssertNil(error, "ended: nothing to say")
        XCTAssertEqual(tries, 1)
    }

    func testReasonsAreWordsNotCoreAudioNumbers() {
        let generic = TalkAudioStart.reason(what)
        XCTAssertFalse(generic.contains("2003329396"))
        XCTAssertFalse(generic.contains("avfaudio"))
        XCTAssertTrue(generic.contains("Captions still show"))

        let busy = TalkAudioStart.reason(NSError(domain: NSOSStatusErrorDomain, code: AVAudioSession.ErrorCode.insufficientPriority.rawValue))
        XCTAssertTrue(busy.contains("Another app or a call"), busy)
        XCTAssertEqual(TalkAudioStart.reason(NSError(domain: NSOSStatusErrorDomain, code: AVAudioSession.ErrorCode.cannotStartRecording.rawValue)), busy)
        XCTAssertNotEqual(generic, busy)

        let noMic = TalkAudioStart.reason(TalkAudioStart.Failure.noMic("out 0 Hz × 0"))
        XCTAssertTrue(noMic.contains("No microphone"), noMic)
        XCTAssertFalse(noMic.contains("0 Hz"))
    }
}
