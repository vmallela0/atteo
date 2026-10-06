// When Atteo answers in a voice chat (vedu #2460): display.voice_turns, saved per person, so the web follows it too.
//   quick: the server's VAD finds the turns (turn_detection server_vad), as before: it answers at the first short pause.
//   pause: the default. The app ends the turn itself, after `pause` seconds of quiet once it heard you speak.
//   tap:   the app ends the turn when you tap Done, or press play/pause on AirPods. No wake word (jxn #2462).
// xAI documents no silence length for its VAD (only turn_detection.type and idle_timeout_ms), so for pause and tap the
// session has turn_detection null and the app sends input_audio_buffer.commit + response.create (Talk.swift endTurn),
// the same as hold to talk. TalkTurns hears where you start and stop from the mic level TalkAudio already measures.

import SwiftUI

enum VoiceTurns: String, CaseIterable, Identifiable {
    case quick, pause, tap
    var id: String { rawValue }

    var title: LocalizedStringKey {
        switch self {
        case .quick: return "Right away"
        case .pause: return "After a pause"
        case .tap: return "When I tap Done"
        }
    }

    /// What the server's session says (an older server sends none: it runs its VAD, which is quick).
    init(server: Any?) { self = (server as? String).flatMap(VoiceTurns.init(rawValue:)) ?? .quick }

    /// The person's choice (Settings, or the call's chip). DEBUG: ATTEO_VOICE_TURNS picks one, and the fake voice
    /// provider without it keeps quick, so the older Talk UI tests run as they were written.
    @MainActor static var chosen: VoiceTurns {
        #if DEBUG
        if let v = API.environment("VOICE_TURNS").flatMap(VoiceTurns.init(rawValue:)) { return v }
        if TalkAPI.fake { return .quick }
        #endif
        return VoiceTurns(rawValue: AppState.shared.display.voiceTurns) ?? .pause
    }
}

/// Where a turn starts and ends, from the mic level (0…1, TalkAudio: -50…-10 dBFS, a value every ~100 ms).
/// Speech: two loud values in a row (louder while Atteo talks, so what's left of its voice after echo cancelling isn't
/// you). Quiet: below `quietUnder`, with a gap between the two so a word's tail doesn't flicker.
/// "Loud" follows the room (vedu #5329: a phone on the loudspeaker at arm's length never reached a fixed 0.45, about
/// -32 dBFS, so nothing was ever heard and the call stood by): a little above the room's own quiet level (`floor`,
/// followed while nobody talks), never below `minLoud` (-40 dBFS) nor above the old `loudAbove`. The floor follows the
/// quietest moments: down at once, up slowly (speech has gaps between syllables, a hum doesn't), and the bar only drops
/// below `loudAbove` after a second of listening, so a steady hum is learnt before it could count as you.
struct TalkTurns: Equatable {
    var pause: TimeInterval = 1.5
    static let loudAbove: Float = 0.45
    static let minLoud: Float = 0.25
    static let loudOverAtteo: Float = 0.6
    static let quietBelow: Float = 0.3

    private(set) var heard = false // something was said since the last turn ended
    private(set) var hearing = false // and it's being said now
    private(set) var quietSince: Date?
    private var loud = 0
    /// The room's quiet level (0…1): down at once to a quieter value, up 0.02 a value (never on Atteo's voice).
    private(set) var floor: Float = 0.1
    private var readings = 0

    /// The level that counts as you talking, and the one under which you've stopped.
    var startAbove: Float { readings < 10 ? Self.loudAbove : min(Self.loudAbove, max(Self.minLoud, floor + 0.15)) }
    var quietUnder: Float { min(Self.quietBelow, max(0.12, floor + 0.08)) }

    enum Event: Equatable { case none, started, quiet, again }

    /// One level value. `.started`: the turn's first speech (barge in if Atteo talks); `.again`: talking again after a
    /// quiet moment (the pause starts over); `.quiet`: it just went quiet.
    mutating func feed(_ level: Float, atteoTalking: Bool, now: Date = Date()) -> Event {
        if readings < 10 { readings += 1 }
        if level < floor { floor = level } else if !atteoTalking { floor += min(level - floor, 0.02) }
        if level > (atteoTalking ? Self.loudOverAtteo : startAbove) {
            loud += 1
            guard loud >= 2 else { return .none }
            quietSince = nil
            let was = (heard, hearing)
            heard = true
            hearing = true
            return !was.0 ? .started : !was.1 ? .again : .none
        }
        if level < quietUnder { loud = 0 }
        guard heard, hearing, level < quietUnder else { return .none }
        hearing = false
        quietSince = now
        return .quiet
    }

    /// pause: how full the wait is (0…1), while you're quiet after speaking; nil otherwise.
    func progress(now: Date = Date()) -> Double? {
        guard heard, !hearing, let q = quietSince else { return nil }
        return min(1, now.timeIntervalSince(q) / pause)
    }

    /// pause: the wait is over, the turn ends.
    func due(now: Date = Date()) -> Bool { (progress(now: now) ?? 0) >= 1 }

    /// The turn ended (or was dropped): listen for the next one.
    mutating func reset() { heard = false; hearing = false; quietSince = nil; loud = 0 }

    /// DEBUG's fake voice, which has no microphone: the person said something and stopped, just now.
    mutating func spoke(now: Date = Date()) { heard = true; hearing = false; quietSince = now; loud = 0 }
}
