import Foundation
import Combine
import SwiftUI

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
        if text == self.text(for: board, root: root) { return } // nothing new: Chats needn't redraw its rows
        if board.encrypted == true {
            defaults.removeObject(forKey: k)
            if text.isEmpty { encrypted.removeValue(forKey: k) } else { encrypted[k] = text }
        } else {
            if text.isEmpty { defaults.removeObject(forKey: k) } else { defaults.set(text, forKey: k) }
        }
        revision &+= 1
    }

    func clear(for board: Board, root: Int? = nil) { save("", for: board, root: root) }

    /// Every draft on this device (a fresh start: signing out, or a UI test's clean launch).
    func clearAll() {
        for k in defaults.dictionaryRepresentation().keys where k.hasPrefix("message-draft.") { defaults.removeObject(forKey: k) }
        encrypted.removeAll()
        revision &+= 1
    }
}

/// What's being typed in a message box, kept out of the chat's own state (jxn #4181: the keyboard lagged in a long
/// chat). Only the box reads `text`, so a keystroke redraws the box, not the chat around it; and the draft is saved
/// once typing pauses, not on every key (each save also redrew every row of Chats, which shows drafts).
@Observable final class ComposerDraft {
    private(set) var text: String
    @ObservationIgnored private var board: Board?
    @ObservationIgnored private var root: Int?
    @ObservationIgnored private var saving: Task<Void, Never>?
    /// Called with the new text after every change (a thread's box mirrors its words into the chat's box).
    @ObservationIgnored var onChange: ((String) -> Void)?

    @ObservationIgnored private var leaving: NSObjectProtocol?

    /// A chat's box: its saved words back. Without a board it holds words but saves nothing until `attach`.
    init(board: Board? = nil, root: Int? = nil) {
        self.board = board
        self.root = root
        text = board.map { MessageDrafts.shared.text(for: $0, root: root) } ?? ""
        // Leaving the app mid-word: saved now, not after the pause (the app may not come back).
        leaving = NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.save() }
        }
    }

    deinit { if let leaving { NotificationCenter.default.removeObserver(leaving) } }

    /// A thread's box, once it's shown: where it saves, and what was saved there.
    func attach(_ board: Board, root: Int?) {
        self.board = board
        self.root = root
        text = MessageDrafts.shared.text(for: board, root: root)
    }

    /// The box's binding. Reading it in a view's body is what makes that view redraw as you type, so only the box does.
    var binding: Binding<String> { Binding(get: { self.text }, set: { self.set($0) }) }

    func set(_ new: String) {
        guard new != text else { return }
        text = new
        onChange?(new)
        save(later: true)
    }

    /// Saved once typing pauses, or now (leaving the chat). It captures the words, not self, so a pending save still
    /// lands after the chat closes.
    func save(later: Bool = false) {
        saving?.cancel()
        guard let board else { return }
        let words = text, root = root
        guard later else { MessageDrafts.shared.save(words, for: board, root: root); return }
        saving = Task { @MainActor in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            MessageDrafts.shared.save(words, for: board, root: root)
        }
    }
}
