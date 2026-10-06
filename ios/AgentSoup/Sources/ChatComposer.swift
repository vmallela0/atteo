// The message box, one component for the chat and its threads (jxn #1094): who's typing, what "/" makes a message,
// who "@" can name, pictures and files waiting to go, the text (ComposerField) and send. The chat and a thread look
// and behave the same; a thread's box answers a message (`replyTo`). Like iMessage (vedu #1783): an empty box has the
// mic (dictation, Voice.swift), and once there's something to send the mic gives way to send. Voice chat isn't here:
// it's the phone at the top right of the chat's bar (BoardsView.swift).

import PhotosUI
import SwiftUI

struct ChatComposer: View {
    @EnvironmentObject var state: AppState
    let board: Board
    /// The box's words (MessageDrafts.swift). The object, not a binding to its text: a parent comparing a binding reads
    /// the words, and then redraws the whole chat on every key (jxn #4181); this way only this box reads them.
    let box: ComposerDraft
    private var draft: String {
        get { box.text }
        nonmutating set { box.set(newValue) }
    }
    @Binding var focused: Bool
    var placeholder: String
    /// The thread's box: what its messages answer (nil: the chat's box).
    var replyTo: Int? = nil
    /// The thread this box writes in (its first message), or nil for the chat: "… is typing" is per place (vedu #4746).
    var threadRoot: Int? = nil
    /// "Your agent": one of your sessions (only the agent chat's box picks one).
    var toSession: Binding<String?>? = nil
    var identifier = "composer"
    var sendIdentifier = "send"
    var attachIdentifier = "attach"
    /// After a message went (the thread refreshes what the server has for it).
    var sent: (() async -> Void)? = nil
    /// A reply started on one message (a swipe or Reply): "Replying to theo · its first line" above the box, and ✕
    /// to cancel it. What's typed stays either way (vedu #1469).
    var replying: (who: String, line: String)? = nil
    var cancelReply: (() -> Void)? = nil

    // Pictures and files waiting in the message box (sent with the text, the way the web composer sends them).
    @State private var attachments: [Attachment] = []
    @State private var preparing = 0 // picked, still being made to fit
    @State private var picked: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var showEncryptedNote = false
    @ObservedObject private var voice = VoiceInput.shared
    private let maxAttachments = 10
    // The lock (#1748/#1749, like the web's): who the next message is for. Each time it's turned on it starts at People
    // only, the stricter one (#1866/#1881): Just mine, which your agents see, is always a choice made for that message.
    @State private var privacy: Privacy = .everyone
    @State private var lockWarning = false // People only, sent without an @person: say who it needs

    /// Who a message is for: everyone here, People only (the people you @, no agent) or Just mine (you and your agents).
    enum Privacy: String { case everyone, people, own }
    /// The lock is on the chat's box of a board: not in a thread (a reply has what it answers' audience), a DM or
    /// "Your agent" (private already), nor an encrypted board (its sealed posts can't carry an audience).
    private var lockable: Bool { replyTo == nil && !board.isAgentChat && board.kind != "direct" && board.encrypted != true }
    private var locked: Bool { lockable && privacy != .everyone }
    /// A reply in a thread whose message is people-only or just mine has that audience too (the server keeps it, asked
    /// or not), so the box says so (vedu #4777) and, like any private message, takes no pictures or files.
    private var inherited: String? { replyTo.flatMap { r in list.first { $0.seq == r }?.audience } }
    private var privateBox: Bool { locked || inherited != nil }

    private var me: String? { state.me?.owner }
    private var list: [Entry] { state.entries[board.id] ?? [] }

