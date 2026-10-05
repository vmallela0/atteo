// Pictures and files, both ways. Sending: what you pick (Photos, the camera, Files) is made to fit the server's limit
// (pictures scaled to 2048 px and re-encoded as JPEG until they're under 1.5 MB), waits as a chip in the message box,
// and goes up through the same endpoint the web composer uses (/api/boards/:id/upload). Reading: pictures show inline
// (tap for full screen: pinch to zoom, share), other files as a compact chip (tap for Quick Look). Everything that
// comes down is cached on disk, keyed by its version, so a picture loads once.

import ImageIO
import PhotosUI
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// The server's limit for any stored file (src/board.ts MAX_IMAGE).
let maxUpload = 1_500_000

/// Something picked, ready to send: its bytes already fit.
struct Attachment: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let data: Data
    let mime: String
    var width: Int? = nil // pictures: pixel size, as shown
    var height: Int? = nil
    var preview: UIImage? = nil // a small copy for the chip
    var isImage: Bool { mime.hasPrefix("image/") }
}

enum AttachError: LocalizedError {
    case tooLarge(String), unreadable(String)
    var errorDescription: String? {
        switch self {
        case .tooLarge(let n): return String(localized: "\(n) is too large (max 1.5 MB).", bundle: .l10n)
        case .unreadable(let n): return String(localized: "Couldn't read \(n).", bundle: .l10n)
        }
    }
}

enum Attachments {
    /// The server's cleanFileName, so the name shown while sending is the one it keeps.
    static func clean(_ raw: String) -> String {
        var n = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        n = n.replacingOccurrences(of: "[^A-Za-z0-9 ._\\-/]", with: "-", options: .regularExpression)
        n = n.replacingOccurrences(of: "\\.{2,}", with: ".", options: .regularExpression)
        n = n.replacingOccurrences(of: "/{2,}", with: "/", options: .regularExpression)
        n = n.replacingOccurrences(of: "^[^A-Za-z0-9]+", with: "", options: .regularExpression)
        n = String(n.prefix(80)).trimmingCharacters(in: .whitespaces)
        return n.isEmpty ? "file" : n
    }

