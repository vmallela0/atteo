// The look: near-black, a few quiet greys, and one warm accent (clay) used only where something needs you: unread,
// the primary action, work in progress. Everything else is type, weight and spacing: subtle fills instead of
// outlines, a 4-pt grid, one type scale (SF Pro), three corner radii. Calm, dense, fast.

import SwiftUI

enum Theme {
    static let bg = Color(red: 0.039, green: 0.039, blue: 0.039)
    static let card = Color(white: 0.095) // grouped surfaces: task cards, the work strip, the message box
    static let raised = Color(white: 0.145) // your messages, avatars, pressed states
    static let line = Color(white: 0.16) // hairlines only
    static let text = Color(white: 0.95)
    static let muted = Color(white: 0.64)
    static let faint = Color(white: 0.44)
    static let accent = Color(red: 0.85, green: 0.47, blue: 0.34) // clay
    static let ok = Color(red: 0.45, green: 0.78, blue: 0.55)
    static let warn = Color(red: 0.95, green: 0.72, blue: 0.38)
    static let danger = Color(red: 0.94, green: 0.43, blue: 0.40)

    /// A stable color per name, for avatars.
    static func hue(_ s: String) -> Color {
        let h = s.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xffff }
        return Color(hue: Double(h % 360) / 360, saturation: 0.22, brightness: 0.82) // a hint of color, never loud
    }
}

/// The 4-pt grid.
enum Space {
    static let xxs: CGFloat = 2
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 24
}

/// Three radii: small surfaces (cards, tiles), controls (buttons, fields), bubbles.
enum Radius {
    static let card: CGFloat = 12
    static let control: CGFloat = 14
    static let bubble: CGFloat = 18
}

/// One type scale (Dynamic Type styles, SF Pro): what each role uses, everywhere.
enum Typo {
    static let rowTitle = Font.callout.weight(.semibold) // a chat, a task, an agent
    static let rowTitleRead = Font.callout.weight(.medium)
    static let body = Font.callout // messages
    static let secondary = Font.subheadline // previews, statuses
    static let meta = Font.footnote // times, who, counts
    static let micro = Font.caption // labels under things
    static let section = Font.footnote.weight(.semibold) // section headers
}

/// Atteo's mark, "the Pebble": one soft pebble split by a slightly slanted seam. The clay half is you, the other
/// half your agent; two round eyes meet across the seam. Same geometry as the app icon (ios/qa/design/icon.swift).
/// The icon draws the agent half in ink on bone; on the app's near-black the defaults flip it to bone, eyes in ink.
struct AtteoMark: View {
    var size: CGFloat = 64
    var you: Color = Theme.accent // clay, #D97857
    var agent: Color = AtteoMark.bone
    var youEye: Color = AtteoMark.ink
    var agentEye: Color = AtteoMark.ink
    static let bone = Color(red: 0.949, green: 0.937, blue: 0.910) // #F2EFE8
    static let ink = Color(red: 0.067, green: 0.067, blue: 0.075) // #111113

