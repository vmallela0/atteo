// Voice chat's screens (Talk.swift has the conversation). On screen it's always "Atteo", never the provider (vedu
// #1599). One way in per screen (#1602): the waveform by the message box's mic, and Everyday's Ask screen
// (EverydayHooks.talk). The full-screen sheet is hands-free (#1598): it listens, waits for you to pause, answers, and
// stops the moment you talk over it. A big orb shows what's happening (your voice's level while listening, thinking,
// Atteo speaking); the mic can be turned off (Atteo can still talk), Atteo's voice muted (captions stay), and "Hold to
// talk" in the menu brings back the push-to-talk button for noisy places. Live captions of both sides, the session's
// time and the month's minutes, and a Yes/No card before any approval. Settings → Voice chat. Nothing shows when the
// server has no voice set up (GET /api/app/voice/status says disabled).

import SwiftUI

/// The waveform: opens the voice chat sheet. Hidden while voice isn't set up on the server.
struct TalkButton: View {
    enum Style { case composer, ask }
    let board: Board?
    var style: Style = .composer
    @ObservedObject private var status = TalkStatus.shared
    @State private var open = false

    /// Everyday's Ask screen gets the same sheet (no board: it's about you, and can message your assistant).
    static func plugIn() {
        EverydayHooks.talk = { MainActor.assumeIsolated { AnyView(TalkButton(board: nil, style: .ask)) } }
    }

    var body: some View {
        ZStack {
            if status.enabled == true {
                Button { Haptics.play(.touch); open = true } label: {
                    switch style {
                    case .composer:
                        Image(systemName: "waveform").font(.system(size: 14, weight: .bold))
                            .composerCircle(fill: Theme.raised).foregroundStyle(Theme.muted)
                    case .ask:
                        Label("Voice chat", systemImage: "waveform")
                            .font(Typo.body.weight(.medium)).foregroundStyle(Theme.text)
                            .padding(.horizontal, Space.l).frame(height: 44)
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.line))
                    }
                }
                .buttonStyle(PressStyle())
                .accessibilityIdentifier(style == .composer ? "talk" : "ask-talk")
                .accessibilityLabel("Talk to Atteo")
                .accessibilityHint("Opens a live, hands-free voice chat.")
                .padding(.trailing, style == .composer ? -Composer.inset : 0) // snug against the mic, like the mic to send
            }
        }
        .task { await status.load() }
        .fullScreenCover(isPresented: $open) { TalkSheet(board: board) }
    }
}

struct TalkSheet: View {
    @StateObject private var talk: TalkSession
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var pressing = false

    init(board: Board?) { _talk = StateObject(wrappedValue: TalkSession(board: board)) }

    var body: some View {
        VStack(spacing: 0) {
            header
            captions
            if let c = talk.confirm { confirmCard(c).transition(.move(edge: .bottom).combined(with: .opacity)) }
            if let p = talk.problem {
                Text(p).font(Typo.meta).foregroundStyle(Theme.warn).multilineTextAlignment(.center)
                    .padding(.horizontal, Space.l).padding(.top, Space.s)
                    .accessibilityIdentifier("talk-problem")
            }
            controls
        }
        .background(Theme.bg.ignoresSafeArea())
        .animation(.snappy, value: talk.confirm)
        .animation(.snappy, value: talk.problem)
        .task { await talk.start() }
        .onDisappear { talk.end() }
        .onChange(of: scenePhase) { _, p in if p == .background { talk.end() } } // the mic doesn't follow you out of the app
    }

    private var header: some View {
        HStack(alignment: .center) {
            Button(talk.phase == .ended ? "Close" : "End") { talk.end(); dismiss() }
                .font(.body.weight(.semibold)).foregroundStyle(talk.phase == .ended ? Theme.text : Theme.danger)
                .frame(minWidth: 44, alignment: .leading)
                .accessibilityIdentifier("talk-end")
            Spacer()
            VStack(spacing: 2) {
                Text("Atteo").font(.headline).foregroundStyle(Theme.text)
                Text(timeLine).font(Typo.micro.monospacedDigit()).foregroundStyle(Theme.muted)
                    .accessibilityIdentifier("talk-timer")
            }
            Spacer()
            // Its own Equatable view: the sheet redraws a few times a second (the clock), and an open menu redrawn with it
            // never settles.
            TalkMenu(handsFree: talk.handsFree) { [talk] in talk.setHandsFree(!talk.handsFree) }.equatable()
        }
        .padding(.horizontal, Space.l).padding(.top, Space.s)
    }

