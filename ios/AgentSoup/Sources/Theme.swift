// The look (design language v1, board #2508): ink on paper, bone and stone for surfaces and rules, graphite for
// what's secondary. Neutral (jxn #2858): the one accent is oxblood, only on a screen's primary action (Send, the mic);
// you, mentions and unread are ink, and the logo's cone (you) is oxblood too (#2944, #2980). Type is Onest for the interface, Enriqueta for headlines and Courier Prime for the agent layer (ids,
// payloads). Only colours, fonts and the logo changed (jxn #2584): shapes, spacing and layout are as before. Every
// color has a dark and a light variant and follows the appearance (Settings → Display → Theme).

import SwiftUI

extension Color {
    /// A color with a light and a dark variant, resolved by the current appearance (survives UIColor(...) round trips).
    init(light: UIColor, dark: UIColor) {
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }
}

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> UIColor {
    UIColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

/// The design language's tokens, exactly as specified (board #2508); the same names and values as the web's.
enum Palette {
    static let ink = rgb(0x0E0E0E) // text, strings, the agent layer
    static let paper = rgb(0xFAFAF7) // the default ground
    static let oxblood = rgb(0x6A1B24) // the one accent: a screen's primary action (jxn #2858, #2861), and the logo's cone (you)
    static let oxbloodBright = rgb(0xC2414D) // the logo's cone on dark (art, never recoloured; #2861's value)
    static let oxbloodDark = rgb(0x9D333C) // oxblood on dark: #C2414D (#2861) darkened just enough for white at 7:1
    static let bone = rgb(0xF2EFE8) // secondary surfaces
    static let stone = rgb(0xD9D6CE) // dividers
    static let graphite = rgb(0x5A5853) // secondary text
}

/// The app's roles, with the web's look-1 values (src/ui.ts, light and dark) so the two match exactly.
enum Theme {
    static let bg = Color(light: Palette.paper, dark: Palette.ink) // --bg
    static let card = Color(light: Palette.bone, dark: rgb(0x171716)) // --bg-subtle: task cards, the work strip, the message box
    static let raised = Color(light: rgb(0xECE8DF), dark: rgb(0x1F1E1C)) // --bg-hover: your messages, pressed states
    static let line = Color(light: rgb(0xE4E1D9), dark: rgb(0x2A2926)) // --line
    static let lineStrong = Color(light: Palette.stone, dark: rgb(0x3A3935)) // --line-strong
    static let text = Color(light: rgb(0x161614), dark: rgb(0xEDEBE5)) // --text
    static let muted = Color(light: Palette.graphite, dark: rgb(0xAFADA6)) // --muted (6.8:1 on paper)
    static let faint = Color(light: rgb(0x6B6964), dark: rgb(0x8E8C85)) // --faint (5.0:1 on paper)
    /// What sits on an ink-filled control (the primary button, a count): paper on ink, ink on paper (--on-ink).
    static let onText = Color(light: Palette.paper, dark: Palette.ink)
    /// The accent is ink, as on the web (--accent): unread, links, focus and counts. The palette has no blue, and
    /// oxblood is kept for the primary action.
    static let accent = Color(light: Palette.ink, dark: Palette.paper)
    /// The primary action (--cta): oxblood, only on a screen's one main action (Send, the mic, Talk's Yes). Glyphs and
    /// words on it are white (onPrimary): 11.7:1 light, 7.1:1 dark.
    static let primary = Color(light: Palette.oxblood, dark: Palette.oxbloodDark)
    static let ok = Color(light: rgb(0x16A34A), dark: rgb(0x3ECF75)) // --ok
    static let warn = Color(light: rgb(0xC2410C), dark: rgb(0xFB923C)) // --warn
    static let danger = Color(light: rgb(0xDC2626), dark: rgb(0xF87171)) // --danger

    /// The web's avatar hue (src/ui.ts hue()): FNV-1a over the name's UTF-16 code units, picked from the same ten hues.
    static func hueDegrees(_ name: String) -> Int {
        var h: UInt32 = 0x811c9dc5
        // for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0: one step per code point, using
        // its first UTF-16 unit.
        for scalar in name.unicodeScalars {
            let unit = UInt32(String(scalar).utf16.first ?? 0)
            h = (h ^ unit) &* 0x01000193
        }
        let hues = [8, 28, 46, 140, 168, 192, 214, 248, 280, 322]
        return hues[Int(h % UInt32(hues.count))]
    }
    /// An avatar's tile and letter (the web's .av: hsl(h, 38%, 90%) and hsl(h, 55%, 26%) light; hsl(h, 26%, 22%) and
    /// hsl(h, 55%, 80%) dark).
    static func avatarFill(_ name: String) -> Color {
        let h = Double(hueDegrees(name))
        return Color(light: hsl(h, 0.08, 0.90), dark: hsl(h, 0.06, 0.22)) // a whisper of hue, near stone (jxn #2858)
    }
    static func avatarInk(_ name: String) -> Color {
        let h = Double(hueDegrees(name))
        return Color(light: hsl(h, 0.12, 0.26), dark: hsl(h, 0.12, 0.80))
    }
}

/// CSS hsl() as a UIColor (hue in degrees, saturation and lightness 0…1).
func hsl(_ h: Double, _ s: Double, _ l: Double) -> UIColor {
    let c = (1 - abs(2 * l - 1)) * s
    let hp = (h.truncatingRemainder(dividingBy: 360)) / 60
    let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
    let (r1, g1, b1): (Double, Double, Double) = switch hp {
    case ..<1: (c, x, 0)
    case ..<2: (x, c, 0)
    case ..<3: (0, c, x)
    case ..<4: (0, x, c)
    case ..<5: (x, 0, c)
    default: (c, 0, x)
    }
    let m = l - c / 2
    return UIColor(red: r1 + m, green: g1 + m, blue: b1 + m, alpha: 1)
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

/// The alignment grid (#722): every screen's content starts 16 pt in (Space.l); avatars and tiles centre on their
/// row, small glyphs (status rings, icons ≤ 22 pt) sit on the first line of the text beside them; one toolbar icon
/// size; list rows follow Display → Density.
enum Metrics {
    static let toolbarIcon: CGFloat = 16 // every symbol button in a top bar
    static let glyph: CGFloat = 16 // a row's leading status ring / symbol
    static func rowHeight(_ d: ChatDensity) -> CGFloat { d == .compact ? 36 : 44 } // a list row's minimum height
}

/// A symbol button's image in a top bar: one size and weight everywhere, in ink.
struct ToolbarIcon: View {
    let name: String
    init(_ name: String) { self.name = name }
    var body: some View { Image(systemName: name).font(.system(size: Metrics.toolbarIcon, weight: .semibold)).foregroundStyle(Theme.text) }
}

extension View {
    /// A text button in a top bar (Done, Cancel, Create): ink like every other (clay is for what needs you); the one
    /// that finishes the sheet is semibold.
    func toolbarText(primary: Bool = false) -> some View { fontWeight(primary ? .semibold : .regular).tint(Theme.text) }

    /// A small leading glyph lined up with the first line of the text beside it (its centre on the line's capitals),
    /// in an HStack(alignment: .firstTextBaseline).
    func onFirstLine(_ lift: CGFloat = 5) -> some View { alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + lift } }

    /// A list's rows at the person's density (Display → Density).
    func listDensity(_ d: ChatDensity) -> some View { environment(\.defaultMinListRowHeight, Metrics.rowHeight(d)) }

}

extension Color {
    /// This color as it looks in `scheme`, fixed: the top bar re-tints what's in it to suit whatever is scrolled under
    /// its glass (a dark picture turned a chat's title white on bone), so a chat's title is drawn in the app's own ink.
    func fixed(_ scheme: ColorScheme) -> Color {
        Color(uiColor: UIColor(self).resolvedColor(with: UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light)))
    }
}

