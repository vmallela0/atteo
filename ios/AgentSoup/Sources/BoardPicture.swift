// A board's picture (like a group chat's photo): a rounded square wherever the board's tile goes, its initial until
// someone sets one, and for a DM the other person's own picture. Pictures are members-only, so they load through the
// signed-in client (AsyncImage sends no token), kept in memory and on disk by their versioned address ("?v=" changes
// whenever the picture does, so a version is fetched once).

import SwiftUI
import UIKit

/// The pictures this phone has, by their full address, plus the ones changing right now.
@MainActor
final class BoardPictureStore: ObservableObject {
    static let shared = BoardPictureStore()
    @Published private(set) var images: [String: UIImage] = [:]
    /// Board id → the picture it's changing to (nil: removed), until the server says so. A refresh that lands in
    /// between (the change's own "📷 changed the board picture" line triggers one) keeps showing this.
    var pending: [String: String?] = [:]
    private var loading: [String: Task<UIImage?, Never>] = [:]
    private nonisolated static let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("board-pictures", isDirectory: true)
    private nonisolated static let keepOnDisk = 120

    /// A picture, from memory, then disk, then the server (as you). Nil if it can't be had (the initial stays).
    @discardableResult
    func load(_ url: String) async -> UIImage? {
        if let i = images[url] { return i }
        guard url.hasPrefix("/") else { return nil } // a stand-in from before a relaunch: the next refresh replaces it
        if let t = loading[url] { return await t.value }
        let t = Task<UIImage?, Never> {
            let file = Self.file(for: url)
            if let i = await Task.detached(operation: { (try? Data(contentsOf: file)).flatMap(Self.decode) }).value { return i }
            guard let d = try? await API.shared.download(url) else { return nil }
            return await Task.detached(operation: {
                guard let i = Self.decode(d) else { return nil }
                Self.keep(d, for: url)
                return i
            }).value
        }
        loading[url] = t
        let i = await t.value
        loading[url] = nil
        if let i { show(i, at: url) }
        return i
    }

    /// Bytes this phone just sent, kept under the address the server gave them (no download).
    func adopt(_ d: Data, at url: String) {
        guard let i = Self.decode(d) else { return }
        show(i, at: url)
        Task.detached { Self.keep(d, for: url) }
    }

    /// A picture shown before the server has it: a stand-in address, in memory only.
    func standIn(_ d: Data) -> String? {
        guard let i = Self.decode(d) else { return nil }
        let key = "local:\(UUID().uuidString)"
        images[key] = i
        return key
    }

    /// The board as it should show while its picture is changing.
    func applyPending(_ b: Board) -> Board {
        guard let p = pending[b.id] else { return b }
        var b = b
        b.picture = p
        return b
    }

    /// What a board's tile shows right now: "person" (a DM), "picture" (loaded), or "initial". For tests and VoiceOver.
    func look(of b: Board) -> String {
        if b.kind == "direct" { return "person" }
        return b.picture.flatMap { images[$0] } != nil ? "picture" : "initial"
    }

    private func show(_ i: UIImage, at url: String) {
        // One version per board in memory: an older one goes when a newer arrives.
        let board = Self.boardId(url)
        withAnimation(.smooth(duration: 0.2)) {
            if let board { for k in images.keys where k != url && Self.boardId(k) == board { images[k] = nil } }
            images[url] = i
        }
    }

    // MARK: Disk

    private nonisolated static func boardId(_ url: String) -> String? {
        guard url.hasPrefix("/"), let c = URLComponents(string: url) else { return nil }
        return c.path.split(separator: "/").last.map(String.init)
    }

