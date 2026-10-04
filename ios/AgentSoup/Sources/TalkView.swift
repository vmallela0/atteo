// Talk to Grok's screens (Talk.swift has the conversation): the waveform button by the message box's mic and in a
// chat's top bar, the full-screen talk sheet (hold the big button to talk, live captions of both sides, tap to stop
// Grok mid-sentence, the session's time and the month's minutes, mute, end), and Settings → Talk to Grok. Nothing
// shows when the server has no voice set up (GET /api/app/voice/status says disabled).

import SwiftUI

/// The waveform: opens the talk sheet. Hidden while voice isn't set up on the server.
struct TalkButton: View {
    enum Style { case composer, toolbar }
    let board: Board?
    var style: Style = .composer
    @ObservedObject private var status = TalkStatus.shared
    @State private var open = false

    var body: some View {
        ZStack {
            if status.enabled == true {
                Button { Haptics.play(.touch); open = true } label: {
                    switch style {
                    case .composer:
                        Image(systemName: "waveform").font(.system(size: 14, weight: .bold))
                            .composerCircle(fill: Theme.raised).foregroundStyle(Theme.muted)
                    case .toolbar:
                        ToolbarIcon("waveform")
                    }
                }
                .buttonStyle(PressStyle())
                .accessibilityIdentifier(style == .composer ? "talk" : "talk-header")
                .accessibilityLabel("Talk to Grok")
                .accessibilityHint("Opens a live voice conversation with Grok.")
            }
        }
        .task { await status.load() }
        .fullScreenCover(isPresented: $open) { TalkSheet(board: board) }
    }
}

/// A chat's top bar: the waveform, when voice is set up.
struct TalkToolbarItem: ToolbarContent {
    let board: Board
    @ObservedObject private var status = TalkStatus.shared