/// Three radii: small surfaces (cards, tiles), controls (buttons, fields), bubbles.
enum Radius {
    static let card: CGFloat = 12
    static let control: CGFloat = 14
    static let bubble: CGFloat = 18
}

/// The design language's type: Onest for the interface (body 17, UI 15, caption 13), Enriqueta for headlines, Courier
/// Prime for the agent layer (ids, payloads, logs). Each scales with Dynamic Type from its text style; a script these
/// fonts don't cover (Chinese, Japanese, Korean, Arabic, Hindi, Bengali) falls back to the system font glyph by glyph.
enum Typo {
    static var composer: UIFont { .preferredFont(forTextStyle: .callout) }
    static func composerMention(_ font: UIFont) -> UIFont { .systemFont(ofSize: font.pointSize, weight: .semibold) }

    static let rowTitle = onest(15, .semibold, .subheadline) // a chat, a task, an agent
    static let rowTitleRead = onest(15, .medium, .subheadline)
    static let body = onest(17, .regular, .body) // messages
    static let secondary = onest(15, .regular, .subheadline) // previews, statuses
    static let meta = onest(13, .regular, .footnote) // times, who, counts
    static let micro = onest(12, .regular, .caption) // labels under things
    static let section = onest(13, .semibold, .footnote) // section headers

