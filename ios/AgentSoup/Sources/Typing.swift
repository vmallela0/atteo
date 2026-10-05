// "jxn is typing…" (#608, people only: agents working on your message say so with 🤔 under it). While you type, this
// phone tells the board every few seconds (POST /typing, nothing stored); others' composers hear it on the board's
// socket ({type:"typing", who, until}) and show a row above the message box (their pictures, stacked, and three
// breathing dots) until their message lands or `until` passes. The server's ping carries no thread, so a thread's
// reply box shows the same row as its chat.

import SwiftUI

extension AppState {
    /// You typed in a board's message box: say so, at most every 3 s, and only with words in the box.
    func typed(_ draft: String, in b: Board) {
        guard !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              b.archived != true, b.kind != "agent" else { return } // "Your agent": nobody else is there to see it
        let now = Date()
        if let last = typingSent[b.id], now.timeIntervalSince(last) < 3 { return }
        typingSent[b.id] = now
        Task { try? await API.shared.send("/api/boards/\(b.id)/typing", body: [String: Any](), retries: false) }
    }

    /// Someone's typing (from the socket): shown until `until`, then dropped (unless a newer ping came in).
    func heardTyping(_ who: String, until: Double, on board: String) {
        withAnimation(.smooth(duration: 0.25)) { typing[board, default: [:]][who] = until }
        let wait = max(0, until - Date().timeIntervalSince1970 * 1000) + 250
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000))
            guard let self, self.typing[board]?[who] == until else { return }
            withAnimation(.smooth(duration: 0.25)) { self.typing[board]?[who] = nil }
        }
    }

    /// Who's typing on a board right now (oldest first), at `now` (ms epoch).
    func typers(_ board: String, at now: Double) -> [String] {
        (typing[board] ?? [:]).filter { $0.value > now }.sorted { $0.value < $1.value }.map(\.key)
    }
}

/// Above the message box: up to three of their pictures, stacked, "jxn is typing", and three dots that breathe
/// (still, with Reduce Motion). Nothing when nobody is typing.
struct TypingRow: View {
    @EnvironmentObject var state: AppState
    let board: String

    var body: some View {
        // Ticks only while someone's typing, so a ping that runs out (they stopped, or left) clears on its own; with
        // nobody typing there's nothing here at all (no timer redrawing the chat).
        if !(state.typing[board] ?? [:]).isEmpty {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let who = state.typers(board, at: ctx.date.timeIntervalSince1970 * 1000)
            if !who.isEmpty {
                HStack(spacing: Space.s) {
                    HStack(spacing: -6) {
                        ForEach(Array(who.prefix(3).enumerated()), id: \.element) { i, u in
                            Avatar(name: u, size: 18).padding(1.5).background(Theme.bg, in: Circle()).zIndex(Double(3 - i))
                        }
                    }
                    Text(Self.line(who.map { state.displayName(for: $0) })).font(Typo.micro).foregroundStyle(Theme.muted).lineLimit(1)
                    TypingDots()
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Space.l)
                .frame(minHeight: 22)
                .padding(.bottom, Space.xs)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Self.line(who.map { state.displayName(for: $0) }))
                .accessibilityIdentifier("typing")
            }
        }
        }
    }

    /// "jxn is typing", "jxn and theo are typing", "jxn and 2 others are typing".
    static func line(_ who: [String]) -> String {
        switch who.count {
        case 1: return String(localized: "\(who[0]) is typing", bundle: .l10n)
        case 2: return String(localized: "\(who[0]) and \(who[1]) are typing", bundle: .l10n)
        default: return String(localized: "\(who[0]) and \(who.count - 1) others are typing", bundle: .l10n)
        }
    }
}

/// Three small dots rising and fading in turn; still and half-faded with Reduce Motion.
struct TypingDots: View {
    @Environment(\.accessibilityReduceMotion) private var still
    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: still)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            HStack(spacing: 3) {
                ForEach(0..<3, id: \.self) { i in
                    let p = Self.lift(t, i, still)
                    Circle().fill(Theme.muted).frame(width: 4, height: 4)
                        .opacity(still ? 0.6 : 0.35 + 0.65 * p)
                        .offset(y: -2 * p)
                }
            }
        }
        .frame(height: 8)
        .accessibilityHidden(true)
    }

    /// How far a dot is up (0…1): a 1.2 s cycle, each dot 0.2 s after the one before.
    static func lift(_ t: Double, _ i: Int, _ still: Bool) -> Double {
        guard !still else { return 0 }
        let phase: Double = (t - Double(i) * 0.2) / 1.2 * 2 * Double.pi
        return max(0, sin(phase))
    }
}
