// Crop and touch up a picture before it's saved (#1001, like the web's crop() in src/html.ts): a square with a
// circle (you) or rounded-square (an agent, a board) guide; drag to move, pinch or the slider to zoom, rotate a
// quarter turn, light and contrast; Cancel or Save. Saves a small square JPEG.

import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

/// A picked photo waiting to be cropped (what the editor sheet is for).
struct CropRequest: Identifiable {
    let id = UUID()
    let image: UIImage
}

extension UIImage {
    /// Upright (EXIF orientation applied) and at most `maxSide` on its longer side, so editing stays quick.
    func uprightAndSmall(maxSide: CGFloat = 2048) -> UIImage {
        let s = min(1, maxSide / max(size.width, size.height))
        let target = CGSize(width: (size.width * s).rounded(), height: (size.height * s).rounded())
        if imageOrientation == .up && s == 1 { return self }
        let f = UIGraphicsImageRendererFormat(); f.scale = 1
        return UIGraphicsImageRenderer(size: target, format: f).image { _ in draw(in: CGRect(origin: .zero, size: target)) }
    }
}

struct PictureEditor: View {
    let image: UIImage
    var round = true // you: a circle; an agent or a board: a rounded square
    var side: CGFloat = 320 // pixels saved
    let done: (Data?) -> Void // the JPEG, or nil (cancelled)

    @State private var zoom: CGFloat = 1
    @State private var pinchFrom: CGFloat?
    @State private var offset: CGSize = .zero
    @State private var dragFrom: CGSize?
    @State private var turns = 0 // quarter turns clockwise
    @State private var light: Double = 0 // -0.3…0.3 (added)
    @State private var contrast: Double = 1 // 0.6…1.4 (multiplied)
    @State private var saving = false

    private let view: CGFloat = 280 // the square on screen

    /// The picture's size as turned.
    private var dims: CGSize { turns % 2 == 1 ? CGSize(width: image.size.height, height: image.size.width) : image.size }
    /// Points on screen per pixel of the picture, at this zoom (it always covers the square).
    private var scale: CGFloat { view / max(1, min(dims.width, dims.height)) * zoom }

