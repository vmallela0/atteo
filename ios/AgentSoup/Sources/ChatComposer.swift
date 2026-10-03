// The message box, one component for the chat and its threads (jxn #1094): who's typing, what "/" makes a message,
// who "@" can name, pictures and files waiting to go, the text (ComposerField) and send. The chat and a thread look
// and behave the same; a thread's box answers a message (`replyTo`).

import PhotosUI
import SwiftUI

struct ChatComposer: View {
    @EnvironmentObject var state: AppState
    let board: Board
    @Binding var draft: String
    @Binding var focused: Bool
    var placeholder: String
    /// The thread's box: what its messages answer (nil: the chat's box).
    var replyTo: Int? = nil
    /// "Your agent": one of your sessions (only the agent chat's box picks one).
    var toSession: Binding<String?>? = nil
    var identifier = "composer"
    var sendIdentifier = "send"
    var attachIdentifier = "attach"
    /// After a message went (the thread refreshes what the server has for it).
    var sent: (() async -> Void)? = nil

    // Pictures and files waiting in the message box (sent with the text, the way the web composer sends them).
    @State private var attachments: [Attachment] = []
    @State private var preparing = 0 // picked, still being made to fit
    @State private var picked: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var showEncryptedNote = false
    private let maxAttachments = 10

    private var me: String? { state.me?.owner }
    private var list: [Entry] { state.entries[board.id] ?? [] }

