// Renders Atteo's app icon (opaque PNG, 1024x1024 by default) with Core Graphics: no downloaded assets.
// The mark, "the Pebble": one soft pebble split by a slightly slanted seam. The clay half is you, the ink half is
// your agent; two round eyes meet across the seam. Same geometry as AtteoMark in ios/AgentSoup/Sources/Theme.swift.
// Usage: swift ios/qa/design/icon.swift ios/AgentSoup/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png
//        swift ios/qa/design/icon.swift --sizes ios/qa/design/pebble-sizes.png   (180/60/29 px on dark and light)
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The Pebble in a unit square (y down): the two halves and the two eyes. Keep in step with AtteoMark.paths().
func pebble() -> (left: CGPath, right: CGPath, leftEye: CGRect, rightEye: CGRect) {
    let u = 1.0 / 1024
    let body = CGRect(x: 189 * u, y: 229 * u, width: 647 * u, height: 566 * u)
    let corner = 283 * u, gap = 36 * u, eye = 54 * u // corner: the full half-height (a CSS 300 radius, clamped); gap and eyes a touch past the design (27, 48) so they hold at 29 px
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

let bone = (0.949, 0.937, 0.910) // #F2EFE8
let clay = (0.851, 0.471, 0.341) // #D97857
let ink = (0.067, 0.067, 0.075) // #111113
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
func color(_ c: (Double, Double, Double)) -> CGColor { CGColor(srgbRed: c.0, green: c.1, blue: c.2, alpha: 1) }

func render(_ size: Int) -> CGImage {
    let s = CGFloat(size)
    // Opaque (App Store icons have no alpha); full bleed (iOS rounds the corners).
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.translateBy(x: 0, y: s); ctx.scaleBy(x: 1, y: -1) // y down, like the unit path
    ctx.setFillColor(color(bone)); ctx.fill(CGRect(x: 0, y: 0, width: s, height: s))
    var t = CGAffineTransform(scaleX: s, y: s)
    let p = pebble()
    ctx.setFillColor(color(clay)); ctx.addPath(p.left.copy(using: &t)!); ctx.fillPath()
    ctx.setFillColor(color(ink)); ctx.addPath(p.right.copy(using: &t)!); ctx.fillPath()
    ctx.setFillColor(color(ink)); ctx.fillEllipse(in: p.leftEye.applying(t))
    ctx.setFillColor(color(bone)); ctx.fillEllipse(in: p.rightEye.applying(t))
    return ctx.makeImage()!
}

func write(_ img: CGImage, _ out: String) {
    let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
    print("wrote \(out) \(img.width)x\(img.height)")
}

let args = CommandLine.arguments
if args.count > 2, args[1] == "--sizes" {
    // The 1024 icon downsampled (as iOS does) to 180, 60 and 29 px, squircle-masked, on a dark and a light strip.
    let icon = render(1024), sizes: [CGFloat] = [180, 60, 29], pad: CGFloat = 24
    let w = sizes.reduce(pad) { $0 + $1 + pad }, h = (180 + 2 * pad) * 2
    let ctx = CGContext(data: nil, width: Int(w), height: Int(h), bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.interpolationQuality = .high
    for (row, bg) in [(0, (0.039, 0.039, 0.039)), (1, (0.96, 0.96, 0.97))] {
        let y0 = CGFloat(row) * (180 + 2 * pad)
        ctx.setFillColor(color(bg)); ctx.fill(CGRect(x: 0, y: y0, width: w, height: 180 + 2 * pad))
        var x = pad
        for s in sizes {
            let r = CGRect(x: x, y: y0 + pad + (180 - s) / 2, width: s, height: s)
            ctx.saveGState()
            ctx.addPath(CGPath(roundedRect: r, cornerWidth: s * 0.225, cornerHeight: s * 0.225, transform: nil)); ctx.clip()
            ctx.draw(icon, in: r)
            ctx.restoreGState()
            x += s + pad
        }
    }
    write(ctx.makeImage()!, args[2])
} else {
    write(render(args.count > 2 ? Int(args[2])! : 1024), args.count > 1 ? args[1] : "icon-1024.png")
}