    private var canSend: Bool {
        guard preparing == 0 else { return false }
        if !attachments.isEmpty { return true }
        if let (_, rest) = SlashCommand.parse(draft, on: board, locked: locked) { return !rest.isEmpty } // "/task" alone: nothing to send yet
        return !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The mic while there's no text yet (and while it's listening: what it hears fills the box, and the mic is how you
    /// stop it), even with a picture waiting, so a caption can be said (vedu #2651); typed text gives way to send.
    private var showsMic: Bool {
        if voice.listening { return true }
        return preparing == 0 && draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Send once there's something to send: text, or a picture or file waiting (then it sits beside the mic).
    private var showsSend: Bool { !showsMic || !attachments.isEmpty }

    // MARK: - "@"

    /// What "@" can name here: each member's agent and each member (you can hand work to your own agent, but you
    /// don't mention yourself), plus everyone's agents and everyone.
    private var people: [String] {
        var people = state.members[board.id] ?? []
        for u in list.map(\.author) + (state.boardAgents[board.id] ?? []).map(\.user) where !people.contains(u) { people.append(u) }
        return people
    }

    /// Each member, their agent (by its name too: "@Jarvis", unless another agent here has the same name, #1125) and
    /// each of their agent sessions ("@jxn/opus-b", jxn #2551), in the web's order (MentionMenu).
    private var mentionables: [Mentionable] {
        MentionMenu.options(people: people, me: me, named: state.agentNames[board.id] ?? [:], sessions: state.boardAgents[board.id] ?? [])
    }
    /// When the @ menu last fetched the board's agent sessions: while it's open, at most every 10 seconds (the web's
    /// pace), so a session that just started or was renamed can be named.
    @State private var agentsAt = Date.distantPast

    /// Dictation's mentions (Voice.swift): "at vedu" → "@vedu", for the same people "@" can name.
    private var spoken: SpokenMentions? {
        guard let me else { return nil }
        return SpokenMentions(me: me, members: people,
                              agentNames: (state.agentNames[board.id] ?? [:]).filter { !$0.value.ambiguous }.mapValues(\.name),
                              displayNames: people.map { state.displayName(for: $0) })
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
        // "theo", "theo's ag", "theo/sc": what's typed so far (and not what's already complete).
        return Array(MentionMenu.filter(mentionables, query: q).prefix(12))
    }

    private func refreshSessions() {
        guard mentionQuery != nil, Date().timeIntervalSince(agentsAt) > 10 else { return }
        agentsAt = Date()
        Task { await state.loadAgents(board) }
    }

    private func insert(_ m: Mentionable) {
        guard let at = draft.lastIndex(of: "@") else { return }
        draft = String(draft[..<at]) + "@\(m.handle) "
    }

    /// The thread's lock, read-only: a reply here keeps its message's audience (vedu #4777).
    private func inheritedNote(_ audience: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.xs) {
            Image(systemName: "lock.fill").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted)
                .accessibilityHidden(true)
            Text(verbatim: audience == "own"
                 ? String(localized: "Just mine: replies here stay with you and your agents.", bundle: .l10n)
                 : String(localized: "People only: replies here stay with the same people. Agents can't see them.", bundle: .l10n))
                .font(Typo.micro).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.l)
        .padding(.bottom, Space.xs)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("thread-lock")
    }

    // MARK: - The box