    /// Onest at a size and weight, scaling like `style`.
    static func onest(_ size: CGFloat, _ weight: Font.Weight = .regular, _ style: Font.TextStyle = .body) -> Font {
        let face = weight == .semibold || weight == .bold || weight == .heavy || weight == .black ? "Onest-SemiBold" : weight == .medium ? "Onest-Medium" : "Onest-Regular"
        return .custom(face, size: size, relativeTo: style)
    }
    /// A headline in Enriqueta SemiBold (never italic). Only the 600 face ships: no screen used the 400 one (vedu #6612).
    static func headline(_ size: CGFloat, _ style: Font.TextStyle = .title3) -> Font {
        .custom("Enriqueta-SemiBold", size: size, relativeTo: style)
    }
    /// The agent layer: ids, shas, payloads and commands in Courier Prime.
    static func mono(_ style: Font.TextStyle) -> Font { .custom("CourierPrime-Regular", size: size(style), relativeTo: style) }
    static func mono(size: CGFloat) -> Font { .custom("CourierPrime-Regular", size: size, relativeTo: .footnote) }
    /// An iOS text style in the design language: titles and headlines in Enriqueta, everything else in Onest.
    static func ui(_ style: Font.TextStyle) -> Font {
        switch style {
        case .largeTitle, .title, .title2, .title3, .headline: return headline(size(style), style)
        default: return onest(size(style), .regular, style)
        }
    }
    /// The default point size of a text style (at Large, the iOS default).
    static func size(_ style: Font.TextStyle) -> CGFloat {
        switch style {
        case .largeTitle: return 34
        case .title: return 28
        case .title2: return 22
        case .title3: return 20
        case .headline, .body: return 17
        case .callout: return 16
        case .subheadline: return 15
        case .footnote: return 13
        case .caption: return 12
        case .caption2: return 11
        @unknown default: return 17
        }
    }

    /// The app-wide UIKit fonts: navigation bar titles in Enriqueta, tab and bar buttons in Onest (once, at launch).
    static func applyUIKitAppearance() {
        func scaled(_ name: String, _ size: CGFloat, _ style: UIFont.TextStyle) -> UIFont {
            UIFontMetrics(forTextStyle: style).scaledFont(for: UIFont(name: name, size: size) ?? .preferredFont(forTextStyle: style))
        }
        let nav = UINavigationBar.appearance()
        nav.titleTextAttributes = [.font: scaled("Enriqueta-SemiBold", 17, .headline)]
        nav.largeTitleTextAttributes = [.font: scaled("Enriqueta-SemiBold", 34, .largeTitle)]
        UIBarButtonItem.appearance().setTitleTextAttributes([.font: scaled("Onest-Regular", 17, .body)], for: .normal)
        UITabBarItem.appearance().setTitleTextAttributes([.font: scaled("Onest-Medium", 10, .caption2)], for: .normal)
    }
}

/// Atteo's mark (jxn's atteo_design.pdf; the web's src/mark.ts): three curves through three nodes, cut by a rounded square
/// (radius 22.5% of its size). Vector, in the text's colour like the web's inline mark (currentColor): ink on paper, paper on
/// ink. The tiled version is the app icon (ios/design/logo-graph). At least 20pt.
struct AtteoMark: View {
    var size: CGFloat = 64
    var color: Color = Theme.text

    var body: some View {
        let s = max(size, 20), k = s / 100
        ZStack {
            AtteoGraph.Lines().stroke(color, style: StrokeStyle(lineWidth: 4.6 * k, lineCap: .round))
            AtteoGraph.Nodes(radius: 4.8).fill(color)
        }
        .frame(width: s, height: s)
        .clipShape(RoundedRectangle(cornerRadius: 22.5 * k, style: .circular))
        .accessibilityHidden(true)
    }
}