    /// Like the web's pasted pictures: "image-2026-10-02-153012.jpg", "-2", "-3" for more in the same second, so each
    /// is its own file rather than the next version of the last one.
    @MainActor private static var lastStamp = "", sameSecond = 0
    @MainActor static func pictureName(ext: String) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd-HHmmss"
        let stamp = "image-" + f.string(from: Date())
        sameSecond = stamp == lastStamp ? sameSecond + 1 : 1
        lastStamp = stamp
        return (sameSecond > 1 ? "\(stamp)-\(sameSecond)" : stamp) + "." + ext
    }

    /// PNG, JPEG, GIF or WebP by their first bytes (what the server shows inline), else nil.
    static func sniff(_ d: Data) -> String? {
        let b = [UInt8](d.prefix(12))
        if b.count >= 8, b[0...7] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] { return "image/png" }
        if b.count >= 3, b[0...2] == [0xFF, 0xD8, 0xFF] { return "image/jpeg" }
        if b.count >= 6, b[0...3] == [0x47, 0x49, 0x46, 0x38] { return "image/gif" }
        if b.count >= 12, b[0...3] == [0x52, 0x49, 0x46, 0x46], b[8...11] == [0x57, 0x45, 0x42, 0x50] { return "image/webp" }
        return nil
    }

    /// A picture's bytes made to fit: PNG/JPEG already small enough (and upright) and GIFs (animation) go as they are;
    /// anything else (HEIC from the camera roll, huge PNGs) is scaled to 2048 px and re-encoded as JPEG, stepping the
    /// quality, then the size, down until it's under the limit.
    static func picture(_ data: Data, name: String?) async throws -> Attachment {
        try await Task.detached(priority: .userInitiated) { () throws -> Attachment in
            let label = name ?? String(localized: "That picture", bundle: .l10n)
            guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { throw AttachError.unreadable(label) }
            let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] ?? [:]
            let pw = props[kCGImagePropertyPixelWidth] as? Int ?? 0, ph = props[kCGImagePropertyPixelHeight] as? Int ?? 0
            let upright = (props[kCGImagePropertyOrientation] as? Int ?? 1) == 1
            let kind = sniff(data)
            let preview = thumbnail(src, max: 240)
            func named(_ ext: String) async -> String {
                if let name { return clean((name as NSString).deletingPathExtension) + "." + ext }
                return await pictureName(ext: ext)
            }
            if data.count <= maxUpload, kind == "image/gif" || ((kind == "image/png" || kind == "image/jpeg") && upright && max(pw, ph) <= 2048) {
                let ext = kind == "image/gif" ? "gif" : kind == "image/png" ? "png" : "jpg"
                return Attachment(name: await named(ext), data: data, mime: kind!, width: pw, height: ph, preview: preview)
            }
            for side in [2048, 1600, 1280, 1024] {
                guard let cg = thumbnailCG(src, max: side) else { throw AttachError.unreadable(label) }
                for q in [0.82, 0.7, 0.58] {
                    if let jpeg = UIImage(cgImage: cg).jpegData(compressionQuality: q), jpeg.count <= maxUpload {
                        return Attachment(name: await named("jpg"), data: jpeg, mime: "image/jpeg", width: cg.width, height: cg.height, preview: preview)
                    }
                }
            }
            throw AttachError.tooLarge(label)
        }.value
    }

    /// A photo from the camera.
    static func photo(_ image: UIImage) async throws -> Attachment {
        guard let jpeg = image.jpegData(compressionQuality: 0.95) else { throw AttachError.unreadable(String(localized: "That photo", bundle: .l10n)) }
        return try await picture(jpeg, name: nil)
    }

    /// A file from Files: pictures go through `picture` (so they show inline), anything else as it is if it fits.
    static func file(_ url: URL) async throws -> Attachment {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let name = url.lastPathComponent
        let type = UTType(filenameExtension: url.pathExtension)
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if !(type?.conforms(to: .image) ?? false), size > maxUpload { throw AttachError.tooLarge(name) }
        guard let data = try? Data(contentsOf: url) else { throw AttachError.unreadable(name) }
        if type?.conforms(to: .image) ?? false, let a = try? await picture(data, name: name) { return a }
        guard data.count <= maxUpload else { throw AttachError.tooLarge(name) }
        return Attachment(name: clean(name), data: data, mime: type?.preferredMIMEType ?? "application/octet-stream")
    }

    static func thumbnailCG(_ src: CGImageSource, max: Int) -> CGImage? {
        CGImageSourceCreateThumbnailAtIndex(src, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true, kCGImageSourceThumbnailMaxPixelSize: max,
        ] as CFDictionary)
    }
    static func thumbnail(_ src: CGImageSource, max: Int) -> UIImage? { thumbnailCG(src, max: max).map(UIImage.init(cgImage:)) }
    static func thumbnail(_ data: Data, max: Int) -> UIImage? {
        CGImageSourceCreateWithData(data as CFData, nil).flatMap { thumbnail($0, max: max) }
    }
}

// MARK: - The cache

/// Pictures and files from boards, on disk under Caches (a version never changes, so it's fetched once) and, for
/// pictures, a downsampled copy in memory for the chat.
final class MediaStore: @unchecked Sendable {
    static let shared = MediaStore()
    private let memory = NSCache<NSString, UIImage>()
    private let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("media", isDirectory: true)

    init() { memory.countLimit = 120 }

    /// Where a board's file lives on this phone (named as it's called, so Quick Look and Share show the right name).
    func url(board: String, name: String, version: Int?) -> URL {
        var file = name.replacingOccurrences(of: "/", with: "_")
        if (file as NSString).pathExtension.isEmpty { file += ".txt" } // a text file without an extension: Quick Look reads it as text
        return root.appendingPathComponent(board, isDirectory: true).appendingPathComponent("v\(version ?? 0)", isDirectory: true).appendingPathComponent(file)
    }

    func cached(board: String, name: String, version: Int?) -> UIImage? { memory.object(forKey: key(board, name, version)) }

    /// A file's bytes: from disk if this version is here already, else from the server (and kept).
    func data(board: String, name: String, version: Int?) async throws -> Data {
        let u = url(board: board, name: name, version: version)
        if version != nil, let d = try? Data(contentsOf: u) { return d }
        let path = "/api/boards/\(board)/image?name=\(name.queryEscaped)" + (version.map { "&version=\($0)" } ?? "")
        let d = try await API.shared.download(path)
        keep(d, at: u)
        return d
    }

    /// A picture sized for the chat.
    func thumbnail(board: String, name: String, version: Int?) async throws -> UIImage {
        if let i = cached(board: board, name: name, version: version) { return i }
        let d = try await data(board: board, name: name, version: version)
        guard let i = await Task.detached(operation: { Attachments.thumbnail(d, max: 720) }).value else { throw AttachError.unreadable(name) }
        memory.setObject(i, forKey: key(board, name, version))
        return i
    }

