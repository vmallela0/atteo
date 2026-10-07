// A new message must not change a live call's shared audio session to playback (vedu #5607).

import Foundation
import XCTest
@testable import Atteo

final class ReadAloudGateTests: XCTestCase {
    func testMessagesStaySilentThroughTalkStandbyAndResume() {
        var gate = ReadAloudGate()
        let talk = UUID()
        var read: [String] = []
        func arrived(_ text: String) { if gate.allowed { read.append(text) } }

        arrived("Before the call")
        gate.suspend(talk)
        arrived("While connecting")
        arrived("While Atteo answers")
        arrived("While standing by") // Talk has its own reader; the chat must not duplicate it
        arrived("After Resume")
        gate.resume(talk)
        arrived("After End")

        XCTAssertEqual(read, ["Before the call", "After End"], "hushing only at the start lets later messages steal the session")
    }

    func testAnOlderCallEndingCannotUnpauseANewerCall() {
        var gate = ReadAloudGate()
        let talk = UUID(), conference = UUID()
        gate.suspend(talk)
        gate.suspend(conference)
        gate.resume(talk)
        XCTAssertFalse(gate.allowed, "the board call still owns the audio")
        gate.resume(talk) // a late or repeated dismissal of the old sheet
        XCTAssertFalse(gate.allowed)
        gate.resume(conference)
        XCTAssertTrue(gate.allowed, "ordinary read-aloud works again after the last call")
    }

    func testRepeatedAppearanceDoesNotLeaveReadingPermanentlyPaused() {
        var gate = ReadAloudGate()
        let call = UUID()
        gate.suspend(call)
        gate.suspend(call)
        gate.resume(call)
        XCTAssertTrue(gate.allowed)
        gate.suspend(call)
        XCTAssertFalse(gate.allowed, "reopening the sheet pauses reading again")
        gate.resume(call)
        XCTAssertTrue(gate.allowed)
    }
}