    private func clamped(_ o: CGSize, zoom z: CGFloat? = nil) -> CGSize {
        let k = view / max(1, min(dims.width, dims.height)) * (z ?? zoom)
        let mx = max(0, (dims.width * k - view) / 2), my = max(0, (dims.height * k - view) / 2)
        return CGSize(width: min(mx, max(-mx, o.width)), height: min(my, max(-my, o.height)))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: Space.l) {
                Spacer(minLength: 0)
                ZStack {
                    Image(uiImage: image).resizable()
                        .frame(width: image.size.width * scale, height: image.size.height * scale)
                        .rotationEffect(.degrees(Double(turns) * 90))
                        .offset(offset)
                        .brightness(light).contrast(contrast)
                    // What's kept: inside the guide; the rest is dimmed.
                    Canvas { ctx, size in
                        var p = Path(CGRect(origin: .zero, size: size))
                        let r = CGRect(origin: .zero, size: size).insetBy(dx: 2, dy: 2)
                        p.addPath(round ? Path(ellipseIn: r) : Path(roundedRect: r, cornerRadius: size.width * 0.3, style: .continuous))
                        ctx.fill(p, with: .color(.black.opacity(0.5)), style: FillStyle(eoFill: true))
                    }
                    .allowsHitTesting(false)
                }
                .frame(width: view, height: view)
                .clipped()
                .contentShape(Rectangle())
                .gesture(
                    DragGesture()
                        .onChanged { g in
                            let from = dragFrom ?? offset
                            dragFrom = from
                            offset = clamped(CGSize(width: from.width + g.translation.width, height: from.height + g.translation.height))
                        }
                        .onEnded { _ in dragFrom = nil }
                        .simultaneously(with: MagnifyGesture()
                            .onChanged { g in
                                let from = pinchFrom ?? zoom
                                pinchFrom = from
                                zoom = min(4, max(1, from * g.magnification))
                                offset = clamped(offset)
                            }
                            .onEnded { _ in pinchFrom = nil })
                )
                .accessibilityElement()
                .accessibilityLabel("The picture: drag to move it, pinch to zoom")
                .accessibilityIdentifier("crop-canvas")

                VStack(spacing: Space.m) {
                    HStack(spacing: Space.m) {
                        row("Zoom") { Slider(value: Binding(get: { zoom }, set: { zoom = $0; offset = clamped(offset) }), in: 1...4).accessibilityIdentifier("crop-zoom") }
                        Button { withAnimation(.smooth(duration: 0.2)) { turns = (turns + 1) % 4; offset = .zero } } label: {
                            Image(systemName: "rotate.right").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.text)
                                .frame(width: 36, height: 36).background(Theme.raised, in: Circle())
                        }
                        .buttonStyle(PressStyle())
                        .accessibilityLabel("Rotate")
                        .accessibilityIdentifier("crop-rotate")
                    }
                    row("Light") { Slider(value: $light, in: -0.3...0.3).accessibilityIdentifier("crop-light") }
                    row("Contrast") { Slider(value: $contrast, in: 0.6...1.4).accessibilityIdentifier("crop-contrast") }
                }
                .tint(Theme.accent)
                .padding(.horizontal, Space.l)
                Spacer(minLength: 0)
            }
            .background(Theme.bg)
            .navigationTitle("Move and scale")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { done(nil) }.toolbarText().accessibilityIdentifier("crop-cancel") }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { save() } label: { if saving { ProgressView() } else { Text("Save") } }
                        .toolbarText(primary: true).disabled(saving).accessibilityIdentifier("crop-save")
                }
            }
        }
        .interactiveDismissDisabled()
    }

    private func row(_ title: String, @ViewBuilder _ control: () -> some View) -> some View {
        HStack(spacing: Space.m) {
            Text(title).font(Typo.meta).foregroundStyle(Theme.muted).frame(width: 64, alignment: .leading)
            control()
        }
    }

    /// The square as framed, `side` pixels, with light and contrast, as JPEG.
    private func save() {
        saving = true
        let (img, s, o, k, t, b, c) = (image, side, offset, scale, turns, light, contrast)
        let v = view
        Task.detached(priority: .userInitiated) {
            let f = s / v
            let fmt = UIGraphicsImageRendererFormat(); fmt.scale = 1; fmt.opaque = true
            let cropped = UIGraphicsImageRenderer(size: CGSize(width: s, height: s), format: fmt).image { r in
                UIColor.black.setFill(); r.fill(CGRect(x: 0, y: 0, width: s, height: s))
                let g = r.cgContext
                g.translateBy(x: s / 2 + o.width * f, y: s / 2 + o.height * f)
                g.rotate(by: CGFloat(t) * .pi / 2)
                g.scaleBy(x: k * f, y: k * f)
                img.draw(in: CGRect(x: -img.size.width / 2, y: -img.size.height / 2, width: img.size.width, height: img.size.height))
            }
            let out = Self.adjusted(cropped, light: b, contrast: c) ?? cropped
            let data = out.jpegData(compressionQuality: 0.85)
            await MainActor.run { done(data) }
        }
    }

    /// Light and contrast, as Core Image's color controls (the same as the preview's).
    nonisolated static func adjusted(_ img: UIImage, light: Double, contrast: Double) -> UIImage? {
        guard light != 0 || contrast != 1, let ci = CIImage(image: img) else { return nil }
        let f = CIFilter.colorControls()
        f.inputImage = ci
        f.brightness = Float(light)
        f.contrast = Float(contrast)
        f.saturation = 1
        guard let out = f.outputImage, let cg = CIContext().createCGImage(out, from: ci.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