/// The graph mark's drawing in a 100×100 box: src/mark.ts MARK_PATH and its three nodes, verbatim.
enum AtteoGraph {
    /// Each curve: a start point, then cubic segments (control 1, control 2, end), as in the SVG path.
    static let curves: [[CGFloat]] = [
        [21, -8, 21.5, -2.2, 23.2, 12.8, 24, 27, 24.8, 41.2, 26.7, 63.5, 26, 77, 25.3, 90.5, 21, 102.8, 20, 108],
        [-8, 24, -2.7, 24.5, 12.5, 24.5, 24, 27, 35.5, 29.5, 47, 32.2, 61, 39, 75, 45.8, 100.2, 63.2, 108, 68],
        [86, -8, 81.8, -0.2, 71, 24.8, 61, 39, 51, 53.2, 35.8, 65.8, 26, 77, 16.2, 88.2, 6, 101.2, 2, 106],
    ]
    static let nodes: [CGPoint] = [CGPoint(x: 24, y: 27), CGPoint(x: 61, y: 39), CGPoint(x: 26, y: 77)]

    static func scale(_ rect: CGRect) -> CGAffineTransform {
        let k = min(rect.width, rect.height) / 100
        return CGAffineTransform(scaleX: k, y: k).concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY))
    }

    struct Lines: Shape {
        func path(in rect: CGRect) -> Path {
            var p = Path()
            for c in AtteoGraph.curves {
                p.move(to: CGPoint(x: c[0], y: c[1]))
                for i in stride(from: 2, to: c.count, by: 6) {
                    p.addCurve(to: CGPoint(x: c[i + 4], y: c[i + 5]), control1: CGPoint(x: c[i], y: c[i + 1]),
                               control2: CGPoint(x: c[i + 2], y: c[i + 3]))
                }
            }
            return p.applying(AtteoGraph.scale(rect))
        }
    }

    struct Nodes: Shape {
        var radius: CGFloat
        func path(in rect: CGRect) -> Path {
            var p = Path()
            for n in AtteoGraph.nodes { p.addEllipse(in: CGRect(x: n.x - radius, y: n.y - radius, width: radius * 2, height: radius * 2)) }
            return p.applying(AtteoGraph.scale(rect))
        }
    }
}

/// The wordmark (atteo_design.pdf p.1, as on the web and the landing page): lowercase "atteo" in STIX Two Text Regular, in
/// the text's colour, letter-spacing -0.01em. `height` is its font size; the name stays "Atteo" for VoiceOver.
struct AtteoWordmark: View {
    var height: CGFloat = 32
    var color: Color = Theme.text
    var body: some View {
        Text(verbatim: "atteo")
            .font(.custom("STIXTwoText", fixedSize: height))
            .tracking(-0.01 * height)
            .foregroundStyle(color)
            .lineLimit(1).fixedSize()
            .accessibilityLabel("Atteo")
    }
}

/// The mark beside the wordmark, as the web's lockup: the mark at about 0.9× the wordmark's font size (20px beside 22px),
/// about 0.35em apart (8px). `height` is the wordmark's font size.
struct AtteoLockup: View {
    var height: CGFloat = 36
    var body: some View {
        HStack(spacing: height * 0.36) {
            AtteoMark(size: height * 0.91)
            AtteoWordmark(height: height)
        }
        .accessibilityElement(children: .ignore).accessibilityLabel("Atteo").accessibilityAddTraits(.isHeader)
    }
}

