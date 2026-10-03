// Renders Atteo's app icon (opaque PNG, 1024x1024 by default) with Core Graphics: no downloaded assets.
// The mark: two speech bubbles facing each other, the space where they overlap cut away. Two voices (you, in bone;
// the other side, in clay), one conversation; the gap between them is the "o". Same geometry as AtteoMark in
// ios/AgentSoup/Sources/Theme.swift.
// Usage: swift ios/qa/design/icon.swift ios/AgentSoup/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The two halves of the mark in a unit square (y down).
func atteoMark() -> (CGPath, CGPath) {
    let r = 0.205, dx = 0.112, cy = 0.475, gap = 0.034
    func bubble(_ cx: Double, _ side: Double) -> CGPath {
        // A circle with a short tail on its outer, lower edge.
        let p = CGMutablePath()
        p.addEllipse(in: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r))
        let a1 = (side < 0 ? 180.0 - 48 : 48.0) * .pi / 180, a2 = (side < 0 ? 180.0 - 84 : 84.0) * .pi / 180
        let tail = CGMutablePath()
        tail.move(to: CGPoint(x: cx + r * cos(a1), y: cy + r * sin(a1)))
        tail.addQuadCurve(to: CGPoint(x: cx + side * r * 0.86, y: cy + r * 1.13), control: CGPoint(x: cx + side * r * 0.82, y: cy + r * 0.98))
        tail.addQuadCurve(to: CGPoint(x: cx + r * cos(a2), y: cy + r * sin(a2)), control: CGPoint(x: cx + side * r * 0.52, y: cy + r * 1.06))
        tail.closeSubpath()
        return p.union(tail)
    }
    let lc = CGPath(ellipseIn: CGRect(x: 0.5 - dx - r, y: cy - r, width: 2 * r, height: 2 * r), transform: nil)
    let rc = CGPath(ellipseIn: CGRect(x: 0.5 + dx - r, y: cy - r, width: 2 * r, height: 2 * r), transform: nil)
    // A hair of space around the shared lens, so the two read as separate voices.
    let core = lc.intersection(rc)
    let lens = core.copy(strokingWithWidth: gap, lineCap: .round, lineJoin: .round, miterLimit: 1).union(core)
    return (bubble(0.5 - dx, -1).subtracting(lens), bubble(0.5 + dx, 1).subtracting(lens))
}

let args = CommandLine.arguments
let out = args.count > 1 ? args[1] : "icon-1024.png"
let size = args.count > 2 ? Int(args[2])! : 1024
let s = CGFloat(size)
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
// Opaque (App Store icons have no alpha); full bleed (iOS rounds the corners).
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.translateBy(x: 0, y: s); ctx.scaleBy(x: 1, y: -1) // y down, like the unit path

func gradient(_ a: (Double, Double, Double), _ b: (Double, Double, Double)) -> CGGradient {
    CGGradient(colorsSpace: cs, colors: [CGColor(srgbRed: a.0, green: a.1, blue: a.2, alpha: 1), CGColor(srgbRed: b.0, green: b.1, blue: b.2, alpha: 1)] as CFArray, locations: [0, 1])!
}

// Ground: the app's near-black, with the faintest lift toward the top.
ctx.drawLinearGradient(gradient((0.105, 0.100, 0.098), (0.043, 0.041, 0.040)), start: .zero, end: CGPoint(x: 0, y: s), options: [])

// The two voices, each gently lit from above.
var t = CGAffineTransform(scaleX: s, y: s)
let (left, right) = atteoMark()
for (path, g) in [(left, gradient((0.97, 0.96, 0.94), (0.86, 0.85, 0.83))), (right, gradient((0.91, 0.53, 0.39), (0.80, 0.42, 0.30)))] {
    ctx.saveGState()
    ctx.addPath(path.copy(using: &t)!); ctx.clip()
    ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: s * 0.2), end: CGPoint(x: 0, y: s * 0.8), options: [])
    ctx.restoreGState()
}

let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
CGImageDestinationFinalize(dest)
print("wrote \(out) \(size)x\(size)")
