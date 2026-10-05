// Long voice calls stand by (jxn #2071; the final shape #2078/#2079: no wake word). xAI bills every minute its realtime
// socket is open, so a hands-free call that goes quiet for about 5 seconds (nobody talking, Atteo not speaking or
// thinking, no tool running, no Yes/No card waiting) closes the socket and settles the session with the seconds it
// used. The sheet stays open, "Standing by". A tap, or play on AirPods / headphones / Control Center, starts a fresh
// session that's told what was said a moment ago; pause on AirPods while live stands by at once. While standing by,
// new messages on the call's board (or, for Ask, for you) are read aloud with the server's voice: "<author>: <text>".
// This file is the pure part (the timer, the commands, the recap, which messages) and the now-playing glue; the
// session is Talk.swift, the screen TalkView.swift. Hold to talk never stands by: nothing is listening between presses.

import AVFoundation
import MediaPlayer

enum TalkStandby {
    static let defaultIdle: TimeInterval = 5

    /// How long a quiet hands-free call stays live. DEBUG runs can set ATTEO_TALK_STANDBY_SECONDS (the UI tests that
    /// aren't about standby set it high, so the fake's idle moments don't stand it by).
    static var idle: TimeInterval {
        #if DEBUG
        if let s = API.environment("TALK_STANDBY_SECONDS"), let v = Double(s), v > 0 { return v }
        #endif
        return defaultIdle
    }

    /// What's going on in a live call right now.
    struct Activity: Equatable {
        var handsFree = true
        var hearing = false // the server's VAD hears the person
        var speaking = false // Atteo's voice is playing
        var thinking = false // an answer is under way
        var toolsRunning = 0 // tools (and a tapped Yes) still working
        var confirmWaiting = false // a Yes/No card is up

        /// Something is addressed to Atteo, or Atteo to the person: the quiet clock starts over.
        var busy: Bool { hearing || speaking || thinking || toolsRunning > 0 || confirmWaiting }
    }

    /// Whether a live call should stand by now: hands-free, nothing going on, and quiet for `idle` seconds since
    /// `lastActive` (the last moment anything was going on, or the session opening).
    static func shouldStandBy(now: Date, lastActive: Date, _ a: Activity, idle: TimeInterval = idle) -> Bool {
        guard a.handsFree, !a.busy else { return false }
        return now.timeIntervalSince(lastActive) >= idle
    }

    // MARK: Play / pause

    enum Command: Equatable { case play, pause, toggle }
    enum Action: Equatable { case standBy, resume, endTurn, none }
    enum State: Equatable { case connecting, live, standby, ended }

    /// AirPods, headphones, the lock screen or Control Center: play resumes, pause stands by, the toggle does whichever
    /// fits. Hold to talk has no standby (a pause there does nothing); while connecting nothing changes. In "tap"
    /// (VoiceTurns.swift) with something said, the press is Done instead: it ends your turn (`endsTurn`).
    static func action(_ c: Command, _ s: State, handsFree: Bool, endsTurn: Bool = false) -> Action {
        if endsTurn, s == .live { return .endTurn } // any of play, pause or the toggle: one press, "I'm done"
        switch (c, s) {
        case (.play, .standby), (.toggle, .standby): return .resume
        case (.pause, .live), (.toggle, .live): return handsFree ? .standBy : .none
        default: return .none
        }
    }

    // MARK: What the next session is told

    /// The last few turns, short, for the next session's instructions (tokens cost): who said what, a line each.
    /// Your words, Atteo's, and messages read while standing by; not tool notes. Empty: nothing to remember.
    static func recap(_ turns: [(who: String, text: String)], last n: Int = 6, perTurn: Int = 160, total: Int = 700) -> String {
        var lines: [String] = []
        var size = 0
        for t in turns.reversed() {
            let one = t.text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
            guard !one.isEmpty, one != "…" else { continue }
            let cut = one.count > perTurn ? String(one.prefix(perTurn - 1)) + "…" : one
            let line = "\(t.who): \(cut)"
            if size + line.count > total || lines.count == n { break }
            lines.insert(line, at: 0)
            size += line.count + 1
        }
        guard !lines.isEmpty else { return "" }
        return " This voice call paused and is picking up again. Earlier in this call (for context; don't repeat it or say you're resuming):\n" + lines.joined(separator: "\n")
    }

    // MARK: Which new messages to read

    /// A new message on the call's board, worth reading aloud while standing by. Never your own, one still sending, an
    /// unsend, or one with nothing to say. People's messages always; an agent's only in your agent's chat, when it names
    /// you, or when it answers something you wrote (the rest is agents' chatter).
    static func worthReading(_ e: Entry, me: String, agentChat: Bool, parentIsMine: (Int) -> Bool) -> Bool {
        let me = me.lowercased()
        guard e.seq > 0, e.pending != true, e.retracts == nil, !e.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if e.author.lowercased() == me && e.via != "agent" { return false }
        if agentChat { return e.byAgent }
        if !e.byAgent { return true }
        if (e.mentions ?? []).contains(where: { $0.user.lowercased() == me && !$0.agent }) { return true }
        if let p = e.replyTo { return parentIsMine(p) }
        return false
    }
}

/// Play / pause from AirPods, headphones, the lock screen and Control Center, and the call as the phone's now playing
/// ("Atteo"), while the call sheet is open.
@MainActor
final class TalkRemote {
    private var targets: [(MPRemoteCommand, Any)] = []
    private var muteObserver: NSObjectProtocol?

    /// Starts taking the commands. During a live call AirPods are a headset (HFP): their press comes as iOS's input
    /// mute gesture (AVAudioApplication), which here means pause; standing by they're headphones and send play.
    func on(_ handle: @escaping @MainActor (TalkStandby.Command) -> Void) {
        off()
        let c = MPRemoteCommandCenter.shared()
        for (cmd, kind) in [(c.togglePlayPauseCommand, TalkStandby.Command.toggle), (c.playCommand, .play), (c.pauseCommand, .pause)] {
            cmd.isEnabled = true
            let t = cmd.addTarget { _ in
                Task { @MainActor in handle(kind) }
                return .success
            }
            targets.append((cmd, t))
        }
        muteObserver = NotificationCenter.default.addObserver(forName: AVAudioApplication.inputMuteStateChangeNotification, object: nil, queue: .main) { n in
            let muted = (n.userInfo?[AVAudioApplication.muteStateKey] as? NSNumber)?.boolValue ?? false
            guard muted else { return }
            MainActor.assumeIsolated {
                handle(.pause)
                try? AVAudioApplication.shared.setInputMuted(false) // the next session starts unmuted
            }
        }
    }

    /// What the lock screen and Control Center show: Atteo, live or standing by.
    func nowPlaying(live: Bool, subtitle: String) {
        let info = MPNowPlayingInfoCenter.default()
        info.nowPlayingInfo = [
            MPMediaItemPropertyTitle: "Atteo",
            MPMediaItemPropertyArtist: subtitle,
            MPNowPlayingInfoPropertyIsLiveStream: true,
            MPNowPlayingInfoPropertyPlaybackRate: live ? 1.0 : 0.0,
        ]
        info.playbackState = live ? .playing : .paused
    }

    func off() {
        for (cmd, t) in targets { cmd.removeTarget(t) }
        targets = []
        if let muteObserver { NotificationCenter.default.removeObserver(muteObserver) }
        muteObserver = nil
        let info = MPNowPlayingInfoCenter.default()
        info.nowPlayingInfo = nil
        info.playbackState = .stopped
    }
}