/// Working right now: a small green dot that breathes (still, with Reduce Motion).
struct LiveDot: View {
    var size: CGFloat = 7
    @State private var on = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Still too in UI tests (ATTEO_STILL): an animation that never ends keeps the app from ever being "idle" for them.
    private var still: Bool { reduceMotion || API.environment("STILL") != nil }
    var body: some View {
        Circle().fill(Theme.ok).frame(width: size, height: size)
            .overlay(Circle().stroke(Theme.ok.opacity(0.5), lineWidth: 2).scaleEffect(on && !still ? 2.2 : 1).opacity(on && !still ? 0 : 0.8))
            .onAppear { if !still { withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) { on = true } } }
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

/// A person (round) or an agent (rounded square, with a small spark), their initial on a calm tint picked from the
/// name exactly as the web does (look-1's .av). Their picture if they set one. (Colour only: jxn #2525, #2584.)
struct Avatar: View {
    let name: String
    var agent = false
    var size: CGFloat = 32
    @ObservedObject private var cache = AvatarCache.shared

    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: agent ? size * 0.3 : size / 2, style: .continuous) }

    var body: some View {
        ZStack {
            shape.fill(Theme.avatarFill(name))
            Text(String(name.prefix(1)).uppercased())
                .font(.custom("Onest-SemiBold", size: size * 0.42))
                .foregroundStyle(Theme.avatarInk(name))
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
                // The agent's spark, as before, in graphite (cherry is kept for you and the primary action).
                Image(systemName: "sparkle").font(.system(size: max(7, size * 0.26), weight: .bold)).foregroundStyle(Theme.muted)
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
            .fill(Theme.avatarFill(title))
            .frame(width: size, height: size)
            .overlay(Text(initial).font(.custom("Onest-SemiBold", size: size * 0.4)).foregroundStyle(Theme.avatarInk(title)))
    }
}

struct Pill: View {
    let text: Text
    var color: Color = Theme.muted
    /// The app's own words (a literal): localized.
    init(text: LocalizedStringKey, color: Color = Theme.muted) { self.text = Text(text); self.color = color }
    /// A string from code, as is (like Text's): localize it first when it's the app's own words.
    @_disfavoredOverload init<S: StringProtocol>(text: S, color: Color = Theme.muted) { self.text = Text(text); self.color = color }
    var body: some View {
        text.font(Typo.onest(12, .semibold, .caption)).padding(.horizontal, Space.s).padding(.vertical, 3)
            .background(color.opacity(0.14), in: Capsule()).foregroundStyle(color)
    }
}

/// A grouped list's section title: small, quiet, sentence case.
struct SectionHeader: View {
    let title: Text
    init(_ title: LocalizedStringKey) { self.title = Text(title) }
    /// A string from code, as is (like Text's): localize it first (String(localized:)) when it's the app's own words.
    @_disfavoredOverload init<S: StringProtocol>(_ title: S) { self.title = Text(title) }
    var body: some View { title.font(Typo.section).foregroundStyle(Theme.muted).textCase(nil) }
}

/// An unread count: a small ink capsule (the accent), on-ink on it.
struct CountBadge: View {
    let n: Int
    var body: some View {
        Text("\(n)").font(Typo.onest(11, .semibold, .caption2)).monospacedDigit()
            .padding(.horizontal, 6).frame(minWidth: 18, minHeight: 18)
            .background(Theme.accent, in: Capsule()).foregroundStyle(Theme.onAccent)
    }
}

/// Semantic tokens (jxn #2706): views use these roles, never the palette or a literal, the same roles as the web's
/// semantic layer in src/ui.ts. You and mentions are ink (jxn #2858); status colours keep their meaning.
extension Theme {
    /// You, and what's for you (--you): ink, paper on dark.
    static let you = Theme.accent
    /// A message that mentions you, at rest (--you-soft).
    static let youSoft = Color(light: Palette.ink.withAlphaComponent(0.05), dark: Palette.paper.withAlphaComponent(0.08))
    /// A mention's words (--mention-fg) and box (--mention-bg); a mention of you sits on --mention-you-bg.
    static let mentionText = Color(light: Palette.ink, dark: Palette.paper)
    static let mentionBox = Color(light: Palette.ink.withAlphaComponent(0.07), dark: Palette.paper.withAlphaComponent(0.12))
    /// A mention of you: the same ink box, twice as strong (--mention-you-bg).
    static let mentionYouBox = Color(light: Palette.ink.withAlphaComponent(0.15), dark: Palette.paper.withAlphaComponent(0.24))
    /// The New line and unread marks (--unread).
    static let unread = Theme.accent
    /// Atteo speaking in Talk (--voice): ink, neutral like the rest (jxn #2858).
    static let voice = Theme.accent
    /// The board's type colours, the web's values (--decision, --task, --claim).
    static let decision = Color(light: rgb(0x7C3AED), dark: rgb(0xA78BFA))
    static let task = Color(light: rgb(0x0284C7), dark: rgb(0x38BDF8))
    static let claim = Color(light: rgb(0x16A34A), dark: rgb(0x4ADE80))
    /// A change card's added and removed lines.
    static let diffAdded = Color(light: rgb(0x228C45), dark: rgb(0x5CC778))
    static let diffRemoved = Color(light: rgb(0xC73833), dark: rgb(0xF26B66))
    /// File kinds in Files (their icon tint).
    static let kindDoc = Color(light: rgb(0x8CA8F2), dark: rgb(0x8CA8F2))
    static let kindCode = Color(light: rgb(0xB399F2), dark: rgb(0xB399F2))
    static let kindImage = Color(light: rgb(0x73C7D1), dark: rgb(0x73C7D1))
}

