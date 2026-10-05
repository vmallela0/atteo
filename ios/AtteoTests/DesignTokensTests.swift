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
        XCTAssertEqual(hex(Palette.cherry), "#A8121E")
        XCTAssertEqual(hex(Palette.cherryBright), "#E0303F")
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
        assertContrast(Theme.onCherryFill, on: Theme.cherryFill, atLeast: 4.5, "words on a cherry fill (Talk's Yes)")
        for name in ["maya", "vedu", "jxn", "theo", "Checkout bug", "Zoë", "小明", "a"] {
            assertContrast(Theme.avatarInk(name), on: Theme.avatarFill(name), atLeast: 4.5, "\(name)'s initial")
        }
    }

    func testCherryAndAtteoGlyphsAreVisible() {
        // Cherry (cherry-bright on dark) is for the primary action and the mic: glyphs, 3:1 is the bar there.
        assertContrast(Theme.cherry, on: Theme.bg, atLeast: 3, "cherry on the ground")
        assertContrast(Theme.onAccent, on: Theme.cherry, atLeast: 3, "a glyph on a cherry button")
        assertContrast(Theme.atteo, on: Theme.bg, atLeast: 4.5, "Atteo's caption in Talk")
        assertContrast(Theme.onAccent, on: Theme.atteo, atLeast: 4.5, "the glyph on Talk's orb")
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
        let dark = UITraitCollection(userInterfaceStyle: .dark)
        XCTAssertNotNil(UIImage(named: "AtteoMark", in: nil, compatibleWith: dark), "the reversed mark for dark")
    }
}