    /// A file on disk, for Quick Look: stored bytes (`media`), or a text file's content.
    func file(for e: Entry, board: String) async throws -> URL {
        if let local = e.local { return URL(fileURLWithPath: local) }
        guard let name = e.artifactName else { throw AttachError.unreadable(String(localized: "That file", bundle: .l10n)) }
        let u = url(board: board, name: name, version: e.artifactVersion)
        if e.artifactVersion != nil, FileManager.default.fileExists(atPath: u.path) { return u }
        if e.media != nil {
            _ = try await data(board: board, name: name, version: e.artifactVersion)
        } else {
            struct Doc: Decodable { let content: String }
            let doc = try await API.shared.get("/api/boards/\(board)/doc?name=\(name.queryEscaped)" + (e.artifactVersion.map { "&version=\($0)" } ?? ""), as: Doc.self)
            keep(Data(doc.content.utf8), at: u)
        }
        return u
    }

    /// What you just sent: kept under its real name and version, so it doesn't download again.
    func adopt(_ d: Data, board: String, name: String, version: Int?, image: Bool) {
        keep(d, at: url(board: board, name: name, version: version))
        if image, let i = Attachments.thumbnail(d, max: 720) { memory.setObject(i, forKey: key(board, name, version)) }
    }

    private func keep(_ d: Data, at u: URL) {
        try? FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? d.write(to: u, options: .atomic)
    }
    private func key(_ b: String, _ n: String, _ v: Int?) -> NSString { "\(b)/\(n)/\(v ?? 0)" as NSString }
}

extension String {
    var queryEscaped: String {
        var ok = CharacterSet.urlQueryAllowed
        ok.remove(charactersIn: "&=+?#")
        return addingPercentEncoding(withAllowedCharacters: ok) ?? self
    }
}

// MARK: - In the message box

/// What you've picked, as small chips above the text (✕ removes one); a spinner while one is still being prepared.
struct AttachmentTray: View {
    let items: [Attachment]
    let preparing: Int
    let remove: (Attachment) -> Void
    /// A picture tapped while you're still writing (jxn #2604): full screen over the chat; the draft, the other
    /// attachments and the keyboard are as they were when it closes.
    @State private var viewing: Attachment?
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.s) {
                ForEach(items) { a in
                    chip(a)
                        .overlay(alignment: .topTrailing) {
                            Button { remove(a) } label: {
                                Image(systemName: "xmark").font(.system(size: 8, weight: .bold)).foregroundStyle(Theme.text)
                                    .frame(width: 18, height: 18).background(Color.black.opacity(0.65), in: Circle())
                                    .frame(width: 30, height: 30).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .offset(x: 8, y: -8)
                            .accessibilityLabel("Remove \(a.name)")
                        }
                        .transition(.scale(scale: 0.8).combined(with: .opacity))
                }
                ForEach(0..<preparing, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.raised).frame(width: 56, height: 56)
                        .overlay(ProgressView().controlSize(.small).tint(Theme.muted))
                }
            }
            .padding(.horizontal, Space.m).padding(.top, Space.m).padding(.bottom, Space.xxs)
        }
        .scrollClipDisabled()
        .accessibilityIdentifier("attachments")
        .fullScreenCover(item: $viewing) { a in DraftPictureViewer(attachment: a) }
    }

    @ViewBuilder private func chip(_ a: Attachment) -> some View {
        if a.isImage, let p = a.preview {
            Button { Haptics.play(.touch); viewing = a } label: {
                Image(uiImage: p).resizable().scaledToFill().frame(width: 56, height: 56)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .buttonStyle(PressStyle())
            .accessibilityLabel(a.name).accessibilityHint(Text("Opens it full screen")).accessibilityIdentifier("attachment-chip")
        } else {
            HStack(spacing: Space.s) {
                FileIcon(name: a.name, size: 28)
                VStack(alignment: .leading, spacing: 1) {
                    Text(a.name).font(Typo.micro.weight(.medium)).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.middle)
                    Text(a.data.count.bytes).font(.caption2).foregroundStyle(Theme.faint)
                }
            }
            .padding(.leading, Space.s).padding(.trailing, Space.m)
            .frame(maxWidth: 170, minHeight: 56, maxHeight: 56, alignment: .leading)
            .background(Theme.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityElement(children: .combine).accessibilityIdentifier("attachment-chip")
        }
    }
}