    private var timeLine: String {
        if talk.phase == .connecting { return String(localized: "Connecting…", bundle: .l10n) }
        if talk.phase == .ended { return talk.endNote ?? String(localized: "Ended", bundle: .l10n) }
        let clock = TalkSession.clock(talk.secondsLeft)
        if let m = talk.monthMinutesLeft { return String(localized: "\(clock) left · \(m) min this month", bundle: .l10n) }
        return String(localized: "\(clock) left", bundle: .l10n)
    }

    private var captions: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Space.m) {
                    if talk.captions.isEmpty && talk.phase != .ended {
                        (talk.board.map { Text("Just talk. Ask about \($0.displayName(me: AppState.shared.me?.owner)), what's waiting for you, or tell your agent something.") } ?? Text("Just talk. Ask what's waiting for you, catch up on a board, or tell your agent something."))
                            .font(Typo.secondary).foregroundStyle(Theme.faint)
                            .frame(maxWidth: .infinity, alignment: .center).multilineTextAlignment(.center)
                            .padding(.top, Space.xl)
                    }
                    ForEach(talk.captions) { c in caption(c).id(c.id) }
                }
                .padding(.horizontal, Space.l).padding(.vertical, Space.m)
            }
            .onChange(of: talk.captions.last.map { "\($0.id)\($0.text.count)" }) { _, _ in
                if let last = talk.captions.last { withAnimation(.smooth(duration: 0.2)) { proxy.scrollTo(last.id, anchor: .bottom) } }
            }
        }
        .accessibilityIdentifier("talk-captions")
    }

    @ViewBuilder private func caption(_ c: TalkSession.Caption) -> some View {
        switch c.who {
        case .note:
            Label(c.text, systemImage: c.done ? "checkmark.circle" : "ellipsis.circle")
                .font(Typo.meta).foregroundStyle(Theme.faint)
                .accessibilityIdentifier("talk-note")
        case .you, .grok:
            VStack(alignment: .leading, spacing: 2) {
                Text(c.who == .you ? "You" : "Atteo").font(Typo.micro.weight(.semibold)).foregroundStyle(c.who == .you ? Theme.muted : Theme.accent)
                    .accessibilityHidden(true)
                Text(c.text).font(c.who == .grok ? .title3 : .body).foregroundStyle(c.who == .grok ? Theme.text : Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel(c.who == .you ? Text("You: \(c.text)") : Text("Atteo: \(c.text)"))
                    .accessibilityIdentifier(c.who == .you ? "talk-you" : "talk-atteo")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func confirmCard(_ c: TalkSession.Confirm) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Label(c.decision == "deny" ? "Deny \(c.approval)?" : "Approve \(c.approval)?", systemImage: "checkmark.shield").font(.headline).foregroundStyle(Theme.text)
            Text(c.confirmed ? "Heard yes. Atteo will do it now." : "Nothing happens until you say “yes” or tap Yes.")
                .font(Typo.meta).foregroundStyle(Theme.muted)
            HStack(spacing: Space.s) {
                Button { talk.answerConfirm(false) } label: { Text("No").frame(maxWidth: .infinity).padding(.vertical, 10).background(Theme.raised, in: Capsule()) }
                    .accessibilityIdentifier("talk-confirm-no")
                Button { talk.answerConfirm(true) } label: { Text(c.decision == "deny" ? "Yes, deny" : "Yes, approve").frame(maxWidth: .infinity).padding(.vertical, 10).background(Theme.accent, in: Capsule()).foregroundStyle(Theme.onAccent) }
                    .accessibilityIdentifier("talk-confirm-yes")
            }
            .buttonStyle(PressStyle()).font(.body.weight(.semibold)).foregroundStyle(Theme.text)
        }
        .padding(Space.m)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .padding(.horizontal, Space.l).padding(.top, Space.s)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("talk-confirm")
    }

    private var stateLine: String {
        switch talk.phase {
        case .connecting: return String(localized: "Connecting…", bundle: .l10n)
        case .ended: return String(localized: "Ended", bundle: .l10n)
        case .ready where talk.handsFree:
            if talk.speaking { return String(localized: "Atteo is speaking", bundle: .l10n) }
            if talk.hearing { return String(localized: "Listening…", bundle: .l10n) }
            if talk.thinking { return String(localized: "Thinking…", bundle: .l10n) }
            if talk.micMuted { return String(localized: "Mic off", bundle: .l10n) }
            return String(localized: "Listening…", bundle: .l10n)
        case .ready:
            if talk.holding { return String(localized: "Listening… let go to send", bundle: .l10n) }
            if talk.speaking { return String(localized: "Atteo is speaking · tap to interrupt", bundle: .l10n) }
            if talk.thinking { return String(localized: "Thinking…", bundle: .l10n) }
            return String(localized: "Hold to talk", bundle: .l10n)
        }
    }

    private var mood: TalkOrb.Mood {
        guard talk.phase == .ready else { return .idle }
        if talk.holding { return .holding }
        if talk.speaking { return .speaking }
        if talk.handsFree && talk.hearing { return .hearing }
        if talk.thinking { return .thinking }
        if talk.handsFree { return talk.micMuted ? .off : .listening }
        return .idle
    }

    private var controls: some View {
        let live = talk.phase == .ready
        return VStack(spacing: Space.m) {
            Text(stateLine).font(Typo.secondary.weight(.medium)).foregroundStyle(talk.speaking ? Theme.accent : Theme.muted)
                .accessibilityIdentifier("talk-state")
            if talk.phase == .ended {
                Button { dismiss() } label: {
                    Text("Done").font(.headline).frame(width: 200, height: 52).background(Theme.raised, in: Capsule()).foregroundStyle(Theme.text)
                }
                .buttonStyle(PressStyle())
                .accessibilityIdentifier("talk-done")
                .frame(height: 160)
            } else {
                HStack(spacing: Space.xl) {
                    micButton.opacity(talk.handsFree ? 1 : 0).disabled(!talk.handsFree || !live)
                        .accessibilityHidden(!talk.handsFree)
                    orb(live)
                    speakerButton.disabled(!live)
                }
                .frame(height: 160)
            }
            Text("Atteo can read your boards, check what's waiting and message your agent. It asks before approving anything.")
                .font(Typo.micro).foregroundStyle(Theme.faint).multilineTextAlignment(.center)
                .padding(.horizontal, Space.xl)
        }
        .padding(.top, Space.m).padding(.bottom, Space.l)
    }

    @ViewBuilder private func orb(_ live: Bool) -> some View {
        let o = TalkOrb(mood: mood, level: talk.level, live: live)
        if talk.handsFree {
            o.contentShape(Circle())
                .onTapGesture { talk.orbTapped() }
                .allowsHitTesting(live)
                .accessibilityElement()
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel(talk.speaking ? "Stop Atteo" : "Voice chat")
                .accessibilityValue(stateLine)
                .accessibilityHint("Just talk: Atteo answers when you pause. Talk over it, or tap here, to stop it.")
                .accessibilityAction { talk.orbTapped() }
                .accessibilityIdentifier("talk-orb")
        } else {
            o.contentShape(Circle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { _ in if !pressing { pressing = true; talk.holdBegan() } }
                        .onEnded { _ in pressing = false; talk.holdEnded() }
                )
                .allowsHitTesting(live)
                .accessibilityElement()
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel(talk.holding ? "Send" : talk.speaking ? "Stop Atteo" : "Talk")
                .accessibilityHint("Hold and talk, then let go. While Atteo speaks, tap to stop it.")
                .accessibilityAction {
                    if talk.holding { talk.holdEnded() } else if talk.speaking { talk.interrupt() } else { talk.holdBegan() }
                }
                .accessibilityIdentifier("talk-button")
        }
    }

    private var micButton: some View {
        Button { talk.toggleMic() } label: {
            Image(systemName: talk.micMuted ? "mic.slash.fill" : "mic.fill")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(talk.micMuted ? Theme.onAccent : Theme.text)
                .frame(width: 56, height: 56)
                .background(talk.micMuted ? Theme.danger : Theme.raised, in: Circle())
        }
        .buttonStyle(PressStyle())
        .accessibilityIdentifier("talk-mic")
        .accessibilityLabel(talk.micMuted ? "Unmute mic" : "Mute mic")
        .accessibilityHint("While it's off nothing you say is sent. Atteo can still finish talking.")
    }

    private var speakerButton: some View {
        Button { talk.muted.toggle(); Haptics.play(.touch) } label: {
            Image(systemName: talk.muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(talk.muted ? Theme.accent : Theme.text)
                .frame(width: 56, height: 56)
                .background(Theme.raised, in: Circle())
        }
        .buttonStyle(PressStyle())
        .accessibilityIdentifier("talk-mute")
        .accessibilityLabel(talk.muted ? "Unmute Atteo" : "Mute Atteo")
        .accessibilityHint("What Atteo says still shows as captions.")
    }
}

/// The sheet's menu: "Hold to talk" for noisy places (remembered on this device).
struct TalkMenu: View, Equatable {
    let handsFree: Bool
    let toggle: () -> Void

    static func == (a: TalkMenu, b: TalkMenu) -> Bool { a.handsFree == b.handsFree }

    var body: some View {
        Menu {
            Section("For noisy places") {
                Button(action: toggle) {
                    Label("Hold to talk", systemImage: handsFree ? "hand.tap" : "checkmark")
                }
                .accessibilityIdentifier("talk-hold-mode")
            }
        } label: {
            Image(systemName: "ellipsis.circle").font(.system(size: 19, weight: .semibold)).foregroundStyle(Theme.muted)
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .accessibilityIdentifier("talk-menu")
        .accessibilityLabel("Voice chat options")
    }
}

/// The big orb: grows with your voice while listening, a turning arc while thinking, rings while Atteo speaks. Only
/// animates when motion effects are on (and never under UI tests, which need the app to go idle).
struct TalkOrb: View {
    enum Mood: Equatable { case idle, listening, hearing, thinking, speaking, off, holding }
    let mood: Mood
    let level: Float
    let live: Bool
    private let size: CGFloat = 132

    var body: some View {
        let moving = Effects.enabled && (mood == .thinking || mood == .speaking)
        TimelineView(.animation(minimumInterval: nil, paused: !moving)) { ctx in
            let t = moving ? ctx.date.timeIntervalSinceReferenceDate : 0
            let l = CGFloat(level)
            ZStack {
                // Your voice: a soft halo that follows the level.
                Circle().fill(Theme.accent.opacity(mood == .hearing || mood == .listening || mood == .holding ? 0.10 + 0.25 * l : 0))
                    .scaleEffect(1 + 0.45 * l)
                // Atteo speaking: rings going out.
                if mood == .speaking {
                    ForEach(0..<3) { i in
                        let p = (t * 0.6 + Double(i) / 3).truncatingRemainder(dividingBy: 1)
                        Circle().stroke(Theme.accent.opacity(Effects.enabled ? 0.5 * (1 - p) : 0.35), lineWidth: 2)
                            .scaleEffect(Effects.enabled ? 1 + 0.5 * p : 1.12)
                    }
                }
                // Thinking: an arc going round.
                if mood == .thinking {
                    Circle().trim(from: 0, to: 0.28)
                        .stroke(Theme.accent, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .rotationEffect(.radians(t * 4))
                        .scaleEffect(1.1)
                }
                Circle().fill(fill)
                    .overlay(Circle().stroke(Theme.accent.opacity(mood == .listening ? 0.35 : 0), lineWidth: 2))
                    .scaleEffect(mood == .speaking ? 1 + 0.03 * sin(t * 7) : 1 + 0.12 * l)
                Image(systemName: symbol)
                    .font(.system(size: 40, weight: .semibold))
                    .foregroundStyle(onFill)
            }
            .frame(width: size, height: size)
        }
        .animation(.easeOut(duration: 0.12), value: level)
        .animation(.spring(duration: 0.3, bounce: 0.25), value: mood)
    }

    private var fill: Color {
        switch mood {
        case .speaking, .hearing, .holding: return Theme.accent
        default: return Theme.raised
        }
    }

    private var onFill: Color {
        switch mood {
        case .speaking, .hearing, .holding: return Theme.onAccent
        case .off, .idle: return live ? Theme.muted : Theme.faint
        default: return Theme.text
        }
    }

    private var symbol: String {
        switch mood {
        case .off: return "mic.slash.fill"
        case .holding: return "mic.fill"
        case .thinking: return "ellipsis"
        default: return "waveform"
        }
    }
}

/// Settings → Voice chat: this month's minutes, or that it isn't set up.
struct TalkSection: View {
    @ObservedObject private var status = TalkStatus.shared

    var body: some View {
        Section {
            HStack {
                Label("Voice chat", systemImage: "waveform")
                Spacer()
                Text(status.enabled == true ? "\(Self.minutes(status.minutesUsed)) of \(status.minutesBudget) min" : status.enabled == false ? "Not set up" : "…")
                    .foregroundStyle(Theme.muted).monospacedDigit()
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("talk-settings")
        } footer: {
            Text(status.enabled == false
                 ? "Voice isn't set up yet. Typing, the mic in the message box and reading replies aloud still work."
                 : "Talk with Atteo, live and hands-free. It can read your boards, check what's waiting and message your agent, and asks before approving anything. Minutes reset on the 1st.")
        }
        .listRowBackground(Theme.card)
        .task { await status.load(force: true) }
    }

    static func minutes(_ m: Double) -> String { m == m.rounded() ? String(Int(m)) : String(format: "%.1f", m) }
}
