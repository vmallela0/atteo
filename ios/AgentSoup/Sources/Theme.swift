// The look: near-black (or, in light mode, warm bone), a few quiet greys, and one warm accent (clay) used only where
// something needs you: unread, the primary action, work in progress. Everything else is type, weight and spacing:
// subtle fills instead of outlines, a 4-pt grid, one type scale (SF Pro), three corner radii. Calm, dense, fast.
// Every color has a dark and a light variant and follows the appearance (Settings → Display → Theme).

import SwiftUI

extension Color {
    /// A color with a light and a dark variant, resolved by the current appearance (survives UIColor(...) round trips).
    init(light: UIColor, dark: UIColor) {
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }
}

private func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> UIColor {
    UIColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

enum Theme {
    static let bg = Color(light: rgb(0xF2EEE6), dark: UIColor(red: 0.039, green: 0.039, blue: 0.039, alpha: 1)) // bone / near-black
    static let card = Color(light: rgb(0xFBF9F5), dark: UIColor(white: 0.095, alpha: 1)) // grouped surfaces: task cards, the work strip, the message box
    static let raised = Color(light: rgb(0xE6E0D5), dark: UIColor(white: 0.145, alpha: 1)) // your messages, avatars, pressed states
    static let line = Color(light: rgb(0xDCD6CB), dark: UIColor(white: 0.16, alpha: 1)) // hairlines only
    static let text = Color(light: rgb(0x1A1917), dark: UIColor(white: 0.95, alpha: 1)) // ink
    static let muted = Color(light: rgb(0x625E57), dark: UIColor(white: 0.64, alpha: 1))
    static let faint = Color(light: rgb(0x8E897F), dark: UIColor(white: 0.44, alpha: 1))
    /// What sits on a `text`-filled control (the primary button): near-black on light ink in dark mode, bone on ink in light.
    static let onText = Color(light: rgb(0xF7F4EE), dark: .black)
    static let accent = Color(light: rgb(0xC9653F), dark: UIColor(red: 0.85, green: 0.47, blue: 0.34, alpha: 1)) // clay (a touch deeper on bone)
    static let ok = Color(light: rgb(0x2E8A4E), dark: UIColor(red: 0.45, green: 0.78, blue: 0.55, alpha: 1))
    static let warn = Color(light: rgb(0xB0701A), dark: UIColor(red: 0.95, green: 0.72, blue: 0.38, alpha: 1))
    static let danger = Color(light: rgb(0xC63F3B), dark: UIColor(red: 0.94, green: 0.43, blue: 0.40, alpha: 1))

    /// A stable color per name, for avatars (darker on bone so the initial stays readable).
    static func hue(_ s: String) -> Color {
        let h = s.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xffff }
        let hue = CGFloat(h % 360) / 360
        return Color(light: UIColor(hue: hue, saturation: 0.38, brightness: 0.52, alpha: 1), dark: UIColor(hue: hue, saturation: 0.22, brightness: 0.82, alpha: 1)) // a hint of color, never loud
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

    /// A list row's vertical padding (top and bottom) at a density: comfortable 8, compact 3.
    static func row(_ d: ChatDensity) -> CGFloat { d == .compact ? 3 : s }
    /// The gap between stacked items (messages, cards) at a density: comfortable 8, compact 4.
    static func gap(_ d: ChatDensity) -> CGFloat { d == .compact ? xs : s }
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
/// The icon draws the agent half in ink on bone (with a bone eye), and so does light mode; on the app's near-black the
/// defaults flip it to bone, eyes in ink.
struct AtteoMark: View {
    var size: CGFloat = 64
    var you: Color = Color(red: 0.85, green: 0.47, blue: 0.34) // clay, #D97857 (the icon's, in both modes)
    var agent: Color = Color(light: UIColor(red: 0.067, green: 0.067, blue: 0.075, alpha: 1), dark: UIColor(red: 0.949, green: 0.937, blue: 0.910, alpha: 1))
    var youEye: Color = AtteoMark.ink
    var agentEye: Color = Color(light: UIColor(red: 0.949, green: 0.937, blue: 0.910, alpha: 1), dark: UIColor(red: 0.067, green: 0.067, blue: 0.075, alpha: 1))
    static let bone = Color(red: 0.949, green: 0.937, blue: 0.910) // #F2EFE8
    static let ink = Color(red: 0.067, green: 0.067, blue: 0.075) // #111113
    /// The wordmark: bone on near-black, ink on bone.
    static let word = Color(light: UIColor(red: 0.067, green: 0.067, blue: 0.075, alpha: 1), dark: UIColor(red: 0.949, green: 0.937, blue: 0.910, alpha: 1))

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
            .background(Theme.accent, in: Capsule()).foregroundStyle(Theme.onAccent)
    }
}

extension Theme {
    /// What sits on clay (a count, the send arrow): black in both modes.
    static let onAccent = Color.black
}

// MARK: - Display settings (Settings → Display; saved per person on the server, cached here)

/// Text size, density and theme, as the server stores them (`profile.display`). Unknown values decode to the defaults,
/// so a newer web setting never breaks the app.
struct DisplayPrefs: Codable, Equatable {
    var text: String = "m" // s | m | l
    var density: String = "comfortable" // comfortable | compact
    var theme: String = "system" // system | light | dark

    static let `default` = DisplayPrefs()

    init(text: String = "m", density: String = "comfortable", theme: String = "system") {
        self.text = ["s", "m", "l"].contains(text) ? text : "m"
        self.density = ["comfortable", "compact"].contains(density) ? density : "comfortable"
        self.theme = ["system", "light", "dark"].contains(theme) ? theme : "system"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(text: (try? c.decode(String.self, forKey: .text)) ?? "m",
                  density: (try? c.decode(String.self, forKey: .density)) ?? "comfortable",
                  theme: (try? c.decode(String.self, forKey: .theme)) ?? "system")
    }
    /// "l,compact,dark" (the DEBUG ATTEO_DISPLAY override for simulator screenshots).
    init?(spec: String) {
        let p = spec.split(separator: ",").map(String.init)
        guard p.count == 3 else { return nil }
        self.init(text: p[0], density: p[1], theme: p[2])
    }

    var chatDensity: ChatDensity { density == "compact" ? .compact : .comfortable }
    var interfaceStyle: UIUserInterfaceStyle { theme == "light" ? .light : theme == "dark" ? .dark : .unspecified }
    /// Steps on top of the person's iOS Dynamic Type: S two smaller (Large → Small), M as is, L one larger (→ xLarge).
    var textSteps: Int { text == "s" ? -2 : text == "l" ? 1 : 0 }
    var body: [String: String] { ["text": text, "density": density, "theme": theme] }
}

/// How tight lists and the chat sit. Read it with `@Environment(\.chatDensity)`; pad rows with `Space.row(density)`.
enum ChatDensity: String { case comfortable, compact }

private struct ChatDensityKey: EnvironmentKey { static let defaultValue: ChatDensity = .comfortable }
extension EnvironmentValues {
    var chatDensity: ChatDensity {
        get { self[ChatDensityKey.self] }
        set { self[ChatDensityKey.self] = newValue }
    }
}

extension DynamicTypeSize {
    /// This size moved `steps` along the scale, clamped to its ends.
    func shifted(_ steps: Int) -> DynamicTypeSize {
        let all = DynamicTypeSize.allCases
        guard steps != 0, let i = all.firstIndex(of: self) else { return self }
        return all[min(all.count - 1, max(0, i + steps))]
    }
}

/// The app root's display settings: text size on top of the person's Dynamic Type, the theme, and density for every
/// screen below.
///
/// Text size and theme are set on the windows (UIKit traits), not only as SwiftUI modifiers: sheets are separate
/// presentations that take their Dynamic Type and appearance from the window, so a `.dynamicTypeSize` at the root
/// never reaches Settings or any other sheet. No `.preferredColorScheme` either: after a forced value, setting it back
/// to nil leaves an open sheet in the old appearance (Dark → System stayed dark until relaunch). Density is a plain
/// environment value; sheets that need it get it passed in.
struct DisplayRoot<Content: View>: View {
    let prefs: DisplayPrefs
    @ViewBuilder let content: Content

    var body: some View {
        content
            .environment(\.chatDensity, prefs.chatDensity)
            .onAppear { apply() }
            .onChange(of: prefs) { _, _ in apply() }
            // Your iPhone's text size changed (Settings → Display & Brightness): stay the same steps on top of it.
            .onReceive(NotificationCenter.default.publisher(for: UIContentSizeCategory.didChangeNotification)) { _ in apply() }
            .onReceive(NotificationCenter.default.publisher(for: UIScene.willEnterForegroundNotification)) { _ in apply() }
    }

    private func apply() {
        // The app-wide setting (the person's iOS Dynamic Type); window trait overrides don't change it.
        let system = DynamicTypeSize(UIApplication.shared.preferredContentSizeCategory) ?? .large
        let size = UIContentSizeCategory(system.shifted(prefs.textSteps))
        for scene in UIApplication.shared.connectedScenes {
            guard let ws = scene as? UIWindowScene else { continue }
            for w in ws.windows {
                w.overrideUserInterfaceStyle = prefs.interfaceStyle
                // (Reading an override that was never set is an assertion failure: check with contains first.)
                let set = w.traitOverrides.contains(UITraitPreferredContentSizeCategory.self)
                if prefs.textSteps == 0 { if set { w.traitOverrides.remove(UITraitPreferredContentSizeCategory.self) } }
                else if !set || w.traitOverrides.preferredContentSizeCategory != size { w.traitOverrides.preferredContentSizeCategory = size }
            }
        }
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
