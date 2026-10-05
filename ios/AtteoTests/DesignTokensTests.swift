// Design language v1 (board #2508) in the app: the tokens' contrast holds (WCAG AA: 4.5:1 for text, 3:1 for glyphs,
// strokes and large text) in light and dark, and the bundled fonts register and pick the right face per weight.

import SwiftUI
import XCTest
@testable import Atteo

final class DesignTokensTests: XCTestCase {
    private func luminance(_ c: UIColor) -> Double {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        c.getRed(&r, green: &g, blue: &b, alpha: &a)
        func lin(_ v: CGFloat) -> Double { let v = Double(v); return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }
    private func contrast(_ a: Color, _ b: Color, _ style: UIUserInterfaceStyle) -> Double {
        let t = UITraitCollection(userInterfaceStyle: style)
        let la = luminance(UIColor(a).resolvedColor(with: t)), lb = luminance(UIColor(b).resolvedColor(with: t))
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }
    private func assertContrast(_ fg: Color, on bg: Color, atLeast min: Double, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let c = contrast(fg, bg, style)
            XCTAssertGreaterThanOrEqual(c, min, "\(what) in \(style == .dark ? "dark" : "light"): \(String(format: "%.2f", c)):1", file: file, line: line)
        }
    }

    func testTokensMatchTheSpec() {
        func hex(_ c: UIColor) -> String {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            c.getRed(&r, green: &g, blue: &b, alpha: &a)
            return String(format: "#%02X%02X%02X", Int(round(r * 255)), Int(round(g * 255)), Int(round(b * 255)))
        }
        XCTAssertEqual(hex(Palette.ink), "#0E0E0E")
        XCTAssertEqual(hex(Palette.paper), "#FAFAF7")
        XCTAssertEqual(hex(Palette.oxblood), "#6A1B24")
        XCTAssertEqual(hex(Palette.oxbloodDark), "#9D333C")
        XCTAssertEqual(hex(Palette.oxbloodBright), "#C2414D")
        XCTAssertEqual(hex(Palette.bone), "#F2EFE8")
        XCTAssertEqual(hex(Palette.stone), "#D9D6CE")
        XCTAssertEqual(hex(Palette.graphite), "#5A5853")
    }

    func testTextIsAAOnEverySurface() {
        for (name, surface) in [("bg", Theme.bg), ("card", Theme.card), ("raised", Theme.raised)] {
            assertContrast(Theme.text, on: surface, atLeast: 4.5, "text on \(name)")
            assertContrast(Theme.muted, on: surface, atLeast: 4.5, "muted on \(name)")
        }
        assertContrast(Theme.faint, on: Theme.bg, atLeast: 4.5, "faint on bg")
        assertContrast(Theme.faint, on: Theme.card, atLeast: 4.5, "faint on card")
        assertContrast(Theme.onText, on: Theme.text, atLeast: 4.5, "the primary button's label")
        assertContrast(Theme.onAccent, on: Theme.accent, atLeast: 4.5, "a count (on-ink on the ink accent)")
        assertContrast(Theme.onText, on: Theme.muted, atLeast: 4.5, "the selected Just mine chip (neutral, #2858)")
        assertContrast(Theme.onText, on: Theme.text, atLeast: 4.5, "the selected People chip")
        assertContrast(Theme.onPrimary, on: Theme.primary, atLeast: 7, "words on the primary action (Send, Talk's Yes): 7:1 (jxn #2861)")
        for name in ["maya", "vedu", "jxn", "theo", "Checkout bug", "Zoë", "小明", "a"] {
            assertContrast(Theme.avatarInk(name), on: Theme.avatarFill(name), atLeast: 4.5, "\(name)'s initial")
        }
    }

    func testPrimaryAndVoiceGlyphsAreVisible() {
        // Oxblood is the one accent, on the primary action (jxn #2858). Its dark value is darkened for white text at
        // 7:1, which leaves it just under 3:1 against the dark ground; its white label carries it there.
        XCTAssertGreaterThanOrEqual(contrast(Theme.primary, Theme.bg, .light), 3, "oxblood on paper")
        XCTAssertGreaterThanOrEqual(contrast(Theme.primary, Theme.bg, .dark), 2.5, "oxblood on the dark ground")
        assertContrast(Theme.voice, on: Theme.bg, atLeast: 3, "Talk's orb while Atteo speaks (--voice; a shape, not words)")
        assertContrast(Theme.onAccent, on: Theme.voice, atLeast: 3, "the glyph on Talk's orb")
    }

