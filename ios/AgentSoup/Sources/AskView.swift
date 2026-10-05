// Everyday's Ask screen (ios/qa/design/everyday, `ask`): voice first. A big clay circle: tap and talk (transcribed on
// this phone, like the message box's hold-to-talk in Voice.swift), tap again when you're done and it goes to your
// assistant (your "Your assistant" chat). Or pick a suggestion, or type instead. EverydayHooks.talk adds a live
// voice chat at the top right, like a call, when another feature provides one.

import SwiftUI

struct AskView: View {
    @EnvironmentObject var state: AppState
    @ObservedObject private var voice = VoiceInput.shared
    /// Start with the keyboard (the "Ask your assistant…" bar) instead of listening (its mic).
    @State var typing: Bool
    /// Closes the screen: the chat your ask went to, or nil if you closed it without asking.
    let done: (Board?) -> Void
    @State private var heard = ""
    @State private var text = ""
    @State private var sending = false
    @FocusState private var focused: Bool

    init(typing: Bool, done: @escaping (Board?) -> Void) {
        _typing = State(initialValue: typing)
        self.done = done
    }

    /// "Grok", "ChatGPT"… when your assistant runs in one (a coding tool's name stays in Developer mode).
    private var provider: String? {
        guard let c = state.sessions.first?.client, !AppMode.isCodingAgent(c) else { return nil }
        return AppMode.clientName(c)
    }

