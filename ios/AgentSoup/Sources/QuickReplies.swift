import SwiftUI

/// One-tap replies under an agent's question to you (vedu #2490, research item 2): the agent's own choices, or "Yes, go
/// ahead · Not now · Tell me more". The server decides which questions get them and sends them only to the people asked
/// (`quick` in the entries JSON); a tap sends the choice as your reply in the question's thread, which answers it.
struct QuickChips: Codable, Hashable {
    let options: [String]
    let own: Bool // the agent's own choices (shown as written); otherwise the defaults, translated here
}

extension AppState {
    /// A page of entries' chips, kept per board (merged: a page only covers its own entries).
    func adoptQuick(_ board: String, _ map: [String: QuickChips]?) {
        guard let map, !map.isEmpty else { return }
        var next = quickChips[board] ?? [:]
        for (k, v) in map { if let n = Int(k) { next[n] = v } }
        if next != quickChips[board] { quickChips[board] = next }
    }
}

struct QuickReplyRow: View {
    let chips: QuickChips
    let pick: (String) -> Void
    @State private var sent = false

    /// What each button says, and what it sends: the agent's words, or the defaults in your language.
    private var labels: [String] {
        chips.own ? chips.options : chips.options.map { String(localized: String.LocalizationValue($0), bundle: .l10n) }
    }

    var body: some View {
        // In one line when they fit, else stacked (long choices, large text, a narrow phone).
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Space.xs) { buttons }
            VStack(alignment: .leading, spacing: Space.xs) { buttons }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Quick replies", bundle: .l10n))
        .accessibilityIdentifier("quick-replies")
    }

    @ViewBuilder private var buttons: some View {
        ForEach(Array(labels.enumerated()), id: \.offset) { i, text in
            Button {
                guard !sent else { return }
                sent = true
                Haptics.play(.touch)
                pick(text)
            } label: {
                Text(verbatim: text).font(Typo.micro.weight(.semibold)).lineLimit(1)
                    .foregroundStyle(Theme.accent)
                    .padding(.horizontal, 12).frame(minHeight: 30)
                    .background(Theme.accent.opacity(0.12), in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(PressStyle())
            .disabled(sent)
            .accessibilityIdentifier("quick-reply-\(i + 1)")
        }
    }
}
