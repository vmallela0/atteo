// What a voice call saw (vedu #5329: calls went back to "Standing by" after ~6 s with nothing on screen to say why).
// Every standby now says why (quietNote, or the remote's pause), and "Diagnostics" in the sheet's ⋯ menu shows a line
// with what the mic delivered, how loud, the turn threshold, how the audio started, and why the last session stopped,
// so a screenshot tells us. The pure part (tested); Talk.swift feeds it, TalkView.swift shows it.

import Foundation

struct TalkDiagnostics: Equatable {
    var micReadings = 0 // mic levels this session (about ten a second while listening)
    var micPeak: Float = 0 // the loudest this session, 0…1 (-50…-10 dBFS)
    var micNow: Float = 0
    var heardSpeech = false // a turn started this session (the app's turns, or the server's VAD)
    var startAbove: Float = TalkTurns.loudAbove // what counts as talking right now
    var echoCancelling = false
    var audio = "" // how the audio last started (TalkAudio.status)
    var lastStop = "" // why the last session closed
    var lowPower = false

    /// A new session: what the mic does is counted afresh.
    mutating func newSession() { micReadings = 0; micPeak = 0; micNow = 0; heardSpeech = false }

    mutating func level(_ l: Float) {
        micReadings += 1
        micNow = l
        micPeak = max(micPeak, l)
    }

    /// Why a quiet hands-free call stood by, in words. `mic`: the call uses the phone's mic (not the tests' fake).
    func quietNote(mic: Bool) -> String {
        if heardSpeech || !mic {
            return String(localized: "Stood by after a quiet moment, so the call doesn't use minutes. Tap or press play to keep talking.", bundle: .l10n)
        }
        if micReadings == 0 || micPeak < 0.02 {
            return String(localized: "Didn't hear anything: no sound came from the microphone. Check that no other app or call is using it, then tap Resume.", bundle: .l10n)
        }
        return String(localized: "Didn't hear you: the microphone only picked up very quiet sound. Speak a little closer, then tap Resume.", bundle: .l10n)
    }

    /// The ⋯ menu's diagnostics, as one short block (English: it's for whoever reads the screenshot).
    var text: String {
        func pct(_ v: Float) -> String { "\(Int((v * 100).rounded()))%" }
        var lines = [
            "mic: \(micReadings) readings · loudest \(pct(micPeak)) · now \(pct(micNow)) · talking above \(pct(startAbove))",
            "echo cancelling \(echoCancelling ? "on" : "off") · heard you: \(heardSpeech ? "yes" : "no")",
        ]
        if !audio.isEmpty { lines.append("audio: \(audio)") }
        if !lastStop.isEmpty { lines.append("last stop: \(lastStop)") }
        if lowPower { lines.append("Low Power Mode on") }
        return lines.joined(separator: "\n")
    }
}
