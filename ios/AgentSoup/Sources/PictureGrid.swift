// Several pictures in one message (the web's multipart upload): picking several in Photos or pasting several sends
// ONE message. In the chat its pictures sit in a grid (2 side by side; 3 as one big and two small; 4 as 2×2; 5 or more
// as 2×2 with "+N" on the last), any other files as chips under it; tapping a picture opens a full-screen viewer you
// swipe through that message's pictures. A message with one file is unchanged (ChatImage / FileChip).

import SwiftUI

/// One file of a message, as the server lists it (`attachments`), or as it's sending from this phone (`local`).
struct FileRef: Codable, Hashable {
    let name: String
    let mime: String
    var size: Int? = nil
    var version: Int? = nil
    var w: Int? = nil
    var h: Int? = nil
    var local: String? = nil // sending from this phone: its bytes on disk

    var isImage: Bool { mime.hasPrefix("image/") }

    /// As a single-file entry of `e`, so it loads, previews and opens like one (MediaStore, FileChip).
    func entry(of e: Entry) -> Entry {
        Entry(seq: e.seq, ts: e.ts, author: e.author, type: "artifact", text: "", title: nil, to: nil, via: e.via, artifactName: name,
              pending: e.pending, failed: e.failed, media: mime.hasPrefix("text/") ? nil : Media(mime: mime, w: w, h: h, size: size),
              artifactVersion: version, artifactSize: size, local: local)
    }
}

extension Entry {
    /// A message with several files (2–10).
    var isMultiFile: Bool { (attachments?.count ?? 0) > 1 }
}

/// A message's pictures as a grid, its other files as chips under it.
struct MultiAttachment: View {
    let e: Entry
    let board: String
    var progress: Double? = nil
    @State private var open: GalleryStart?

    var body: some View {
        let all = e.attachments ?? []
        let pictures = all.filter(\.isImage)
        let files = all.filter { !$0.isImage }
        VStack(alignment: .leading, spacing: Space.xs) {
            if !pictures.isEmpty {
                PictureGrid(e: e, board: board, pictures: pictures, progress: progress) { i in
                    guard e.pending != true else { return }
                    Haptic.tap()
                    open = GalleryStart(index: i)
                }
            }
            ForEach(Array(files.enumerated()), id: \.offset) { _, f in
                FileChip(e: f.entry(of: e), board: board, progress: pictures.isEmpty ? progress : nil)
            }
        }
        .fullScreenCover(item: $open) { s in GalleryViewer(e: e, board: board, pictures: pictures, start: s.index) }
    }
}

struct GalleryStart: Identifiable { let index: Int; var id: Int { index } }

/// 2 side by side, 3 as one big and two small, 4 as 2×2, 5+ as 2×2 with "+N" on the fourth.
struct PictureGrid: View {
    let e: Entry
    let board: String
    let pictures: [FileRef]
    var progress: Double? = nil
    let tap: (Int) -> Void

    static let width: CGFloat = 240
    static let gap: CGFloat = 2

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
        let w = Self.width, g = Self.gap
        Group {
            switch pictures.count {
            case 1:
                tile(0, width: w, height: w * 0.75)
            case 2:
                HStack(spacing: g) { tile(0, width: (w - g) / 2, height: 168); tile(1, width: (w - g) / 2, height: 168) }
            case 3:
                HStack(spacing: g) {
                    tile(0, width: (w - g) * 0.62, height: 208)
                    VStack(spacing: g) { tile(1, width: (w - g) * 0.38, height: (208 - g) / 2); tile(2, width: (w - g) * 0.38, height: (208 - g) / 2) }
                }
            default:
                let side = (w - g) / 2
                VStack(spacing: g) {
                    HStack(spacing: g) { tile(0, width: side, height: side); tile(1, width: side, height: side) }
                    HStack(spacing: g) { tile(2, width: side, height: side); tile(3, width: side, height: side, more: pictures.count - 4) }
                }
            }
        }
        .overlay {
            if e.pending == true {
                ZStack { Color.black.opacity(0.35); UploadRing(progress: progress ?? 0) }
            }
        }
        .clipShape(shape)
        .contentShape(shape)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(pictures.count) pictures")
        .accessibilityValue(e.pending == true ? "sending" : e.failed == true ? "not sent" : "shown")
        .accessibilityIdentifier("picture-grid")
    }

    private func tile(_ i: Int, width: CGFloat, height: CGFloat, more: Int = 0) -> some View {
        GridTile(ref: pictures[i], e: e, board: board)
            .frame(width: width, height: height)
            .clipped()
            .overlay {
                if more > 0 {
                    ZStack {
                        Color.black.opacity(0.45)
                        Text("+\(more)").font(.title2.weight(.semibold)).foregroundStyle(.white)
                    }
                    .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { tap(i) }
            .accessibilityElement()
            .accessibilityLabel(pictures[i].name + (more > 0 ? ", and \(more) more" : ""))
            .accessibilityAddTraits([.isImage, .isButton])
            .accessibilityIdentifier("grid-picture-\(i)")
    }
}

/// One picture in a grid: loads once (from this phone while sending, else the cache or the server).
private struct GridTile: View {
    let ref: FileRef
    let e: Entry
    let board: String
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Theme.card
            if let image { Image(uiImage: image).resizable().scaledToFill().transition(.opacity) }
        }
        .task(id: "\(ref.name)/\(ref.version ?? 0)/\(ref.local ?? "")") { await load() }
    }

    private func load() async {
        if let local = ref.local {
            let i = await Task.detached { (try? Data(contentsOf: URL(fileURLWithPath: local))).flatMap { Attachments.thumbnail($0, max: 480) } }.value
            withAnimation(.smooth(duration: 0.2)) { image = i }
            return
        }
        if let i = MediaStore.shared.cached(board: board, name: ref.name, version: ref.version) { image = i; return }
        if let i = try? await MediaStore.shared.thumbnail(board: board, name: ref.name, version: ref.version) {
            withAnimation(.smooth(duration: 0.2)) { image = i }
        }
    }
}

