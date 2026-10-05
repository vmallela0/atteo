import Foundation
import Combine

/// Text drafts on this device. Encrypted boards stay in process memory only.
final class MessageDrafts: ObservableObject {
    static let shared = MessageDrafts()
    @Published private(set) var revision = 0

    private let defaults: UserDefaults
    private var encrypted: [String: String] = [:]

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private func key(_ board: Board, root: Int?) -> String {
        "message-draft.\(board.id).\(root.map(String.init) ?? "board")"
    }

    func text(for board: Board, root: Int? = nil) -> String {
        let k = key(board, root: root)
        if board.encrypted == true {
            defaults.removeObject(forKey: k)
            return encrypted[k] ?? ""
        }
        return defaults.string(forKey: k) ?? ""
    }

    func save(_ text: String, for board: Board, root: Int? = nil) {
        let k = key(board, root: root)
        if board.encrypted == true {
            defaults.removeObject(forKey: k)
            if text.isEmpty { encrypted.removeValue(forKey: k) } else { encrypted[k] = text }
        } else {
            if text.isEmpty { defaults.removeObject(forKey: k) } else { defaults.set(text, forKey: k) }
        }
        revision &+= 1
    }

    func clear(for board: Board, root: Int? = nil) { save("", for: board, root: root) }
}
