// The look: near-black, a few quiet greys, and one warm accent (clay) used only where something needs you: unread,
// the primary action, work in progress. Everything else is type and spacing. Calm, dense, fast.

import SwiftUI

enum Theme {
    static let bg = Color(red: 0.039, green: 0.039, blue: 0.039)
    static let card = Color(white: 0.09)
    static let raised = Color(white: 0.14) // your messages, pressed states
    static let line = Color(white: 0.15)
    static let text = Color(white: 0.95)
    static let muted = Color(white: 0.62)
    static let faint = Color(white: 0.40)
    static let accent = Color(red: 0.85, green: 0.47, blue: 0.34) // clay
    static let ok = Color(red: 0.45, green: 0.78, blue: 0.55)
    static let warn = Color(red: 0.95, green: 0.72, blue: 0.38)
    static let danger = Color(red: 0.94, green: 0.43, blue: 0.40)

    /// A stable color per name, for avatars.
    static func hue(_ s: String) -> Color {
        let h = s.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xffff }
        return Color(hue: Double(h % 360) / 360, saturation: 0.18, brightness: 0.80) // a hint of color, never loud
    }
}

/// Which pictures changed in this run (so the new one shows everywhere at once, past the image cache).
final class AvatarCache: ObservableObject {
    static let shared = AvatarCache()
    @Published private(set) var versions: [String: Int] = [:]
    func bump(_ name: String, agent: Bool) { versions["\(name):\(agent)", default: 0] += 1 }
    func version(_ name: String, agent: Bool) -> Int { versions["\(name):\(agent)"] ?? 0 }
}

struct Avatar: View {
    let name: String
    var agent = false
    var size: CGFloat = 32
    @ObservedObject private var cache = AvatarCache.shared

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: agent ? size * 0.28 : size / 2, style: .continuous)
                .fill(Theme.raised)
            Text(String(name.prefix(1)).uppercased())
                .font(.system(size: size * 0.42, weight: .medium))
                .foregroundStyle(Theme.hue(name))
            if agent {
                Image(systemName: "sparkle").font(.system(size: size * 0.28, weight: .bold)).foregroundStyle(Theme.accent)
                    .offset(x: size * 0.38, y: -size * 0.38)
            }
        }
        .frame(width: size, height: size)
        .overlay(alignment: .center) {
            AsyncImage(url: URL(string: "/avatar/\(name)?k=\(agent ? "agent" : "person")&v=\(cache.version(name, agent: agent))", relativeTo: API.shared.base)) { phase in
                if case .success(let img) = phase {
                    img.resizable().scaledToFill().frame(width: size, height: size)
                        .clipShape(RoundedRectangle(cornerRadius: agent ? size * 0.28 : size / 2, style: .continuous))
                }
            }
        }
    }
}

struct Pill: View {
    let text: String
    var color: Color = Theme.muted
    var body: some View {
        Text(text).font(.caption2.weight(.semibold)).padding(.horizontal, 7).padding(.vertical, 3)
            .background(color.opacity(0.14), in: Capsule()).foregroundStyle(color)
    }
}

enum Haptic {
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func done() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warn() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
}

extension View {
    func card() -> some View {
        padding(14).background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.line, lineWidth: 0.5))
    }
}

extension String {
    /// Inline Markdown (`code`, **bold**, links) as styled text; falls back to the plain string.
    var md: AttributedString {
        (try? AttributedString(markdown: self, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(self)
    }
}