    var body: some ToolbarContent {
        if status.enabled == true {
            ToolbarItem(placement: .topBarTrailing) { TalkButton(board: board, style: .toolbar) }
        }
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
                .accessibilityIdentifier("talk-end")
            Spacer()
            VStack(spacing: 2) {
                Text("Grok").font(.headline).foregroundStyle(Theme.text)
                Text(timeLine).font(Typo.micro.monospacedDigit()).foregroundStyle(Theme.muted)
                    .accessibilityIdentifier("talk-timer")
            }
            Spacer()
            Button { talk.muted.toggle(); Haptics.play(.touch) } label: {
                Image(systemName: talk.muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                    .font(.system(size: 17, weight: .semibold)).foregroundStyle(talk.muted ? Theme.accent : Theme.muted)
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .accessibilityIdentifier("talk-mute")
            .accessibilityLabel(talk.muted ? "Unmute Grok" : "Mute Grok")
            .accessibilityHint("Grok's answers still show as captions.")
        }
        .padding(.horizontal, Space.l).padding(.top, Space.s)
    }

    private var timeLine: String {
        if talk.phase == .connecting { return "Connecting…" }
        if talk.phase == .ended { return talk.endNote ?? "Ended" }
        var s = "\(TalkSession.clock(talk.secondsLeft)) left"
        if let m = talk.monthMinutesLeft { s += " · \(m) min this month" }
        return s
    }

    private var captions: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Space.m) {
                    if talk.captions.isEmpty && talk.phase != .ended {
                        Text(talk.board.map { "Ask about \($0.displayName(me: AppState.shared.me?.owner)), what's waiting for you, or tell your agent something." } ?? "Ask what's waiting for you, catch up on a board, or tell your agent something.")
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
                Text(c.who == .you ? "You" : "Grok").font(Typo.micro.weight(.semibold)).foregroundStyle(c.who == .you ? Theme.muted : Theme.accent)
                    .accessibilityHidden(true)
                Text(c.text).font(c.who == .grok ? .title3 : .body).foregroundStyle(c.who == .grok ? Theme.text : Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel((c.who == .you ? "You: " : "Grok: ") + c.text)
                    .accessibilityIdentifier(c.who == .you ? "talk-you" : "talk-grok")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func confirmCard(_ c: TalkSession.Confirm) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Label("\(c.verb) \(c.approval)?", systemImage: "checkmark.shield").font(.headline).foregroundStyle(Theme.text)
            Text(c.confirmed ? "Heard yes. Grok will do it now." : "Nothing happens until you say “yes” or tap Yes.")
                .font(Typo.meta).foregroundStyle(Theme.muted)
            HStack(spacing: Space.s) {
                Button { talk.answerConfirm(false) } label: { Text("No").frame(maxWidth: .infinity).padding(.vertical, 10).background(Theme.raised, in: Capsule()) }
                    .accessibilityIdentifier("talk-confirm-no")
                Button { talk.answerConfirm(true) } label: { Text("Yes, \(c.verb.lowercased())").frame(maxWidth: .infinity).padding(.vertical, 10).background(Theme.accent, in: Capsule()).foregroundStyle(Theme.onAccent) }
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
        case .connecting: return "Connecting…"
        case .ended: return "Ended"
        case .ready:
            if talk.holding { return "Listening… let go to send" }
            if talk.speaking { return "Grok is speaking · tap to interrupt" }
            if talk.thinking { return "Thinking…" }
            return "Hold to talk"
        }
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
                .frame(height: 132)
            } else {
                Image(systemName: talk.holding ? "mic.fill" : talk.speaking ? "stop.fill" : "waveform")
                    .font(.system(size: 40, weight: .semibold))
                    .symbolEffect(.variableColor.iterative, isActive: (talk.holding || talk.speaking) && Effects.enabled)
                    .foregroundStyle(talk.holding ? Theme.onAccent : live ? Theme.text : Theme.faint)
                    .frame(width: 132, height: 132)
                    .background(talk.holding ? Theme.accent : Theme.raised, in: Circle())
                    .overlay(Circle().stroke(Theme.accent.opacity(talk.speaking ? 0.8 : 0), lineWidth: 3))
                    .scaleEffect(talk.holding ? 1.08 : 1)
                    .animation(.spring(duration: 0.25, bounce: 0.3), value: talk.holding)
                    .contentShape(Circle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { _ in if !pressing { pressing = true; talk.holdBegan() } }
                            .onEnded { _ in pressing = false; talk.holdEnded() }
                    )
                    .allowsHitTesting(live)
                    .accessibilityElement()
                    .accessibilityAddTraits(.isButton)
                    .accessibilityLabel(talk.holding ? "Send" : talk.speaking ? "Stop Grok" : "Talk")
                    .accessibilityHint("Hold and talk, then let go. While Grok speaks, tap to stop it.")
                    .accessibilityAction {
                        if talk.holding { talk.holdEnded() } else if talk.speaking { talk.interrupt() } else { talk.holdBegan() }
                    }
                    .accessibilityIdentifier("talk-button")
            }
            Text("Grok can read your boards, check what's waiting and message your agent. It asks before approving anything.")
                .font(Typo.micro).foregroundStyle(Theme.faint).multilineTextAlignment(.center)
                .padding(.horizontal, Space.xl)
        }
        .padding(.top, Space.m).padding(.bottom, Space.l)
    }
}

/// Settings → Talk to Grok: this month's minutes, or that it isn't set up.
struct TalkSection: View {
    @ObservedObject private var status = TalkStatus.shared

    var body: some View {
        Section {
            HStack {
                Label("Talk to Grok", systemImage: "waveform")
                Spacer()
                Text(status.enabled == true ? "\(Self.minutes(status.minutesUsed)) of \(status.minutesBudget) min" : status.enabled == false ? "Not set up" : "…")
                    .foregroundStyle(Theme.muted).monospacedDigit()
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("talk-settings")
        } footer: {
            Text(status.enabled == false
                 ? "Voice isn't set up yet. Typing, the mic in the message box and reading replies aloud still work."
                 : "Tap the waveform in a chat to talk with Grok, live. It can read your boards, check what's waiting and message your agent, and asks before approving anything. Minutes reset on the 1st.")
        }
        .listRowBackground(Theme.card)
        .task { await status.load(force: true) }
    }

    static func minutes(_ m: Double) -> String { m == m.rounded() ? String(Int(m)) : String(format: "%.1f", m) }
}