    /// One soft field on the page (no bar, no outline), + at its leading edge and send inside its trailing edge.
    /// Above it, when they apply: who's typing, what "/" makes it, and who "@" can name.
    var body: some View {
        VStack(spacing: 0) {
            TypingRow(board: board.id, root: threadRoot ?? 0)
            if let toSession { AgentToPicker(to: toSession) }
            // "/": what a message can be besides a note (a task, a decision, a question).
            if attachments.isEmpty {
                let fits = SlashCommand.suggestions(draft, on: board, locked: locked)
                if !fits.isEmpty { SlashChips(commands: fits) { c in draft = c.word + " " } }
                else if let (c, _) = SlashCommand.parse(draft, on: board, locked: locked) { SlashChips(commands: [c], active: c) { _ in } }
            }
            if locked { lockChoices.transition(.move(edge: .bottom).combined(with: .opacity)) }
            if let inherited { inheritedNote(inherited) }
            if let replying { replyingRow(replying).transition(.move(edge: .bottom).combined(with: .opacity)) }
            if !suggestions.isEmpty {
                // Up to five rows show; more (someone's several sessions) scroll inside the list.
                ScrollView {
                    MentionList(items: suggestions, pick: insert)
                }
                .scrollBounceBehavior(.basedOnSize)
                .scrollClipDisabled() // the list's shadow
                .frame(maxHeight: suggestions.count > 5 ? 5.5 * 40 + 8 : nil)
                .fixedSize(horizontal: false, vertical: suggestions.count <= 5)
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
                    if lockable { lockButton }
                    // A text view of its own, so Paste takes pictures too (ComposerField.swift).
                    ComposerField(text: box.binding, focused: $focused,
                                  placeholder: !attachments.isEmpty ? String(localized: "Add a note", bundle: .l10n) : locked ? lockedPlaceholder : placeholder,
                                  pasteImages: pasted,
                                  members: Set(mentionables.compactMap { $0.user?.lowercased() }), me: me,
                                  agentNames: state.agentNameMap(board.id),
                                  displayName: { state.displayName(for: $0) }, nameRevision: state.displayNames,
                                  identifier: identifier)
                        .padding(.horizontal, Composer.gap)
                    if showsMic {
                        // Hold to talk (Voice.swift): words go in the box; "send it" at the end sends.
                        MicButton(draft: box.binding, send: send, identifier: identifier == "composer" ? "mic" : "\(identifier)-mic", spoken: spoken)
                            .padding(.trailing, showsSend ? Composer.gap : 0)
                            .transition(.scale(scale: 0.6).combined(with: .opacity))
                    }
                    if showsSend {
                        Button(action: send) {
                            Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold))
                                .composerCircle(fill: canSend ? Theme.primary : Theme.raised)
                                .foregroundStyle(canSend ? Theme.onPrimary : Theme.faint)
                                .animation(.spring(duration: 0.3, bounce: 0.35), value: canSend)
                        }
                        .buttonStyle(PressStyle())
                        .disabled(!canSend)
                        .accessibilityIdentifier(sendIdentifier)
                        .accessibilityLabel("Send")
                        .transition(.scale(scale: 0.6).combined(with: .opacity))
                    }
                }
                .animation(.spring(duration: 0.25, bounce: 0.25), value: showsMic)
                .animation(.spring(duration: 0.25, bounce: 0.25), value: showsSend)
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
        .animation(.spring(duration: 0.28, bounce: 0.1), value: privacy)
        .onChange(of: draft) { _, d in state.typed(d, in: board, root: threadRoot ?? 0); refreshSessions() } // "maya is typing…" for everyone else here
        .photosPicker(isPresented: $showPhotos, selection: $picked, maxSelectionCount: max(1, maxAttachments - attachments.count - preparing), selectionBehavior: .ordered, matching: .images)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            for item in items { add { guard let d = try await item.loadTransferable(type: Data.self) else { throw AttachError.unreadable(String(localized: "That picture", bundle: .l10n)) }; return try await Attachments.picture(d, name: nil) } }
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
            Button { showEncryptedNote = true } label: { label.foregroundStyle(Theme.faint).opacity(0.55) }
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
                .disabled(attachments.count + preparing >= maxAttachments || privateBox) // a picture or file can't be private
                .opacity(privateBox ? 0.55 : 1)
                .accessibilityIdentifier(attachIdentifier)
                .accessibilityLabel("Attach")
        }
    }

    /// Pictures pasted into the message box: attached like ones picked from Photos (not on encrypted boards, which
    /// can't take attachments yet: the + says why).
    private func pasted(_ images: [UIImage]) {
        guard board.encrypted != true else { Haptics.play(.warning); showEncryptedNote = true; return }
        guard !privateBox else { Haptics.play(.warning); return } // a picture or file can't be private
        for img in images.prefix(max(0, maxAttachments - attachments.count - preparing)) { add { try await Attachments.photo(img) } }
    }

    /// Prepares something picked (made to fit the size limit) and puts it in the message box.
    private func add(_ make: @escaping () async throws -> Attachment) {
        preparing += 1
        Task {
            do {
                let a = try await make()
                withAnimation(.spring(duration: 0.28, bounce: 0.1)) { attachments.append(a) }
            } catch { Haptics.play(.failed); state.report(error) }
            preparing -= 1
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = attachments
        guard canSend else { return }
        // Private: Just mine needs nobody; People only needs the people it's for, @named in it (agents never see it).
        let audience: String? = locked ? privacy.rawValue : nil
        let people = audience == "people" ? mentionedPeople(text) : []
        if audience == "people" && people.isEmpty {
            Haptics.play(.warning)
            withAnimation(.smooth(duration: 0.2)) { lockWarning = true }
            return
        }
        // End-to-end encrypted: a credential is caught here (ClientScan.swift), and what you typed stays to fix.
        if board.encrypted == true, let blocked = ClientScan.blocked(text) {
            Haptics.play(.failed)
            state.report(blocked)
            return
        }
        draft = ""
        box.save() // sent: the saved draft goes now, so it can't come back if the app is closed within the pause
        withAnimation(.spring(duration: 0.3, bounce: 0.15)) { attachments = [] }
        Haptics.play(.sent)
        let session = board.isAgentChat ? toSession?.wrappedValue : nil
        let replyTo = replyTo
        let wasLocked = locked
        if wasLocked { privacy = .everyone; lockWarning = false } // like the web: each private message is chosen for itself
        Task {
            if files.isEmpty, let (c, rest) = SlashCommand.parse(text, on: board, locked: wasLocked) {
                await state.send(c.body(rest), to: board, replyTo: replyTo, toSession: session, type: c.type, audience: audience, toPeople: people)
            } else if files.isEmpty {
                await state.send(text, to: board, replyTo: replyTo, toSession: session, audience: audience, toPeople: people)
            } else {
                await state.send(files: files, caption: text, to: board, replyTo: replyTo)
            }
            await sent?()
        }
    }

    /// "Replying to theo · Rollback plan…" and ✕, like the web's line above its box.
    private func replyingRow(_ r: (who: String, line: String)) -> some View {
        HStack(spacing: Space.s) {
            Image(systemName: "arrowshape.turn.up.left.fill").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.accent)
                .accessibilityHidden(true)
            (Text("Replying to") + Text(verbatim: " ") + Text(verbatim: r.who).bold()
                + Text(verbatim: r.line.isEmpty ? "" : " · " + r.line).foregroundStyle(Theme.muted))
                .font(Typo.micro).foregroundStyle(Theme.text).lineLimit(1)
                .accessibilityIdentifier("reply-chip")
            Spacer(minLength: 0)
            if let cancelReply {
                Button { Haptics.play(.touch); cancelReply() } label: {
                    Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.muted)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("reply-cancel")
                .accessibilityLabel(Text("Cancel reply"))
            }
        }
        .padding(.horizontal, Space.l)
        .padding(.bottom, Space.xs)
    }

    // MARK: - The lock

    /// The lock, between + and the text: off, a plain lock; on, filled (ink for People only, the accent for Just mine).
    /// A tap turns it on at People only, or off.
    private var lockButton: some View {
        Button {
            Haptics.play(.touch)
            withAnimation(.spring(duration: 0.28, bounce: 0.1)) { privacy = privacy == .everyone ? .people : .everyone; lockWarning = false }
        } label: {
            Image(systemName: locked ? "lock.fill" : "lock").font(.system(size: 13, weight: .semibold))
                .composerCircle(fill: !locked ? Theme.raised : privacy == .own ? Theme.muted : Theme.text)
                .foregroundStyle(!locked ? Theme.muted : Theme.onText)
        }
        .buttonStyle(PressStyle())
        .padding(.leading, -Composer.inset) // snug against the +
        .disabled(!attachments.isEmpty || preparing > 0) // a picture or file can't be private
        .accessibilityIdentifier("composer-lock")
        .accessibilityLabel(Text("Private"))
        .accessibilityValue(Text(privacyName(locked ? privacy : .everyone)))
        .accessibilityHint(Text("Private: People only (the people you @, no agents) or Just mine (you and your agents)"))
        .accessibilityAddTraits(locked ? .isSelected : [])
    }

    private func privacyName(_ p: Privacy) -> String {
        switch p {
        case .everyone: return String(localized: "Everyone", bundle: .l10n, comment: "The composer's lock: a message everyone on the board sees")
        case .people: return String(localized: "People only", bundle: .l10n)
        case .own: return String(localized: "Just mine", bundle: .l10n)
        }
    }

    /// While the lock is on: Everyone · People only · Just mine (the web's two, and Everyone to turn it off), and who
    /// will see it.
    private var lockChoices: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            HStack(spacing: Space.xs) {
                Image(systemName: "lock.fill").font(.system(size: 11, weight: .semibold)).foregroundStyle(privacy == .own ? Theme.text : Theme.muted)
                    .accessibilityHidden(true)
                lockChoice(.everyone, id: "lock-everyone")
                lockChoice(.people, id: "lock-people")
                lockChoice(.own, id: "lock-own")
                Spacer(minLength: 0)
            }
            // (The web's words follow its chips on one line, after a "·": here they're a line of their own.)
            Text(verbatim: (lockWarning ? String(localized: "@ the people who should see it: agents never will", bundle: .l10n)
                 : privacy == .own ? String(localized: "· only you and your agents can see it.", bundle: .l10n)
                 : String(localized: "· only the people you @ can see it. Agents can't.", bundle: .l10n)).trimmingCharacters(in: CharacterSet(charactersIn: "·・ ")))
                .font(Typo.micro).foregroundStyle(lockWarning ? Theme.danger : Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("lock-why")
        }
        .padding(.horizontal, Space.l)
        .padding(.bottom, Space.xs)
    }

    private func lockChoice(_ p: Privacy, id: String) -> some View {
        let on = p == privacy
        return Button {
            Haptics.play(.touch)
            withAnimation(.spring(duration: 0.28, bounce: 0.1)) { privacy = p; lockWarning = false }
        } label: {
            Text(privacyName(p)).font(Typo.micro.weight(.semibold))
                .foregroundStyle(on ? Theme.onText : Theme.text)
                .padding(.horizontal, 10).frame(minHeight: 28)
                .background(on ? (p == .own ? Theme.muted : Theme.text) : Theme.card, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
        .accessibilityIdentifier(id)
        .accessibilityAddTraits(on ? [.isSelected] : [])
    }

    /// "Only the people you @ will see this…" / "Only you and your agents will see this…".
    private var lockedPlaceholder: String {
        privacy == .own ? String(localized: "Only you and your agents will see this…", bundle: .l10n)
            : String(localized: "Only the people you @ will see this…", bundle: .l10n)
    }

    /// The people (not their agents) a message @names, among the people here: who a People only message is for.
    private func mentionedPeople(_ text: String) -> [String] {
        let people = Set(mentionables.filter { !$0.agent && $0.user != nil && $0.user != me }.compactMap(\.user))
        return people.sorted().filter { u in
            // "@theo", but not "@theo's agent" or "@theo/builder" (the web's test).
            let pattern = "(^|\\s)@" + NSRegularExpression.escapedPattern(for: u) + "(?![a-z0-9_.-]|['’]s\\s+(?:agent|assistant)\\b|/)"
            return text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
        }
    }
}
