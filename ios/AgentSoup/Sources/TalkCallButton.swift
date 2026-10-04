// The way into voice chat (TalkView.swift has the sheet), placed like a call (vedu #1783, replacing the waveform by the
// message box's mic from #1602): a phone at the top right. The chat's is in its top bar beside Threads and Tasks
// (BoardsView.swift, with the sheet on the message box); Everyday's Ask screen gets this one, across from Close
// (EverydayHooks.talk). The message box keeps the mic for dictation only. Hidden while voice isn't set up on the server
// (GET /api/app/voice/status says disabled).

import SwiftUI

/// Ask's phone, with the sheet it opens (Ask's header is a plain view, not a navigation bar).
struct TalkCallButton: View {
    let board: Board?
    var identifier = "ask-talk"
    @ObservedObject private var status = TalkStatus.shared
    @State private var open = false

    var body: some View {
        ZStack {
            if status.enabled == true {
                Button { Haptics.play(.touch); open = true } label: {
                    Image(systemName: "phone").font(.system(size: 17, weight: .medium)).foregroundStyle(Theme.muted)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .accessibilityIdentifier(identifier)
                .accessibilityLabel("Voice chat with Atteo")
                .accessibilityHint("Opens a live, hands-free voice chat.")
            }
        }
        .task { await status.load() }
        .fullScreenCover(isPresented: $open) { TalkSheet(board: board) }
    }

    /// Everyday's Ask screen gets the same sheet (no board: it's about you, and can message your assistant).
    static func plugIn() {
        EverydayHooks.talk = { MainActor.assumeIsolated { AnyView(TalkCallButton(board: nil)) } }
    }
}
