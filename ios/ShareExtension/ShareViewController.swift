// Atteo in the share sheet (vedu #4110): a picture, file, link or text from any app goes to one of your boards or chats,
// with a note. It acts as you through the app's own sign-in: the app's token sits in the Keychain group both share
// (keychain-access-groups in Atteo.entitlements and AtteoShare.entitlements: the app's own application identifier, so
// tokens saved before the extension existed are readable too). What it sends is ShareCore's (ios/Shared).

import ImageIO
import Security
import SwiftUI
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let model = ShareModel(context: extensionContext)
        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        Task { await model.load() }
    }
}

/// The app's Keychain items (Auth.swift's Keychain: the same service and accounts).
enum ShareKeychain {
    private static let service = "com.agentsoup.app"
    static func string(_ account: String) -> String? {
        var out: AnyObject?
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                kSecAttrAccount as String: account, kSecReturnData as String: true]
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
}

@MainActor
final class ShareModel: ObservableObject {
    enum Phase: Equatable { case loading, signedOut, ready, sending, sent, failed(String) }
    @Published var phase: Phase = .loading
    @Published var boards: [ShareBoard] = []
    @Published var me: String?
    @Published var selected: String?
    @Published var query = ""
    @Published var note = ""
    @Published var payloads: [SharedPayload] = []
    @Published var previews: [UIImage] = []
    @Published var problem: String?

    private weak var context: NSExtensionContext?
    private let token = ShareKeychain.string("token")
    /// Production, or (debug builds) the server the app last ran against, which it leaves in the Keychain.
    private let base: URL = {
        #if DEBUG
        if let s = ShareKeychain.string("share-server"), let u = URL(string: s) { return u }
        #endif
        return URL(string: "https://agent-board.vedu-mallela.workers.dev")!
    }()

    init(context: NSExtensionContext?) { self.context = context }