/// A file's kind at a glance: a small tile with a symbol.
struct FileIcon: View {
    let name: String
    var size: CGFloat = 32
    var body: some View {
        let ext = (name as NSString).pathExtension.lowercased()
        let symbol = ext == "pdf" ? "doc.richtext.fill"
            : ["zip", "gz", "tgz", "tar", "rar", "7z"].contains(ext) ? "doc.zipper"
            : ["txt", "md", "log", "json", "csv", "yml", "yaml", "js", "ts", "swift", "py", "html", "css", "sql", "sh"].contains(ext) || ext.isEmpty ? "doc.text.fill"
            : "doc.fill"
        Image(systemName: symbol).font(.system(size: size * 0.45, weight: .medium)).foregroundStyle(Theme.muted)
            .frame(width: size, height: size).background(Theme.bg.opacity(0.5), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
    }
}

extension Int {
    /// "12 KB", "1.2 MB".
    var bytes: String { ByteCountFormatter.string(fromByteCount: Int64(self), countStyle: .file) }
}

// MARK: - In the chat

/// A picture in a message: rounded, sized from its dimensions before it loads (nothing jumps), a ring while it's
/// going up, tap for full screen.
struct ChatImage: View {
    let e: Entry
    let board: String
    var progress: Double? = nil
    @State private var image: UIImage?
    @State private var open = false

    private var sending: Bool { e.pending == true }
    private var size: CGSize {
        let maxW: CGFloat = 232, maxH: CGFloat = 300
        guard let w = e.media?.w, let h = e.media?.h, w > 0, h > 0 else { return CGSize(width: 200, height: 200) }
        let aspect = CGFloat(h) / CGFloat(w)
        var width = min(maxW, max(96, CGFloat(w)))
        var height = width * aspect
        if height > maxH { height = maxH; width = max(96, height / aspect) }
        return CGSize(width: min(width, maxW), height: max(64, height))
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
        Button { if image != nil, !sending { open = true } } label: {
            ZStack {
                shape.fill(Theme.card)
                if let image { Image(uiImage: image).resizable().scaledToFill().frame(width: size.width, height: size.height).transition(.opacity) }
                if sending {
                    Color.black.opacity(0.35)
                    UploadRing(progress: progress ?? 0)
                }
            }
            .frame(width: size.width, height: size.height)
            .clipShape(shape)
            .contentShape(shape)
        }
        .buttonStyle(PressStyle())
        .task(id: "\(e.seq)/\(e.artifactName ?? "")/\(e.artifactVersion ?? 0)") { await load() }
        .fullScreenCover(isPresented: $open) { ImageViewer(e: e, board: board) }
        .accessibilityElement()
        .accessibilityLabel(e.artifactName.map { Text(verbatim: $0) } ?? Text("Picture"))
        .accessibilityValue(sending ? Text("sending") : e.failed == true ? Text("not sent") : image == nil ? Text("loading") : e.local == nil ? Text("shown") : Text("on this phone"))
        .accessibilityAddTraits(.isImage)
        .accessibilityIdentifier("chat-image")
    }

    private func load() async {
        if let local = e.local {
            let i = await Task.detached { (try? Data(contentsOf: URL(fileURLWithPath: local))).flatMap { Attachments.thumbnail($0, max: 720) } }.value
            withAnimation(.smooth(duration: 0.2)) { image = i }
            return
        }
        guard let name = e.artifactName else { return }
        if let i = MediaStore.shared.cached(board: board, name: name, version: e.artifactVersion) { image = i; return }
        if let i = try? await MediaStore.shared.thumbnail(board: board, name: name, version: e.artifactVersion) {
            withAnimation(.smooth(duration: 0.2)) { image = i }
        }
    }
}

/// How far an upload has gone: a thin ring that fills.
struct UploadRing: View {
    let progress: Double
    var body: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.25), lineWidth: 2.5)
            Circle().trim(from: 0, to: max(0.04, progress)).stroke(Color.white, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.smooth(duration: 0.2), value: progress)
        }
        .frame(width: 28, height: 28)
        .accessibilityHidden(true)
    }
}

/// A file in a message: its kind, name and size; tap to look at it (Quick Look). An .html file also has Preview
/// beside it (HTMLPreview.swift), which runs the page in a sandbox.
struct FileChip: View {
    let e: Entry
    let board: String
    var progress: Double? = nil
    @State private var opening = false
    @State private var preview: URL?
    @State private var running: HTMLPreviewTarget?