extension Theme {
    /// What sits on an accent fill (a count, Talk's orb): --on-ink (paper on light, ink on dark).
    static let onAccent = Color(light: Palette.paper, dark: Palette.ink)
    /// Glyphs and words on the primary fill (the send arrow, the mic, Talk's Yes): white in both modes (--on-cta).
    static let onPrimary = Color(uiColor: .white)
}

// MARK: - Display settings (Settings → Display; saved per person on the server, cached here)

/// Text size, density, theme, language, voice and replies, as the server stores them (`profile.display`, /api/app/prefs).
/// Unknown values decode to the defaults, so a newer web setting never breaks the app.
struct DisplayPrefs: Codable, Equatable {
    var text: String = "m" // s | m | l
    var density: String = "comfortable" // comfortable | compact
    var theme: String = "system" // system | light | dark
    var lang: String = "auto" // auto | en | zh-Hans | zh-Hant | es | ja | ko | hi (Language.swift)
    var voice: String = "eve" // read-aloud and voice chat (TalkView.swift VoicePicker); the server uses it when the app names none
    /// Replies (vedu #2360): "chat" lands them in the chat like any message, under a quote bar (jxn #1040); "thread" keeps
    /// them in their thread, and the chat shows only "N replies" under the message they answer.
    var replies: String = "chat"
    /// False when the server's copy had no `replies` (a server from before it): the phone's own choice stands, and saves
    /// leave the key out if the server refuses it.
    var repliesKnown = true
    /// Voice chat: when Atteo answers (vedu #2460, VoiceTurns.swift): "quick", "pause" (the default) or "tap".
    var voiceTurns: String = "pause"
    /// False when the server's copy had no `voice_turns` (a server from before it): the phone's choice stands, and
    /// saves leave the key out.
    var voiceTurnsKnown = true
    /// Messages (jxn #2690, the web's #2691): "off" shows every message whole; "others" folds the ones that aren't for
    /// you to one line (OneLine.swift).
    var compact: String = "off"
    /// False when the server's copy had no `compact` (a server from before it): the phone's choice stands, and saves
    /// leave the key out.
    var compactKnown = true
    /// The board tabs' order (vedu #5192): "recent" (the latest message first, the default) or "opened" (the board you
    /// opened last first; members.opened_at, set by the web and the app).
    var tabOrder: String = "recent"
    /// False when the server's copy had no `tab_order` (a server from before it): the phone's choice stands, and saves
    /// leave the key out.
    var tabOrderKnown = true

    static let `default` = DisplayPrefs()
    /// xAI's voices, in the order the picker lists them (the server's tts.ts VOICES).
    static let voices = ["eve", "ara", "leo", "rex", "sal"]

    private enum CodingKeys: String, CodingKey { case text, density, theme, lang, voice, replies, voiceTurns = "voice_turns", compact, tabOrder = "tab_order" }

