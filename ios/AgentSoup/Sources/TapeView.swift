// The tape: everything happening across your boards and DMs, live, one line each.

import SwiftUI

struct TapeView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        NavigationStack {
            List(state.tape) { l in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(Date(timeIntervalSince1970: l.ts / 1000), format: .dateTime.hour().minute().second())
                            .font(.caption2.monospacedDigit()).foregroundStyle(Theme.faint)
                        Text(l.dm == true ? "dm" : (l.board ?? l.boardId)).font(.caption.weight(.medium)).foregroundStyle(Theme.hue(l.boardId)).lineLimit(1)
                        Text("#\(l.seq)").font(.caption2).foregroundStyle(Theme.faint)
                        Spacer()
                        Pill(text: l.type, color: l.type == "question" ? Theme.warn : Theme.muted)
                    }
                    (Text(l.via == "agent" ? "\(l.author)'s agent" : l.author).fontWeight(.semibold).foregroundStyle(Theme.text)
                        + Text(l.toUser.map { " → \($0)" } ?? "").foregroundStyle(Theme.faint)
                        + Text("  ") + Text(l.excerpt.md).foregroundStyle(Theme.muted))
                        .font(.subheadline).lineLimit(2)
                }
                .listRowBackground(Theme.bg)
                .listRowSeparatorTint(Theme.line)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Tape")
            .overlay { if state.tape.isEmpty { ContentUnavailableView("Quiet", systemImage: "waveform", description: Text("New posts on your boards show up here as they happen.")) } }
        }
    }
}