    var shown: [ShareBoard] { ShareCore.filter(boards, query: query, me: me) }
    var canSend: Bool { selected != nil && phase == .ready && (!payloads.isEmpty || !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }

    func load() async {
        guard let token else { phase = .signedOut; return }
        async let items = readItems()
        do {
            let list = try await get("/api/me/boards", as: BoardList.self, token: token)
            boards = ShareCore.pickable(list.boards)
            me = list.user
        } catch ShareModelError.signedOut {
            phase = .signedOut; return
        } catch {
            problem = "Couldn't reach Atteo. Check your connection."
            #if DEBUG
            problem! += " (\(base.absoluteString): \(error))"
            #endif
        }
        let (p, pics, issue) = await items
        payloads = p
        previews = pics
        if let issue { problem = issue }
        phase = .ready
    }

    func send() {
        guard canSend, let board = selected, let token else { return }
        phase = .sending
        Task {
            do {
                let r = try ShareCore.request(board: board, payloads: payloads, note: note, base: base, token: token)
                let (data, resp) = try await URLSession.shared.data(for: r)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                guard (200..<300).contains(code) else {
                    if code == 401 { phase = .signedOut; return }
                    let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
                    phase = .failed(msg ?? "Something went wrong (\(code)).")
                    return
                }
                phase = .sent
                try? await Task.sleep(nanoseconds: 700_000_000)
                context?.completeRequest(returningItems: nil)
            } catch let e as ShareError {
                phase = .failed(e.errorDescription ?? "Couldn't send.")
            } catch {
                phase = .failed("Couldn't reach Atteo. Check your connection.")
            }
        }
    }

    func retry() { phase = .ready }
    func cancel() { context?.cancelRequest(withError: NSError(domain: "com.atteo.share", code: NSUserCancelledError)) }

    // MARK: reading what was shared

    private func readItems() async -> ([SharedPayload], [UIImage], String?) {
        let providers = (context?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        var out: [SharedPayload] = [], pics: [UIImage] = [], issue: String?
        for p in providers.prefix(ShareCore.maxFiles) {
            do {
                if let item = try await Self.read(p) {
                    out.append(item.payload)
                    if let pic = item.preview { pics.append(pic) }
                }
            } catch let e as ShareError {
                issue = e.errorDescription
            } catch {
                issue = "Couldn't read one of the items."
            }
        }
        if providers.count > ShareCore.maxFiles { issue = ShareError.tooMany(providers.count).errorDescription }
        return (out, pics, issue)
    }

    private static func read(_ p: NSItemProvider) async throws -> (payload: SharedPayload, preview: UIImage?)? {
        if p.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            let (data, name) = try await fileData(p, type: .image)
            guard let pic = ShareImage.fit(data) else { throw ShareError.tooLarge(name) }
            let base = ShareCore.cleanName((name as NSString).deletingPathExtension)
            return (.file(name: base + ".jpg", mime: "image/jpeg", data: pic.jpeg, width: pic.width, height: pic.height), pic.preview)
        }
        if p.hasItemConformingToTypeIdentifier(UTType.url.identifier), !p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            let u = try await p.loadItem(forTypeIdentifier: UTType.url.identifier)
            if let url = u as? URL { return (.text(url.absoluteString), nil) }
        }
        if p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier), !p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            let t = try await p.loadItem(forTypeIdentifier: UTType.plainText.identifier)
            if let s = t as? String { return (.text(s), nil) }
        }
        if p.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
            let (data, name) = try await fileData(p, type: .data)
            let clean = ShareCore.cleanName(name)
            guard data.count <= ShareCore.maxFile else { throw ShareError.tooLarge(clean) }
            let mime = UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            return (.file(name: clean, mime: mime, data: data, width: nil, height: nil), nil)
        }
        return nil
    }

    /// The item's bytes and a file name for it.
    private static func fileData(_ p: NSItemProvider, type: UTType) async throws -> (Data, String) {
        try await withCheckedThrowingContinuation { cont in
            _ = p.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                guard let url, let d = try? Data(contentsOf: url) else {
                    cont.resume(throwing: error ?? ShareError.nothing); return
                }
                cont.resume(returning: (d, p.suggestedName.map { $0 + "." + url.pathExtension } ?? url.lastPathComponent))
            }
        }
    }

    private func get<T: Decodable>(_ path: String, as: T.Type, token: String) async throws -> T {
        var r = URLRequest(url: URL(string: path, relativeTo: base)!)
        r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        r.setValue("Atteo-iOS-Share", forHTTPHeaderField: "user-agent")
        r.timeoutInterval = 20
        let (data, resp) = try await URLSession.shared.data(for: r)
        if (resp as? HTTPURLResponse)?.statusCode == 401 { throw ShareModelError.signedOut }
        return try ShareCore.decoder.decode(T.self, from: data)
    }
}

enum ShareModelError: Error { case signedOut }
/// GET /api/me/boards: your boards, and who you are (to name a chat with one person by the other).
struct BoardList: Decodable { var user: String? = nil; let boards: [ShareBoard] }

/// Pictures made to fit the server's limit, as the app does (Attachments.photo): at most 2048 px on the long side,
/// JPEG, quality stepped down until it's under 1.5 MB. Read through ImageIO so a huge photo is never fully decoded.
enum ShareImage {
    struct Fitted { let jpeg: Data; let width: Int; let height: Int; let preview: UIImage }
    static func fit(_ data: Data) -> Fitted? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                     kCGImageSourceThumbnailMaxPixelSize: 2048, kCGImageSourceShouldCacheImmediately: true]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let img = UIImage(cgImage: cg)
        for q in [0.85, 0.75, 0.6, 0.45, 0.3] as [CGFloat] {
            if let j = img.jpegData(compressionQuality: q), j.count <= ShareCore.maxFile {
                return Fitted(jpeg: j, width: cg.width, height: cg.height, preview: img)
            }
        }
        return nil
    }
}