    private nonisolated static func file(for url: String) -> URL {
        let c = URLComponents(string: url)
        let id = boardId(url) ?? "x"
        let v = c?.queryItems?.first { $0.name == "v" }?.value ?? "0"
        let safe = { (s: String) in String(s.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || $0 == "_" ? Character($0) : "-" }) }
        return root.appendingPathComponent("\(safe(id))@\(safe(v))")
    }

    private nonisolated static func decode(_ d: Data) -> UIImage? {
        guard let i = UIImage(data: d) else { return nil }
        return i.preparingForDisplay() ?? i
    }

    /// Writes a version and drops the board's older ones; keeps the folder small (oldest go first).
    private nonisolated static func keep(_ d: Data, for url: String) {
        let fm = FileManager.default
        try? fm.createDirectory(at: root, withIntermediateDirectories: true)
        let target = file(for: url)
        try? d.write(to: target, options: .atomic)
        let prefix = target.lastPathComponent.components(separatedBy: "@")[0] + "@"
        let all = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        for f in all where f.lastPathComponent.hasPrefix(prefix) && f.lastPathComponent != target.lastPathComponent { try? fm.removeItem(at: f) }
        if all.count > keepOnDisk {
            let dated = all.map { ($0, (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
            for (f, _) in dated.sorted(by: { $0.1 < $1.1 }).prefix(all.count - keepOnDisk) where f != target { try? fm.removeItem(at: f) }
        }
    }
}

/// A board's picture as a rounded square (its initial until it has one); a DM shows the other person's picture.
/// Follows the board as it is now, so a change shows everywhere at once.
struct BoardPicture: View {
    @EnvironmentObject private var state: AppState
    @ObservedObject private var store = BoardPictureStore.shared
    let board: Board
    var size: CGFloat = 40

    init(board: Board, size: CGFloat = 40) { self.board = board; self.size = size }

    private var live: Board { state.boards.first { $0.id == board.id } ?? board }

    var body: some View {
        let b = live
        if b.kind == "direct" {
            Avatar(name: b.displayName(me: state.me?.owner), size: size)
        } else if b.isAgentChat {
            Avatar(name: state.me?.owner ?? "", agent: true, size: size) // "Your agent": your agent's picture
        } else {
            BoardTile(title: b.title, size: size)
                .overlay {
                    if let img = b.picture.flatMap({ store.images[$0] }) {
                        Image(uiImage: img).resizable().scaledToFill()
                            .frame(width: size, height: size)
                            .clipShape(RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
                            .transition(.opacity)
                    }
                }
                .task(id: b.picture) { if let u = b.picture { await store.load(u) } }
        }
    }
}

extension AppState {
    /// Sets the board's picture (a small square JPEG) or removes it (nil). The list changes at once and goes back if
    /// the server says no. Returns what went wrong, in the server's words, or nil.
    func setBoardPicture(_ boardId: String, jpeg: Data?) async -> String? {
        let store = BoardPictureStore.shared
        let old = boards.first { $0.id == boardId }?.picture
        let next: String? = jpeg.flatMap { store.standIn($0) }
        if jpeg != nil && next == nil { return "That picture couldn't be read." }
        store.pending[boardId] = .some(next)
        showPicture(boardId, next)
        let path = "/api/boards/\(boardId)/picture"
        do {
            let d: Data
            if let jpeg { d = try await API.shared.upload(path, data: jpeg, contentType: "image/jpeg") } else { d = try await API.shared.send(path, method: "DELETE", body: nil, retries: false) }
            struct Changed: Decodable { let picture: String? }
            let url = (try? JSONDecoder.soup.decode(Changed.self, from: d))?.picture
            if let url, let jpeg { store.adopt(jpeg, at: url) }
            store.pending[boardId] = nil
            showPicture(boardId, url)
            Haptics.play(.completed)
            Task { await refreshBoards() } // keeps it on this phone for next launch
            return nil
        } catch {
            store.pending[boardId] = nil
            showPicture(boardId, old)
            Haptics.play(.failed)
            if case APIError.signedOut = error { report(error) }
            return error.localizedDescription
        }
    }

    private func showPicture(_ boardId: String, _ picture: String?) {
        guard let i = boards.firstIndex(where: { $0.id == boardId }) else { return }
        withAnimation(.smooth) { boards[i].picture = picture }
    }
}
