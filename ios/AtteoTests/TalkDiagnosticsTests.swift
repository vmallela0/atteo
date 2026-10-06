// A voice call never stands by without saying why, and its diagnostics line says what the mic did (vedu #5329).

import XCTest
@testable import Atteo

final class TalkDiagnosticsTests: XCTestCase {
    func testNoSoundFromTheMic() {
        let d = TalkDiagnostics()
        XCTAssertTrue(d.quietNote(mic: true).hasPrefix("Didn't hear anything"), d.quietNote(mic: true))
        var silent = TalkDiagnostics()
        for _ in 0..<50 { silent.level(0) }
        XCTAssertEqual(silent.quietNote(mic: true), d.quietNote(mic: true), "readings, but all silence")
    }

    func testOnlyQuietSound() {
        var d = TalkDiagnostics()
        for l: Float in [0.05, 0.12, 0.2, 0.1] { d.level(l) }
        XCTAssertTrue(d.quietNote(mic: true).hasPrefix("Didn't hear you"), d.quietNote(mic: true))
        XCTAssertEqual(d.micPeak, 0.2)
        XCTAssertEqual(d.micReadings, 4)
    }

    func testAfterTalkingItIsJustAQuietMoment() {
        var d = TalkDiagnostics()
        d.level(0.7)
        d.heardSpeech = true
        XCTAssertTrue(d.quietNote(mic: true).hasPrefix("Stood by after a quiet moment"))
        XCTAssertTrue(TalkDiagnostics().quietNote(mic: false).hasPrefix("Stood by"), "the tests' fake has no mic to blame")
    }

    func testANewSessionCountsAfresh() {
        var d = TalkDiagnostics()
        d.level(0.5); d.heardSpeech = true; d.lastStop = "quiet 5 s"
        d.newSession()
        XCTAssertEqual(d.micReadings, 0)
        XCTAssertEqual(d.micPeak, 0)
        XCTAssertFalse(d.heardSpeech)
        XCTAssertEqual(d.lastStop, "quiet 5 s", "why the last one stopped stays for the screenshot")
    }

    func testTheLineSaysWhatTheMicDid() {
        var d = TalkDiagnostics()
        d.level(0.31); d.level(0.04)
        d.startAbove = 0.25
        d.echoCancelling = true
        d.audio = "started on try 2 · MicrophoneBuiltIn,Speaker"
        d.lastStop = "socket closed 1006"
        d.lowPower = true
        XCTAssertEqual(d.text, """
        mic: 2 readings · loudest 31% · now 4% · talking above 25%
        echo cancelling on · heard you: no
        audio: started on try 2 · MicrophoneBuiltIn,Speaker
        last stop: socket closed 1006
        Low Power Mode on
        """)
    }

    func testAFreshSessionWaitsLongerForYourFirstWords() {
        XCTAssertGreaterThan(TalkStandby.firstWords, TalkStandby.idle)
        XCTAssertEqual(TalkStandby.firstWords, 10, accuracy: 0.001)
    }
}