    private var previewable: Bool { e.pending != true && e.failed != true && HTMLPreview.available(board: board, name: e.artifactName, stored: e.media != nil) }

    var body: some View {
        let name = e.artifactName ?? String(localized: "File", bundle: .l10n)
        let shape = RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
        HStack(spacing: Space.s) {
            Button(action: open) {
                HStack(spacing: 10) {
                    ZStack {
                        FileIcon(name: name, size: 32).opacity(opening || e.pending == true ? 0.4 : 1)
                        if e.pending == true { UploadRing(progress: progress ?? 0).scaleEffect(0.7) } else if opening { ProgressView().controlSize(.small).tint(Theme.muted) }
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(name).font(Typo.meta.weight(.medium)).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.middle)
                        Text(((e.media?.size ?? e.artifactSize) ?? 0).bytes + (e.artifactVersion.map { $0 > 1 ? " · v\($0)" : "" } ?? ""))
                            .font(Typo.micro).foregroundStyle(Theme.faint)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.leading, Space.s).padding(.trailing, previewable ? 0 : Space.m).padding(.vertical, Space.s)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressStyle())
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("chat-file")
            if previewable {
                PreviewButton { running = HTMLPreviewTarget(board: board, name: name, version: e.artifactVersion) }
                    .padding(.trailing, Space.s)
            }
        }
        .frame(maxWidth: previewable ? 300 : 260, alignment: .leading)
        .background(Theme.card, in: shape)
        .quickLookPreview($preview)
        .htmlPreview($running)
    }

    private func open() {
        guard !opening, e.pending != true else { return }
        opening = true
        Task {
            defer { opening = false }
            do { preview = try await MediaStore.shared.file(for: e, board: board) } catch { Haptics.play(.failed); AppState.shared.report(error) }
        }
    }
}

/// A picture, full screen: pinch or double-tap to zoom, share it, swipe down or ✕ to close.
struct ImageViewer: View {
    let e: Entry
    let board: String
    @Environment(\.dismiss) private var dismiss
    @State private var image: UIImage?
    @State private var file: URL?
    @State private var drag: CGFloat = 0

    var body: some View {
        ZStack {
            Color.black.opacity(1 - min(0.6, abs(drag) / 600)).ignoresSafeArea()
            if let image {
                ZoomableImage(image: image, dragged: { drag = $0 }, released: { dy in
                    if abs(dy) > 120 { dismiss() } else { withAnimation(.spring(duration: 0.3)) { drag = 0 } }
                })
                .offset(y: drag)
                .ignoresSafeArea()
                .accessibilityLabel(e.artifactName.map { Text(verbatim: $0) } ?? Text("Picture"))
                .accessibilityIdentifier("image-viewer")
            } else {
                ProgressView().tint(.white)
            }
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
                if let file {
                    ShareLink(item: file) {
                        Image(systemName: "square.and.arrow.up").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                            .frame(width: 36, height: 36).background(Color.white.opacity(0.14), in: Circle())
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .accessibilityLabel("Share")
                }
            }
            .buttonStyle(PressStyle())
            .padding(.horizontal, Space.s)
            .opacity(drag == 0 ? 1 : 0)
        }
        .statusBarHidden()
        .task {
            if let u = try? await MediaStore.shared.file(for: e, board: board), let d = try? Data(contentsOf: u) {
                file = u
                image = await Task.detached { UIImage(data: d)?.preparingForDisplay() ?? UIImage(data: d) }.value
            }
        }
    }
}

/// A picture waiting in the message box, full screen (jxn #2604): pinch or double-tap to zoom, swipe down or ✕ to
/// close. It's the picture as it will be sent (the full copy, not the chip's small one).
struct DraftPictureViewer: View {
    let attachment: Attachment
    @Environment(\.dismiss) private var dismiss
    @State private var drag: CGFloat = 0
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Color.black.opacity(1 - min(0.6, abs(drag) / 600)).ignoresSafeArea()
            if let image = image ?? attachment.preview {
                ZoomableImage(image: image, dragged: { drag = $0 }, released: { dy in
                    if abs(dy) > 120 { dismiss() } else { withAnimation(.spring(duration: 0.3)) { drag = 0 } }
                })
                .offset(y: drag)
                .ignoresSafeArea()
                .accessibilityLabel(attachment.name)
                .accessibilityIdentifier("draft-picture")
            }
        }
        .overlay(alignment: .topLeading) {
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 36, height: 36).background(Color.white.opacity(0.14), in: Circle())
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(PressStyle())
            .padding(.horizontal, Space.s)
            .opacity(drag == 0 ? 1 : 0)
            .accessibilityLabel("Close")
            .accessibilityIdentifier("draft-picture-close")
        }
        .statusBarHidden()
        .task {
            let d = attachment.data
            image = await Task.detached { UIImage(data: d)?.preparingForDisplay() ?? UIImage(data: d) }.value
        }
    }
}