    init(text: String = "m", density: String = "comfortable", theme: String = "system", lang: String = "auto", voice: String = "eve", replies: String = "chat", voiceTurns: String = "pause", compact: String = "off", tabOrder: String = "recent") {
        self.text = ["s", "m", "l"].contains(text) ? text : "m"
        self.density = ["comfortable", "compact"].contains(density) ? density : "comfortable"
        self.theme = ["system", "light", "dark"].contains(theme) ? theme : "system"
        self.lang = AppLanguage.values.contains(lang) ? lang : "auto"
        self.voice = Self.voices.contains(voice) ? voice : "eve"
        self.replies = ["chat", "thread"].contains(replies) ? replies : "chat"
        self.voiceTurns = VoiceTurns(rawValue: voiceTurns) != nil ? voiceTurns : "pause"
        self.compact = ["off", "others"].contains(compact) ? compact : "off"
        self.tabOrder = ["recent", "opened"].contains(tabOrder) ? tabOrder : "recent"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let replies = try? c.decode(String.self, forKey: .replies)
        let turns = try? c.decode(String.self, forKey: .voiceTurns)
        let compact = try? c.decode(String.self, forKey: .compact)
        let tabOrder = try? c.decode(String.self, forKey: .tabOrder)
        self.init(text: (try? c.decode(String.self, forKey: .text)) ?? "m",
                  density: (try? c.decode(String.self, forKey: .density)) ?? "comfortable",
                  theme: (try? c.decode(String.self, forKey: .theme)) ?? "system",
                  lang: (try? c.decode(String.self, forKey: .lang)) ?? "auto",
                  voice: (try? c.decode(String.self, forKey: .voice)) ?? "eve",
                  replies: replies ?? "chat",
                  voiceTurns: turns ?? "pause",
                  compact: compact ?? "off",
                  tabOrder: tabOrder ?? "recent")
        repliesKnown = replies != nil
        voiceTurnsKnown = turns != nil
        compactKnown = compact != nil
        tabOrderKnown = tabOrder != nil
    }
    static func == (a: DisplayPrefs, b: DisplayPrefs) -> Bool {
        a.text == b.text && a.density == b.density && a.theme == b.theme && a.lang == b.lang && a.voice == b.voice && a.replies == b.replies && a.voiceTurns == b.voiceTurns && a.compact == b.compact && a.tabOrder == b.tabOrder
    }
    /// "l,compact,dark", "l,compact,dark,zh-Hans", "l,compact,dark,zh-Hans,leo", "l,compact,dark,zh-Hans,leo,thread" or
    /// "…,thread,others" (messages that aren't for you fold to one line)
    /// (the DEBUG ATTEO_DISPLAY override for simulator screenshots).
    init?(spec: String) {
        let p = spec.split(separator: ",").map(String.init)
        guard (3...7).contains(p.count) else { return nil }
        self.init(text: p[0], density: p[1], theme: p[2], lang: p.count >= 4 ? p[3] : "auto", voice: p.count >= 5 ? p[4] : "eve", replies: p.count >= 6 ? p[5] : "chat",
                  compact: p.count == 7 ? p[6] : "off")
    }

    var chatDensity: ChatDensity { density == "compact" ? .compact : .comfortable }
    var interfaceStyle: UIUserInterfaceStyle { theme == "light" ? .light : theme == "dark" ? .dark : .unspecified }
    /// Steps on top of the person's iOS Dynamic Type: S two smaller (Large → Small), M as is, L one larger (→ xLarge).
    var textSteps: Int { text == "s" ? -2 : text == "l" ? 1 : 0 }
    /// Replies stay in their thread (the chat shows "N replies" instead).
    var repliesInThread: Bool { replies == "thread" }
    /// Messages that aren't for you fold to one line (OneLine.swift).
    var foldOthers: Bool { compact == "others" }
    /// The board tabs put the board you opened last first, not the one with the latest message.
    var tabsByOpened: Bool { tabOrder == "opened" }
    /// What's saved: everything, or without `replies` / `voice_turns` for a server that doesn't take them yet.
    func body(replies withReplies: Bool = true, turns withTurns: Bool = true, compact withCompact: Bool = true, tabs withTabs: Bool = true) -> [String: String] {
        var b = ["text": text, "density": density, "theme": theme, "lang": lang, "voice": voice]
        if withReplies { b["replies"] = replies }
        if withTurns { b["voice_turns"] = voiceTurns }
        if withCompact { b["compact"] = compact }
        if withTabs { b["tab_order"] = tabOrder }
        return b
    }
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
            .font(Typo.body) // the interface's default face (Onest) for any text that doesn't name one
            .environment(\.chatDensity, prefs.chatDensity)
            .environment(\.locale, L10n.locale) // dates and numbers in the chosen language (Language.swift)
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
    /// The same, with no tappable links: for a one-line preview inside a row you tap as a whole (a link there took
    /// the row's tap and left the app, jxn #4173).
    var mdPreview: AttributedString {
        var a = md
        for r in a.runs.filter({ $0.link != nil }).map(\.range) { a[r].link = nil }
        return a
    }
}
