// The way into voice chat (TalkView.swift has the sheet), placed like a call (vedu #1783, replacing the waveform by the
// message box's mic from #1602): a phone at the top right of the chat's bar, and at the top right of Everyday's Ask
// screen (EverydayHooks.talk). The message box keeps the mic for dictation only. Hidden while voice isn't set up on the
// server (GET /api/app/voice/status says disabled).

import SwiftUI

/// The phone: tap to start a voice chat. The chat presents the sheet itself (`tap`), so it isn't owned by a toolbar
/// item that the bar may rebuild.
struct TalkCallButton: View {
    var identifier = "talk"
    var color: Color = Theme.text
    let tap: () -> Void
    @ObservedObject private var status = TalkStatus.shared

    var body: some View {
        ZStack {
            if status.enabled == true {
                Button { Haptics.play(.touch); tap() } label: {
                    Image(systemName: "phone").font(.system(size: 17, weight: .medium)).foregroundStyle(color)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .accessibilityIdentifier(identifier)
                .accessibilityLabel("Voice chat with Atteo")
                .accessibilityHint("Opens a live, hands-free voice chat.")
            }
        }
        .task { await status.load() }
    }

    /// Everyday's Ask screen gets the same sheet (no board: it's about you, and can message your assistant).
    static func plugIn() {
        EverydayHooks.talk = { MainActor.assumeIsolated { AnyView(AskCall()) } }
    }
}

/// Ask's phone, with the sheet it opens (Ask's header is a plain view, not a navigation bar).
private struct AskCall: View {
    @State private var open = false
    var body: some View {
        TalkCallButton(identifier: "ask-talk", color: Theme.muted) { open = true }
            .fullScreenCover(isPresented: $open) { TalkSheet(board: nil) }
    }
}