    var body: some View {
        let p = Self.paths()
        let t = CGAffineTransform(scaleX: size, y: size)
        ZStack(alignment: .topLeading) {
            Path(p.left).applying(t).fill(you)
            Path(p.right).applying(t).fill(agent)
            Path(ellipseIn: p.leftEye).applying(t).fill(youEye)
            Path(ellipseIn: p.rightEye).applying(t).fill(agentEye)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// The Pebble in a unit square (y down): the two halves and the two eyes. Keep in step with icon.swift's pebble().
    static func paths() -> (left: CGPath, right: CGPath, leftEye: CGRect, rightEye: CGRect) {
        let u = 1.0 / 1024
        let body = CGRect(x: 189 * u, y: 229 * u, width: 647 * u, height: 566 * u)
        let corner = 283 * u, gap = 36 * u, eye = 54 * u
        let shape = CGPath(roundedRect: body, cornerWidth: corner, cornerHeight: corner, transform: nil)
        // The seam: from (549, 229) at the top to (498, 795) at the bottom, leaning left going down.
        let top = CGPoint(x: 549 * u, y: body.minY), bottom = CGPoint(x: 498 * u, y: body.maxY)
        let dx = bottom.x - top.x, dy = bottom.y - top.y, len = (dx * dx + dy * dy).squareRoot()
        let n = CGPoint(x: dy / len, y: -dx / len) // unit normal, pointing right
        func half(_ side: Double) -> CGPath {
            let o = CGPoint(x: n.x * side * gap / 2, y: n.y * side * gap / 2)
            let far = CGPoint(x: n.x * side * 4, y: n.y * side * 4)
            let ext = CGPoint(x: dx / len * 4, y: dy / len * 4)
            let a = CGPoint(x: top.x + o.x - ext.x, y: top.y + o.y - ext.y), b = CGPoint(x: bottom.x + o.x + ext.x, y: bottom.y + o.y + ext.y)
            let p = CGMutablePath()
            p.addLines(between: [a, b, CGPoint(x: b.x + far.x, y: b.y + far.y), CGPoint(x: a.x + far.x, y: a.y + far.y)])
            p.closeSubpath()
            return shape.intersection(p)
        }
        func circle(_ x: Double, _ y: Double) -> CGRect { CGRect(x: x * u - eye, y: y * u - eye, width: 2 * eye, height: 2 * eye) }
        return (half(-1), half(1), circle(405, 468), circle(634, 498))
    }
}

/// Working right now: a small green dot that breathes (still, with Reduce Motion).
struct LiveDot: View {
    var size: CGFloat = 7
    @State private var on = false
    @Environment(\.accessibilityReduceMotion) private var still
    var body: some View {
        Circle().fill(Theme.ok).frame(width: size, height: size)
            .overlay(Circle().stroke(Theme.ok.opacity(0.5), lineWidth: 2).scaleEffect(on && !still ? 2.2 : 1).opacity(on && !still ? 0 : 0.8))
            .onAppear { withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) { on = true } }
            .accessibilityHidden(true)
    }
}

/// Which pictures changed in this run (so the new one shows everywhere at once, past the image cache).
final class AvatarCache: ObservableObject {
    static let shared = AvatarCache()
    @Published private(set) var versions: [String: Int] = [:]
    func bump(_ name: String, agent: Bool) { versions["\(name):\(agent)", default: 0] += 1 }
    func version(_ name: String, agent: Bool) -> Int { versions["\(name):\(agent)"] ?? 0 }
}

/// A person (round) or an agent (rounded square, with a small clay spark). Their picture if they set one.
struct Avatar: View {
    let name: String
    var agent = false
    var size: CGFloat = 32
    @ObservedObject private var cache = AvatarCache.shared

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: agent ? size * 0.3 : size / 2, style: .continuous) }

    var body: some View {
        ZStack {
            shape.fill(Theme.hue(name).opacity(0.16))
            Text(String(name.prefix(1)).uppercased())
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(Theme.hue(name))
        }
        .frame(width: size, height: size)
        .overlay(alignment: .center) {
            AsyncImage(url: URL(string: "/avatar/\(name)?k=\(agent ? "agent" : "person")&v=\(cache.version(name, agent: agent))", relativeTo: API.shared.base)) { phase in
                if case .success(let img) = phase {
                    img.resizable().scaledToFill().frame(width: size, height: size).clipShape(shape)
                }
            }
        }
        .overlay(alignment: .topTrailing) {
            if agent {
                Image(systemName: "sparkle").font(.system(size: max(7, size * 0.26), weight: .bold)).foregroundStyle(Theme.accent)
                    .offset(x: size * 0.14, y: -size * 0.14)
            }
        }
    }
}

/// A board's tile in Chats: a rounded square with its initial (a board is a place, a person is a circle).
struct BoardTile: View {
    let title: String
    var size: CGFloat = 40
    var body: some View {
        let initial = title.first(where: { $0.isLetter || $0.isNumber }).map { String($0).uppercased() } ?? "#"
        RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
            .fill(Theme.hue(title).opacity(0.16))
            .frame(width: size, height: size)
            .overlay(Text(initial).font(.system(size: size * 0.4, weight: .semibold)).foregroundStyle(Theme.hue(title)))
    }
}

struct Pill: View {
    let text: String
    var color: Color = Theme.muted
    var body: some View {
        Text(text).font(.caption.weight(.semibold)).padding(.horizontal, Space.s).padding(.vertical, 3)
            .background(color.opacity(0.14), in: Capsule()).foregroundStyle(color)
    }
}

/// A grouped list's section title: small, quiet, sentence case.
struct SectionHeader: View {
    let title: String
    init(_ title: String) { self.title = title }
    var body: some View { Text(title).font(Typo.section).foregroundStyle(Theme.muted).textCase(nil) }
}

/// An unread count: a small clay capsule.
struct CountBadge: View {
    let n: Int
    var body: some View {
        Text("\(n)").font(.caption2.weight(.bold)).monospacedDigit()
            .padding(.horizontal, 6).frame(minWidth: 18, minHeight: 18)
            .background(Theme.accent, in: Capsule()).foregroundStyle(.black)
    }
}

/// A button that dips a little under your finger.
struct PressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.spring(duration: 0.25, bounce: 0.3), value: configuration.isPressed)
    }
}

enum Haptic {
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func done() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warn() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
}

extension View {
    /// A grouped surface: a quiet fill, no outline.
    func surface(padding: CGFloat = Space.m, radius: CGFloat = Radius.card) -> some View {
        self.padding(padding).background(Theme.card, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

extension String {
    /// Inline Markdown (`code`, **bold**, links) as styled text; falls back to the plain string.
    var md: AttributedString {
        (try? AttributedString(markdown: self, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(self)
    }
}