/// UIScrollView's zoom (pinch, double-tap, the bounce), centered; a vertical drag at 1× reports so it can close.
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    var dragged: (CGFloat) -> Void = { _ in }
    var released: (CGFloat) -> Void = { _ in }

    func makeUIView(context: Context) -> UIScrollView {
        let s = UIScrollView()
        s.delegate = context.coordinator
        s.maximumZoomScale = 5
        s.showsVerticalScrollIndicator = false
        s.showsHorizontalScrollIndicator = false
        s.contentInsetAdjustmentBehavior = .never
        s.backgroundColor = .clear
        let v = UIImageView(image: image)
        v.contentMode = .scaleAspectFit
        v.isUserInteractionEnabled = true
        s.addSubview(v)
        context.coordinator.imageView = v
        let double = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        double.numberOfTapsRequired = 2
        s.addGestureRecognizer(double)
        let pan = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.pan(_:)))
        pan.delegate = context.coordinator
        s.addGestureRecognizer(pan)
        return s
    }

    func updateUIView(_ s: UIScrollView, context: Context) {
        context.coordinator.parent = self
        DispatchQueue.main.async { context.coordinator.layout(s) }
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UIScrollViewDelegate, UIGestureRecognizerDelegate {
        var parent: ZoomableImage
        weak var imageView: UIImageView?
        private var laidOutFor: CGSize = .zero
        init(parent: ZoomableImage) { self.parent = parent }

        func layout(_ s: UIScrollView) {
            guard let v = imageView, s.bounds.size != .zero, s.bounds.size != laidOutFor else { return }
            laidOutFor = s.bounds.size
            s.zoomScale = 1
            let img = v.image?.size ?? .zero
            let k = min(s.bounds.width / max(img.width, 1), s.bounds.height / max(img.height, 1))
            v.frame = CGRect(x: 0, y: 0, width: img.width * k, height: img.height * k)
            s.contentSize = v.frame.size
            center(s)
        }
        func center(_ s: UIScrollView) {
            guard let v = imageView else { return }
            let dx = max(0, (s.bounds.width - v.frame.width) / 2), dy = max(0, (s.bounds.height - v.frame.height) / 2)
            s.contentInset = UIEdgeInsets(top: dy, left: dx, bottom: dy, right: dx)
        }
        func viewForZooming(in _: UIScrollView) -> UIView? { imageView }
        func scrollViewDidZoom(_ s: UIScrollView) { center(s) }

        @objc func doubleTap(_ g: UITapGestureRecognizer) {
            guard let s = g.view as? UIScrollView, let v = imageView else { return }
            if s.zoomScale > 1.01 { s.setZoomScale(1, animated: true); return }
            let p = g.location(in: v), w = s.bounds.width / 2.5, h = s.bounds.height / 2.5
            s.zoom(to: CGRect(x: p.x - w / 2, y: p.y - h / 2, width: w, height: h), animated: true)
        }
        @objc func pan(_ g: UIPanGestureRecognizer) {
            let dy = g.translation(in: g.view).y
            switch g.state {
            case .changed: parent.dragged(dy)
            case .ended, .cancelled, .failed: parent.released(dy)
            default: break
            }
        }
        // Only a mostly-vertical drag at 1× closes; zoomed in, panning moves around the picture.
        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard let p = g as? UIPanGestureRecognizer, let s = p.view as? UIScrollView else { return true }
            let v = p.velocity(in: s)
            return s.zoomScale <= 1.01 && abs(v.y) > abs(v.x) * 1.3
        }
    }
}

/// The camera, for a photo to send.
struct CameraPicker: UIViewControllerRepresentable {
    let picked: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let c = UIImagePickerController()
        c.sourceType = .camera
        c.delegate = context.coordinator
        return c
    }
    func updateUIViewController(_: UIImagePickerController, context _: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ p: CameraPicker) { parent = p }
        func imagePickerController(_: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let i = info[.originalImage] as? UIImage { parent.picked(i) }
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_: UIImagePickerController) { parent.dismiss() }
    }
}