    private var suggestions: [(icon: String, text: String)] {
        var out: [(String, String)] = [("checklist", String(localized: "What needs me today?", bundle: .l10n))]
        if let b = state.boards.first(where: { $0.archived != true && !$0.isAgentChat }) {
            out.append(("bubble.left", String(localized: "What did I miss in \(b.shownTitle(me: state.me?.owner, names: state.personNames))?", bundle: .l10n)))
        }
        out.append(("calendar", String(localized: "Find a time to meet next week", bundle: .l10n)))
        out.append(("bell", String(localized: "Remind me about this tomorrow morning", bundle: .l10n)))
        return out
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(spacing: Space.l) {
                    if typing { typeBox } else { listen }
                    tries
                }
                .padding(.horizontal, Space.l).padding(.bottom, Space.l)
            }
            .scrollDismissesKeyboard(.interactively)
            footer
        }
        .background(Theme.bg.ignoresSafeArea())
        .onAppear { if typing { focused = true } else { start() } }
        .onDisappear { voice.stop() }
        .alert("Talk", isPresented: Binding(get: { voice.problem != nil }, set: { if !$0 { voice.problem = nil } })) {
            Button("Type instead") { typing = true; focused = true }
            Button("OK", role: .cancel) {}
        } message: { Text(voice.problem ?? "") }
        .accessibilityElement(children: .contain) // (its own id; the buttons inside keep theirs)
        .accessibilityIdentifier("ask-screen")
    }

    private var header: some View {
        ZStack {
            HStack(spacing: Space.s) {
                AtteoMark(size: 22)
                (provider.map { Text("Your assistant · \($0)") } ?? Text("Your assistant")).font(Typo.secondary).foregroundStyle(Theme.muted)
            }
            HStack {
                Button { voice.stop(); done(nil) } label: {
                    Image(systemName: "xmark").font(.system(size: 17, weight: .medium)).foregroundStyle(Theme.muted).frame(width: 44, height: 44)
                }
                .accessibilityLabel("Close")
                .accessibilityIdentifier("ask-close")
                Spacer()
                // A live voice conversation, when one is plugged in (EverydayHooks.talk): top right, like a call.
                if let talk = EverydayHooks.talk { talk() }
            }
        }
        .padding(.horizontal, Space.s).padding(.top, Space.xs)
    }

    // MARK: Voice

    private var listen: some View {
        VStack(spacing: Space.l) {
            Button { if voice.listening { voice.stop() } else { start() } } label: {
                ZStack {
                    Circle().fill(Theme.primary.opacity(0.08)).frame(width: 196, height: 196)
                    Circle().fill(Theme.primary.opacity(0.14)).frame(width: 160, height: 160)
                        .scaleEffect(voice.listening && Effects.enabled ? 1.06 : 1)
                        .animation(voice.listening && Effects.enabled && API.environment("STILL") == nil ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true) : .default, value: voice.listening)
                    Circle().fill(Theme.primary).frame(width: 108, height: 108)
                    Image(systemName: voice.listening ? "waveform" : "mic.fill").font(.system(size: 34, weight: .semibold)).foregroundStyle(.white)
                }
                .contentShape(Circle())
            }
            .buttonStyle(PressStyle())
            .accessibilityLabel(voice.listening ? "Done talking" : "Talk")
            .accessibilityIdentifier("ask-circle")
            .padding(.top, Space.l)

            (heard.isEmpty ? (voice.listening ? Text("I'm listening…") : Text("Tap and tell your assistant what you need")) : Text(verbatim: heard))
                .font(Typo.ui(.title2).weight(.semibold)).foregroundStyle(heard.isEmpty ? Theme.muted : Theme.text)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .accessibilityIdentifier("ask-heard")
            Text(sending ? "Sending…" : voice.listening ? "Listening… tap the circle when you're done" : "Speech is turned into text on this phone.")
                .font(Typo.secondary).foregroundStyle(Theme.faint)
        }
    }

    private func start() {
        heard = ""
        voice.start { t, final in
            heard = VoiceInput.sendIt(t) ?? t
            if final { Task { await ask(heard) } }
        }
    }

    // MARK: Typing

    private var typeBox: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            Text("What do you need?").font(Typo.ui(.title2).weight(.semibold)).foregroundStyle(Theme.text).padding(.top, Space.l)
            HStack(alignment: .bottom, spacing: Space.s) {
                TextField("Ask your assistant…", text: $text, axis: .vertical)
                    .font(Typo.body).lineLimit(1...6)
                    .focused($focused)
                    .submitLabel(.send)
                    .onSubmit { Task { await ask(text) } }
                    .padding(.horizontal, Space.m).padding(.vertical, Space.m)
                    .accessibilityIdentifier("ask-field")
                Button { Task { await ask(text) } } label: {
                    Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.onPrimary)
                        .frame(width: 36, height: 36).background(Theme.primary, in: Circle())
                }
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
                .opacity(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
                .padding(.trailing, 6).padding(.bottom, 6)
                .accessibilityLabel("Ask")
                .accessibilityIdentifier("ask-send")
            }
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Theme.line))
        }
    }

    // MARK: Suggestions and the bottom row

    private var tries: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text("Or try").font(Typo.secondary).foregroundStyle(Theme.muted).padding(.top, Space.s)
            ForEach(suggestions, id: \.text) { s in
                Button { if typing { text = s.text; focused = true } else { Task { await ask(s.text) } } } label: {
                    HStack(spacing: Space.m) {
                        Image(systemName: s.icon).font(.system(size: 15)).foregroundStyle(Theme.muted).frame(width: 22)
                        Text(s.text).font(Typo.body).foregroundStyle(Theme.text).multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, Space.l).frame(minHeight: 50)
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.line))
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .accessibilityIdentifier("ask-try")
            }
        }
    }

    private var footer: some View {
        HStack(spacing: Space.m) {
            Button {
                voice.stop()
                withAnimation(.smooth) { typing.toggle() }
                if typing { focused = true }
            } label: {
                Label(typing ? "Talk instead" : "Type instead", systemImage: typing ? "mic" : "keyboard")
                    .font(Typo.body.weight(.medium)).foregroundStyle(Theme.text)
                    .padding(.horizontal, Space.l).frame(height: 44)
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.line))
            }
            .buttonStyle(PressStyle())
            .accessibilityIdentifier("ask-switch")
        }
        .padding(.vertical, Space.s)
    }

    /// Sends it to your assistant (your "Your assistant" chat, made the first time) and opens that chat.
    private func ask(_ raw: String) async {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !sending else { return }
        sending = true
        defer { sending = false }
        let chat: Board?
        if let b = state.agentChat { chat = b } else { chat = await state.openAgentChat() }
        guard let b = chat else { return }
        Haptics.play(.sent)
        Task { await state.send(t, to: b) }
        done(b)
    }
}
