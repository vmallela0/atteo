// The look: near-black, quiet greys, one soft accent, SF Pro. Inspired by Cursor's iOS app: dense, calm, fast.

import SwiftUI

enum Theme {
    static let bg = Color(red: 0.035, green: 0.035, blue: 0.04)
    static let card = Color(white: 0.085)
    static let line = Color(white: 0.16)
    static let text = Color(white: 0.94)
    static let muted = Color(white: 0.56)
    static let faint = Color(white: 0.36)
    static let accent = Color(red: 0.55, green: 0.62, blue: 1.0)
    static let ok = Color(red: 0.36, green: 0.84, blue: 0.56)
    static let warn = Color(red: 1.0, green: 0.74, blue: 0.33)
    static let danger = Color(red: 1.0, green: 0.42, blue: 0.42)

    /// A stable color per name, for avatars.
    static func hue(_ s: String) -> Color {
        let h = s.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xffff }
        return Color(hue: Double(h % 360) / 360, saturation: 0.45, brightness: 0.78)
    }
}

struct Avatar: View {
    let name: String
    var agent = false
    var size: CGFloat = 32

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: agent ? size * 0.28 : size / 2, style: .continuous)
                .fill(Theme.hue(name).opacity(0.22))
            Text(String(name.prefix(2)).uppercased())
                .font(.system(size: size * 0.36, weight: .semibold, design: .rounded))
                .foregroundStyle(Theme.hue(name))
            if agent {
                Image(systemName: "sparkle").font(.system(size: size * 0.3, weight: .bold)).foregroundStyle(Theme.accent)
                    .offset(x: size * 0.36, y: -size * 0.36)
            }
        }
        .frame(width: size, height: size)
        .overlay(alignment: .center) {
            AsyncImage(url: URL(string: "/avatar/\(name)\(agent ? "?k=agent" : "")", relativeTo: API.shared.base)) { phase in
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