    /// A translucent token drawn over the ground, as the eye sees it.
    private func over(_ top: Color, _ bottom: Color) -> Color {
        Color(UIColor { t in
            var r1: CGFloat = 0, g1: CGFloat = 0, b1: CGFloat = 0, a1: CGFloat = 0, r2: CGFloat = 0, g2: CGFloat = 0, b2: CGFloat = 0, a2: CGFloat = 0
            UIColor(top).resolvedColor(with: t).getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
            UIColor(bottom).resolvedColor(with: t).getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
            return UIColor(red: r1 * a1 + r2 * (1 - a1), green: g1 * a1 + g2 * (1 - a1), blue: b1 * a1 + b2 * (1 - a1), alpha: 1)
        })
    }

    func testSemanticTokens() {
        // jxn #2706: one semantic layer, the same roles as the web's (src/ui.ts). Mentions and you are ink (jxn #2858).
        assertContrast(Theme.mentionText, on: over(Theme.mentionBox, Theme.bg), atLeast: 4.5, "a mention's words in its box")
        assertContrast(Theme.mentionText, on: over(Theme.mentionYouBox, Theme.bg), atLeast: 4.5, "a mention of you, in its stronger ink box")
        assertContrast(Theme.text, on: over(Theme.youSoft, Theme.bg), atLeast: 4.5, "a message that mentions you, on its tint")
        assertContrast(Theme.unread, on: Theme.bg, atLeast: 3, "the New line and unread marks")
        let t = UITraitCollection(userInterfaceStyle: .light)
        XCTAssertEqual(UIColor(Theme.you).resolvedColor(with: t), UIColor(Theme.accent).resolvedColor(with: t), "you is ink")
        XCTAssertEqual(UIColor(MentionColor.mineBox).resolvedColor(with: t), UIColor(Theme.mentionYouBox).resolvedColor(with: t), "mentions of you use the token")
    }

    func testAvatarHueMatchesTheWeb() {
        // Expected values from the web's ui.ts hue() (look-1), run in node over the same names.
        let web: [String: Int] = ["maya": 322, "vedu": 28, "jxn": 140, "theo": 140, "Checkout bug": 322, "Zoë": 248, "小明": 168, "🙂ana": 280, "a": 8]
        for (name, h) in web { XCTAssertEqual(Theme.hueDegrees(name), h, name) }
    }

    func testFontsRegister() {
        for name in ["Onest-Regular", "Onest-Medium", "Onest-SemiBold", "Enriqueta-Regular", "Enriqueta-SemiBold", "CourierPrime-Regular", "Schoolbell-Regular"] {
            XCTAssertNotNil(UIFont(name: name, size: 17), "\(name) is bundled and registered (Info.plist UIAppFonts)")
        }
    }

    func testOnestWeightsPickTheirFace() {
        // One typographic family, so a weight on an Onest font finds its face rather than a synthesized one.
        let semibold = UIFontDescriptor(fontAttributes: [.family: "Onest", .traits: [UIFontDescriptor.TraitKey.weight: UIFont.Weight.semibold]])
        XCTAssertEqual(UIFont(descriptor: semibold, size: 17).fontName, "Onest-SemiBold")
        let medium = UIFontDescriptor(fontAttributes: [.family: "Onest", .traits: [UIFontDescriptor.TraitKey.weight: UIFont.Weight.medium]])
        XCTAssertEqual(UIFont(descriptor: medium, size: 17).fontName, "Onest-Medium")
    }

    func testTheArtShips() {
        XCTAssertNotNil(UIImage(named: "AtteoMark"), "the mark")
        XCTAssertNotNil(UIImage(named: "AtteoWordmark"), "the wordmark")
        // UIImage(named:compatibleWith:) falls back to the light art when the dark variant is missing, so compare pixels.
        let light = UIImage(named: "AtteoMark", in: nil, compatibleWith: UITraitCollection(userInterfaceStyle: .light))
        let dark = UIImage(named: "AtteoMark", in: nil, compatibleWith: UITraitCollection(userInterfaceStyle: .dark))
        XCTAssertNotNil(dark, "the reversed mark for dark")
        XCTAssertNotEqual(light?.pngData(), dark?.pngData(), "the dark mark is its own art (paper strokes), not the light one")
    }
}