/// A message's pictures, full screen: swipe between them, pinch or double-tap to zoom, share the one showing, swipe
/// down or ✕ to close. "2 of 5" at the top.
struct GalleryViewer: View {
    let e: Entry
    let board: String
    let pictures: [FileRef]
    @State var index: Int
    @Environment(\.dismiss) private var dismiss
    @State private var files: [Int: URL] = [:]
    @State private var drag: CGFloat = 0

    init(e: Entry, board: String, pictures: [FileRef], start: Int) {
        self.e = e; self.board = board; self.pictures = pictures
        _index = State(initialValue: start)
    }

    var body: some View {
        ZStack {
            Color.black.opacity(1 - min(0.6, abs(drag) / 600)).ignoresSafeArea()
            TabView(selection: $index) {
                ForEach(Array(pictures.enumerated()), id: \.offset) { i, p in
                    GalleryPage(ref: p, e: e, board: board, loaded: { files[i] = $0 }, dragged: { drag = $0 }, released: { dy in
                        if abs(dy) > 120 { dismiss() } else { withAnimation(.spring(duration: 0.3)) { drag = 0 } }
                    })
                    .tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .offset(y: drag)
            .ignoresSafeArea()
            .accessibilityIdentifier("gallery")
        }
        .overlay(alignment: .top) {
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 36, height: 36).background(Color.white.opacity(0.14), in: Circle())
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .accessibilityLabel("Close")
                Spacer()
                Text("\(index + 1) of \(pictures.count)").font(Typo.meta.weight(.semibold)).foregroundStyle(.white).monospacedDigit()
                    .accessibilityIdentifier("gallery-position")
                Spacer()
                if let file = files[index] {
                    ShareLink(item: file) {
                        Image(systemName: "square.and.arrow.up").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                            .frame(width: 36, height: 36).background(Color.white.opacity(0.14), in: Circle())
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .accessibilityLabel("Share")
                } else {
                    Color.clear.frame(width: 44, height: 44)
                }
            }
            .buttonStyle(PressStyle())
            .padding(.horizontal, Space.s)
            .opacity(drag == 0 ? 1 : 0)
        }
        .statusBarHidden()
    }
}

/// One page of the viewer: the picture at full size, zoomable.
private struct GalleryPage: View {
    let ref: FileRef
    let e: Entry
    let board: String
    let loaded: (URL) -> Void
    let dragged: (CGFloat) -> Void
    let released: (CGFloat) -> Void
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                ZoomableImage(image: image, dragged: dragged, released: released)
                    .accessibilityLabel(ref.name)
                    .accessibilityIdentifier("gallery-page")
            } else {
                ProgressView().tint(.white)
            }
        }
        .task {
            if let u = try? await MediaStore.shared.file(for: ref.entry(of: e), board: board), let d = try? Data(contentsOf: u) {
                loaded(u)
                image = await Task.detached { UIImage(data: d)?.preparingForDisplay() ?? UIImage(data: d) }.value
            }
        }
    }
}