    private var canSend: Bool {
        guard preparing == 0 else { return false }
        if !attachments.isEmpty { return true }
        if let (_, rest) = SlashCommand.parse(draft, on: board) { return !rest.isEmpty } // "/task" alone: nothing to send yet
        return !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - "@"

    /// What "@" can name here: each member's agent and each member (you can hand work to your own agent, but you
    /// don't mention yourself), plus everyone's agents and everyone.
    private var mentionables: [Mentionable] {
        var people = state.members[board.id] ?? []
        for u in list.map(\.author) + (state.boardAgents[board.id] ?? []).map(\.user) where !people.contains(u) { people.append(u) }
        return people.flatMap { u in [Mentionable(handle: "\(u)'s agent", user: u, agent: true)] + (u == me ? [] : [Mentionable(handle: u, user: u, agent: false)]) }
            + [Mentionable(handle: "agents", user: nil, agent: true), Mentionable(handle: "humans", user: nil, agent: false)]
    }

    /// The "@word" being typed at the end of the message, if any.
    private var mentionQuery: String? {
        guard let at = draft.lastIndex(of: "@") else { return nil }
        if at > draft.startIndex, let before = draft[draft.index(before: at)...].first, !before.isWhitespace { return nil }
        let q = draft[draft.index(after: at)...]
        return q.contains(where: { $0.isWhitespace && $0 != " " }) || q.count > 32 || q.contains("  ") ? nil : String(q)
    }

    private var suggestions: [Mentionable] {
        guard focused, let q = mentionQuery?.lowercased() else { return [] }
        // "theo", "theo's", "theo's ag": match the handle as typed so far (and don't offer what's already complete).
        return Array(mentionables.filter { $0.handle.lowercased().hasPrefix(q) && $0.handle.lowercased() != q }.prefix(5))
    }

    private func insert(_ m: Mentionable) {
        guard let at = draft.lastIndex(of: "@") else { return }
        Haptic.tap()
        draft = String(draft[..<at]) + "@\(m.handle) "
    }

    // MARK: - The box

    /// One soft field on the page (no bar, no outline), + at its leading edge and send inside its trailing edge.
    /// Above it, when they apply: who's typing, what "/" makes it, and who "@" can name.
    var body: some View {
        VStack(spacing: 0) {
            TypingRow(board: board.id)
            if let toSession { AgentToPicker(to: toSession) }
            // "/": what a message can be besides a note (a task, a decision, a question).
            if attachments.isEmpty {
                let fits = SlashCommand.suggestions(draft, on: board)
                if !fits.isEmpty { SlashChips(commands: fits) { c in Haptic.tap(); draft = c.word + " " } }
                else if let (c, _) = SlashCommand.parse(draft, on: board) { SlashChips(commands: [c], active: c) { _ in } }
            }
            if !suggestions.isEmpty {
                MentionList(items: suggestions, pick: insert)
                    .padding(.horizontal, Space.m).padding(.bottom, Space.xs)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            VStack(spacing: 0) {
                if !attachments.isEmpty || preparing > 0 {
                    AttachmentTray(items: attachments, preparing: preparing) { a in
                        withAnimation(.spring(duration: 0.28, bounce: 0.1)) { attachments.removeAll { $0.id == a.id } }
                    }
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                HStack(alignment: .bottom, spacing: 0) {
                    attachButton
                    // A text view of its own, so Paste takes pictures too (ComposerField.swift).
                    ComposerField(text: $draft, focused: $focused,
                                  placeholder: attachments.isEmpty ? placeholder : "Add a note",
                                  pasteImages: pasted,
                                  members: Set(mentionables.compactMap { $0.user?.lowercased() }), me: me, identifier: identifier)
                        .padding(.horizontal, Composer.gap)
                    Button(action: send) {
                        Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold))
                            .composerCircle(fill: canSend ? Theme.accent : Theme.raised)
                            .foregroundStyle(canSend ? .black : Theme.faint)
                            .animation(.spring(duration: 0.3, bounce: 0.35), value: canSend)
                    }
                    .buttonStyle(PressStyle())
                    .disabled(!canSend)
                    .accessibilityIdentifier(sendIdentifier)
                    .accessibilityLabel("Send")
                }
            }
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .padding(.horizontal, Space.m)
        }
        .padding(.top, Space.m).padding(.bottom, Space.s) // a little air between the last message and the box
        .background(Theme.bg)
        .animation(.spring(duration: 0.28, bounce: 0.1), value: suggestions.map(\.handle))
        .animation(.spring(duration: 0.28, bounce: 0.1), value: attachments.map(\.id))
        .animation(.spring(duration: 0.28, bounce: 0.1), value: preparing)
        .animation(.smooth(duration: 0.25), value: state.typing[board.id])
        .animation(.spring(duration: 0.28, bounce: 0.1), value: draft.hasPrefix("/"))
        .onChange(of: draft) { _, d in state.typed(d, in: board) } // "maya is typing…" for everyone else here
        .photosPicker(isPresented: $showPhotos, selection: $picked, maxSelectionCount: max(1, maxAttachments - attachments.count - preparing), selectionBehavior: .ordered, matching: .images)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            for item in items { add { guard let d = try await item.loadTransferable(type: Data.self) else { throw AttachError.unreadable("That picture") }; return try await Attachments.picture(d, name: nil) } }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { r in
            switch r {
            case .success(let urls): for u in urls.prefix(max(0, maxAttachments - attachments.count)) { add { try await Attachments.file(u) } }
            case .failure(let e): state.report(e)
            }
        }
        .fullScreenCover(isPresented: $showCamera) { CameraPicker { img in add { try await Attachments.photo(img) } }.ignoresSafeArea() }
    }

    /// + at the leading edge of the message box: Photos, the camera (when there is one), Files. Encrypted boards
    /// can't take attachments yet: the + is dimmed and says so.
    @ViewBuilder private var attachButton: some View {
        let label = Image(systemName: "plus").font(.system(size: 14, weight: .bold))
            .composerCircle(fill: Theme.raised)
        if board.encrypted == true {
            Button { Haptic.tap(); showEncryptedNote = true } label: { label.foregroundStyle(Theme.faint).opacity(0.55) }
                .buttonStyle(PressStyle())
                .popover(isPresented: $showEncryptedNote, arrowEdge: .bottom) {
                    Label("Pictures and files can't be sent on encrypted boards yet.", systemImage: "lock.fill")
                        .font(Typo.secondary).foregroundStyle(Theme.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(width: 260, alignment: .leading)
                        .padding(.horizontal, Space.m).padding(.vertical, Space.s + 2)
                        .presentationCompactAdaptation(.popover)
                        .presentationBackground(Theme.raised)
                        .accessibilityIdentifier("attach-unavailable")
                }
                .accessibilityIdentifier(attachIdentifier)
                .accessibilityLabel("Attach")
                .accessibilityHint("Not available on encrypted boards yet")
        } else {
            Menu {
                Button("Photos", systemImage: "photo.on.rectangle") { showPhotos = true }
                if UIImagePickerController.isSourceTypeAvailable(.camera) { Button("Camera", systemImage: "camera") { showCamera = true } }
                Button("Files", systemImage: "folder") { showFiles = true }
            } label: { label.foregroundStyle(Theme.muted) }
                .menuOrder(.fixed)
                .menuStyle(.button).buttonStyle(.plain) // the bare circle, no system padding (it lines up with send)
                .disabled(attachments.count + preparing >= maxAttachments)
                .accessibilityIdentifier(attachIdentifier)
                .accessibilityLabel("Attach")
        }
    }

    /// Pictures pasted into the message box: attached like ones picked from Photos (not on encrypted boards, which
    /// can't take attachments yet: the + says why).
    private func pasted(_ images: [UIImage]) {
        guard board.encrypted != true else { Haptic.warn(); showEncryptedNote = true; return }
        Haptic.tap()
        for img in images.prefix(max(0, maxAttachments - attachments.count - preparing)) { add { try await Attachments.photo(img) } }
    }

    /// Prepares something picked (made to fit the size limit) and puts it in the message box.
    private func add(_ make: @escaping () async throws -> Attachment) {
        preparing += 1
        Task {
            do {
                let a = try await make()
                withAnimation(.spring(duration: 0.28, bounce: 0.1)) { attachments.append(a) }
            } catch { Haptic.warn(); state.report(error) }
            preparing -= 1
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = attachments
        guard canSend else { return }
        draft = ""
        withAnimation(.spring(duration: 0.3, bounce: 0.15)) { attachments = [] }
        Haptic.tap()
        let session = board.isAgentChat ? toSession?.wrappedValue : nil
        let replyTo = replyTo
        Task {
            if files.isEmpty, let (c, rest) = SlashCommand.parse(text, on: board) {
                await state.send(c.body(rest), to: board, replyTo: replyTo, toSession: session, type: c.type)
            } else if files.isEmpty {
                await state.send(text, to: board, replyTo: replyTo, toSession: session)
            } else {
                await state.send(files: files, caption: text, to: board, replyTo: replyTo)
            }
            await sent?()
        }
    }
}
