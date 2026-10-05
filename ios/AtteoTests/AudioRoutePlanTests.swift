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

/// The output button's name and icon, Spotify-style (vedu #2464).
final class AudioOutputTests: XCTestCase {
    func testThePhoneShowsThePersonsChoiceWhateverTheRouteSays() {
        XCTAssertEqual(AudioOutput.describe([], loudspeaker: true).kind, .speaker, "no session yet: the default, the loudspeaker")
        XCTAssertEqual(AudioOutput.describe([(.builtInReceiver, "Receiver")], loudspeaker: true).kind, .speaker, "the override is about to move it")
        XCTAssertEqual(AudioOutput.describe([(.builtInSpeaker, "Speaker")], loudspeaker: false).kind, .earpiece)
        let speaker = AudioOutput.describe([(.builtInSpeaker, "Speaker")], loudspeaker: true)
        XCTAssertEqual(speaker.name, AudioOutput.speakerName)
        XCTAssertEqual(speaker.symbol, "speaker.wave.2.fill")
        XCTAssertEqual(AudioOutput.describe([], loudspeaker: false).symbol, "ear")
    }

    func testDevicesAreNamedAsIOSNamesThem() {
        let pods = AudioOutput.describe([(.bluetoothA2DP, "Vedu’s AirPods Pro")], loudspeaker: true)
        XCTAssertEqual(pods, AudioOutput(kind: .airpods, name: "Vedu’s AirPods Pro"))
        XCTAssertEqual(pods.symbol, "airpods")
        XCTAssertEqual(AudioOutput.describe([(.bluetoothHFP, "airpods max")], loudspeaker: false).kind, .airpods, "any case, in a call too")
        XCTAssertEqual(AudioOutput.describe([(.bluetoothA2DP, "JBL Flip 6")], loudspeaker: true), AudioOutput(kind: .bluetooth, name: "JBL Flip 6"))
        XCTAssertEqual(AudioOutput.describe([(.bluetoothLE, "  ")], loudspeaker: true), AudioOutput(kind: .bluetooth, name: "Bluetooth"))
        XCTAssertEqual(AudioOutput.describe([(.carAudio, "Tesla")], loudspeaker: true), AudioOutput(kind: .car, name: "Tesla"))
        XCTAssertEqual(AudioOutput.describe([(.airPlay, "Living Room")], loudspeaker: true), AudioOutput(kind: .airplay, name: "Living Room"))
        XCTAssertEqual(AudioOutput.describe([(.headphones, "Headphones")], loudspeaker: true).kind, .headphones)
        XCTAssertEqual(AudioOutput.describe([(.usbAudio, "USB-C Headset")], loudspeaker: true), AudioOutput(kind: .headphones, name: "USB-C Headset"))
    }

    func testAnOtherDeviceWinsOverThePhoneInAMixedRoute() {
        let o = AudioOutput.describe([(.builtInSpeaker, "Speaker"), (.airPlay, "Kitchen")], loudspeaker: true)
        XCTAssertEqual(o, AudioOutput(kind: .airplay, name: "Kitchen"), "AirPlay mirroring with the phone speaker: name the device")
    }
}
