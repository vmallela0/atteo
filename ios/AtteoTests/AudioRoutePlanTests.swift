// Where Atteo's voice plays (AudioRoute.swift, vedu #2384): the loudspeaker by default, louder than a phone call, the
// earpiece when picked; AirPods, headphones, cars and AirPlay keep the sound and hide the choice.

import AVFoundation
import XCTest
@testable import Atteo

final class AudioRoutePlanTests: XCTestCase {
    func testTalkOnTheLoudspeakerIsLouderThanACall() {
        let p = AudioRoutePlan.plan(.talk, loudspeaker: true)
        XCTAssertEqual(p.category, .playAndRecord)
        XCTAssertEqual(p.mode, .videoChat, "not .voiceChat, which plays at the quieter phone-call level")
        XCTAssertTrue(p.options.contains(.defaultToSpeaker))
        XCTAssertTrue(p.options.contains(.allowBluetoothHFP), "AirPods still work for the mic")
        XCTAssertTrue(p.options.contains(.allowBluetoothA2DP))
        XCTAssertEqual(p.override, .speaker)
        XCTAssertGreaterThan(p.gainDB, 0, "a little gain (a limiter follows it)")
    }

    func testTalkOnTheEarpiece() {
        let p = AudioRoutePlan.plan(.talk, loudspeaker: false)
        XCTAssertEqual(p.category, .playAndRecord)
        XCTAssertEqual(p.mode, .voiceChat)
        XCTAssertFalse(p.options.contains(.defaultToSpeaker))
        XCTAssertTrue(p.options.contains(.allowBluetoothHFP))
        XCTAssertEqual(p.override, .none)
        XCTAssertEqual(p.gainDB, 0)
    }

    func testReadAloudPlaysAsMediaOnTheLoudspeaker() {
        let p = AudioRoutePlan.plan(.readAloud, loudspeaker: true)
        XCTAssertEqual(p.category, .playback, "full media volume")
        XCTAssertEqual(p.mode, .spokenAudio)
        XCTAssertNotEqual(p.mode, .voiceChat)
        XCTAssertFalse(p.options.contains(.mixWithOthers))
    }

    func testReadAloudOnTheEarpieceNeedsPlayAndRecord() {
        let p = AudioRoutePlan.plan(.readAloud, loudspeaker: false)
        XCTAssertEqual(p.category, .playAndRecord, ".playback can't use the earpiece")
        XCTAssertFalse(p.options.contains(.defaultToSpeaker))
        XCTAssertTrue(p.options.contains(.allowBluetoothA2DP), "AirPods still get it")
        XCTAssertEqual(p.override, .none)
    }

    func testTheChoiceOnlyAppliesToThePhonesOwnSpeakers() {
        XCTAssertTrue(AudioRoutePlan.builtIn([.builtInSpeaker]))
        XCTAssertTrue(AudioRoutePlan.builtIn([.builtInReceiver]))
        XCTAssertFalse(AudioRoutePlan.builtIn([.bluetoothA2DP]), "AirPods")
        XCTAssertFalse(AudioRoutePlan.builtIn([.headphones]))
        XCTAssertFalse(AudioRoutePlan.builtIn([.bluetoothHFP]))
        XCTAssertFalse(AudioRoutePlan.builtIn([.carAudio]))
        XCTAssertFalse(AudioRoutePlan.builtIn([.airPlay]))
        XCTAssertFalse(AudioRoutePlan.builtIn([]), "no route yet: no choice")
    }

    func testOverrideOnlyMovesTheEarpieceToTheLoudspeakerWhenWanted() {
        XCTAssertTrue(AudioRoutePlan.shouldOverride(loudspeaker: true, outputs: [.builtInReceiver]))
        XCTAssertFalse(AudioRoutePlan.shouldOverride(loudspeaker: true, outputs: [.builtInSpeaker]), "already there (no loop)")
        XCTAssertFalse(AudioRoutePlan.shouldOverride(loudspeaker: true, outputs: [.bluetoothHFP]), "AirPods keep it")
        XCTAssertFalse(AudioRoutePlan.shouldOverride(loudspeaker: false, outputs: [.builtInReceiver]), "the earpiece was picked")
    }
}
