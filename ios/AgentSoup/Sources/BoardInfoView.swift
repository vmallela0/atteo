// A board's info: its picture (any member who can post changes or removes it), who's in it, invite someone (a
// friend by name, anyone by email) or share a link, its files, and, for its owners, rename and archive. The chat's
// Info sheet (BoardInfoSheet, from the title) hosts it, with what's open and who's here above and the files in their
// place. Also the "New board" sheet from Chats.

import PhotosUI
import SwiftUI

struct BoardInfoView<Top: View, Files: View>: View {
    @EnvironmentObject var state: AppState
    let boardId: String
    let fallback: Board
    let top: Top // what's open and who's here, under the header
    let files: Files // the board's files
    init(boardId: String, fallback: Board, @ViewBuilder top: () -> Top, @ViewBuilder files: () -> Files) {
        self.boardId = boardId; self.fallback = fallback; self.top = top(); self.files = files()
    }
    @State private var members: BoardMembersResponse?
    @State private var friends: [Person] = []
    @State private var to = ""
    @State private var inviting = false
    @State private var sent: String?
    @State private var link: URL?
    @State private var makingLink = false
    @State private var renaming = false
    @State private var newTitle = ""
    @State private var confirmArchive = false
    @State private var pickedPicture: PhotosPickerItem?
    @State private var pictureBusy = false
    @State private var pictureError: String?
    @State private var confirmRemovePicture = false
    @State private var cropping: CropRequest?
    @State private var pictureSaving = false
    @State private var invitingAgent = false // "Invite an agent" (InviteAgent.swift)
    @ObservedObject private var pictures = BoardPictureStore.shared
    @FocusState private var typing: Bool
    @Environment(\.chatDensity) private var density

    /// The board as it is now (a rename shows at once), else what we were handed.
    private var board: Board { state.boards.first { $0.id == boardId } ?? fallback }
    private var direct: Bool { board.kind == "direct" }
    /// "Your agent": only you and your agents, so nobody to invite and no members to list.
    private var agentChat: Bool { board.isAgentChat }
    private var owner: Bool { members?.you == "owner" || board.createdBy == state.me?.owner }
    /// Any member who can post changes the picture: not on a DM, an archived board, or as a viewer. Shown once your
    /// role is known, so a viewer never sees a control that would only say no.
    private var canChangePicture: Bool { !direct && !agentChat && board.archived != true && members != nil && members?.you != "viewer" }
    /// "Invite an agent": a board (not a DM, "Your agent" or archived), once your role is known and isn't viewer.
    private var canInviteAgent: Bool { board.invitesAgents && members != nil && members?.you != "viewer" }
    private var suggestions: [Person] {
        let here = Set((members?.members ?? []).map(\.user))
        let q = to.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: "@", with: "")
        guard !to.contains("@") || to.hasPrefix("@") else { return [] }
        return Array(friends.filter { !here.contains($0.name) && (q.isEmpty || $0.name.contains(q) || ($0.displayName ?? "").lowercased().contains(q)) }.prefix(4))
    }

    var body: some View {
        List {
            Section {
                VStack(spacing: Space.s) {
                    // The board's picture, large (a DM: the other person's).
                    BoardPicture(board: board, size: 96)
                        .overlay {
                            if pictureBusy {
                                RoundedRectangle(cornerRadius: 96 * 0.3, style: .continuous).fill(.black.opacity(0.4))
                                ProgressView().tint(.white)
                            }
                        }
                        .accessibilityElement()
                        .accessibilityLabel(direct ? "\(board.displayName(me: state.me?.owner))'s picture" : "Board picture")
                        .accessibilityValue(pictures.look(of: board))
                        .accessibilityIdentifier("board-picture")
                        .padding(.bottom, Space.xs)
                    Text(board.displayName(me: state.me?.owner)).font(.title3.weight(.semibold)).foregroundStyle(Theme.text).lineLimit(2)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("board-info-title")
                    HStack(spacing: Space.xs) {
                        if board.encrypted == true { Image(systemName: "lock.fill").font(.system(size: 10)) }
                        Text(verbatim: agentChat ? String(localized: "Just you and your agents", bundle: .l10n) : [board.encrypted == true ? String(localized: "End-to-end encrypted", bundle: .l10n) : nil, members.map { String(localized: "\($0.members.count) members", bundle: .l10n) }].compactMap { $0 }.joined(separator: " · "))
                    }
                    .font(Typo.meta).foregroundStyle(Theme.muted)
                    if canChangePicture { pictureControls }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, Space.xs)
            }
            .listRowBackground(Color.clear)

            top

            if !direct && !agentChat {
                Section {
                    // Your own assistant (its join message) or a friend's agent (InviteAgent.swift; vedu #1812).
                    if canInviteAgent {
                        Button { invitingAgent = true } label: { InfoLabel(InviteAgentWords.title, "person.badge.plus") }
                            .accessibilityIdentifier("invite-agent")
                    }
                    HStack(spacing: Space.s) {
                        TextField("Friend's name or an email", text: $to)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.emailAddress)
                            .focused($typing).submitLabel(.send).onSubmit { send(to) }
                            .accessibilityIdentifier("invite-to")
                        if !to.trimmingCharacters(in: .whitespaces).isEmpty {
                            Button { send(to) } label: { if inviting { ProgressView() } else { Text("Invite").fontWeight(.semibold) } }
                                .disabled(inviting)
                                .accessibilityIdentifier("invite-send")
                        }
                    }
                    ForEach(typing || !to.isEmpty ? suggestions : []) { f in
                        Button { send(f.name) } label: {
                            HStack(spacing: Space.m) {
                                PersonRow(p: f)
                                Spacer()
                                Image(systemName: "plus.circle.fill").font(.system(size: 20)).foregroundStyle(Theme.accent)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("invite-\(f.name)")
                    }
                    if let sent { Text(sent).font(Typo.meta).foregroundStyle(Theme.ok) }
                    if owner {
                        if let link {
                            HStack(spacing: Space.s) {
                                Text(link.absoluteString).font(.system(.footnote, design: .monospaced)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                                Spacer(minLength: Space.s)
                                Button { UIPasteboard.general.url = link; Haptics.play(.copied); sent = String(localized: "Link copied. Anyone with an account can join for 7 days.", bundle: .l10n) } label: { Image(systemName: "doc.on.doc").foregroundStyle(Theme.text) }
                                    .buttonStyle(.borderless).accessibilityLabel("Copy link")
                                ShareLink(item: link, subject: Text(board.title), message: Text("Join \(board.title) on Atteo")) { Image(systemName: "square.and.arrow.up").foregroundStyle(Theme.text) }
                                    .buttonStyle(.borderless).accessibilityLabel("Share link")
                            }
                        } else {
                            Button {
                                makingLink = true
                                Task { link = await state.inviteLink(boardId); makingLink = false }
                            } label: {
                                HStack { InfoLabel("Invite with a link", "link"); Spacer(); if makingLink { ProgressView() } }
                            }
                            .accessibilityIdentifier("invite-link")
                        }
                    }
                } header: { SectionHeader("Invite") } footer: {
                    Text(owner ? "Friends by name; anyone else by email. A link lets anyone with an account join (can post, for 7 days)." : "Friends by name; anyone else by email.")
                }
                .listRowBackground(Theme.card)
            }

            if !agentChat {
            Section {
                ForEach(members?.members ?? []) { m in
                    // Tap: their card (picture, bio, Message / Add friend, and their agent).
                    NavigationLink { PersonCard(name: m.user, open: { b in state.openRequest = b }) } label: {
                    HStack(spacing: Space.m) {
                        Avatar(name: m.user, size: 32)
                        VStack(alignment: .leading, spacing: Space.xxs) {
                            Text(verbatim: m.user == state.me?.owner ? String(localized: "\(m.displayName ?? m.user) (you)", bundle: .l10n) : m.displayName ?? m.user).font(Typo.rowTitleRead).foregroundStyle(Theme.text).lineLimit(1)
                            if m.displayName != nil { Text("@\(m.user)").font(Typo.micro).foregroundStyle(Theme.faint) }
                        }
                        Spacer()
                        Text(m.role == "owner" ? "Owner" : m.role == "viewer" ? "Can view" : "Can post").font(Typo.micro).foregroundStyle(Theme.faint)
                    }
                    }
                    .accessibilityIdentifier("member-\(m.user)")
                }
                if members == nil { ProgressView().frame(maxWidth: .infinity) }
            } header: { if let members { SectionHeader("Members · \(members.members.count)") } else { SectionHeader("Members") } }
            .listRowBackground(Theme.card)
            }

            files

            if owner && !direct && !agentChat {
                Section {
                    Button { newTitle = board.title; renaming = true } label: { InfoLabel("Rename", "pencil") }
                        .accessibilityIdentifier("board-rename")
                    Button(role: .destructive) { confirmArchive = true } label: { InfoLabel("Archive", "archivebox", color: Theme.danger) }
                        .accessibilityIdentifier("board-archive")
                } footer: { Text("Archiving makes the board read-only for everyone and takes it off your list. Restore it on the web.") }
                .listRowBackground(Theme.card)
            }
        }
        .listSectionSpacing(.compact)
        .listDensity(density)
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .navigationTitle("Info")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Rename board", isPresented: $renaming) {
            TextField("Title", text: $newTitle)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                let t = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !t.isEmpty, t != board.title else { return }
                Task { _ = await state.renameBoard(boardId, to: t) }
            }
        }
        .confirmationDialog("Remove the board picture?", isPresented: $confirmRemovePicture, titleVisibility: .visible) {
            Button("Remove picture", role: .destructive) { changePicture(nil) }
        } message: { Text("Everyone sees its initial again, and the board gets a line saying you removed it.") }
        .onChange(of: pickedPicture) { _, item in
            guard let item else { return }
            pickedPicture = nil
            pictureBusy = true
            pictureError = nil
            Task {
                let data = try? await item.loadTransferable(type: Data.self)
                guard let img = data.flatMap(UIImage.init(data:)) else {
                    pictureBusy = false
                    withAnimation(.smooth) { pictureError = String(localized: "That picture couldn't be read. Try another one.", bundle: .l10n) }
                    return
                }
                cropping = CropRequest(image: img.uprightAndSmall()) // crop and touch it up first (#1001)
            }
        }
        .sheet(item: $cropping, onDismiss: { if !pictureSaving { pictureBusy = false } }) { c in
            PictureEditor(image: c.image, round: false, side: 256) { jpeg in
                cropping = nil
                guard let jpeg else { pictureBusy = false; return }
                pictureSaving = true
                changePicture(jpeg)
            }
            .presentationBackground(Theme.bg)
        }
        .sheet(isPresented: $invitingAgent) { InviteAgentSheet(board: board).presentationDetents([.large]).presentationBackground(Theme.bg) }
        .confirmationDialog("Archive \(board.title)?", isPresented: $confirmArchive, titleVisibility: .visible) {
            Button("Archive", role: .destructive) { Task { _ = await state.archiveBoard(boardId) } }
        } message: { Text("It becomes read-only for everyone. You can restore it on the web.") }
        .task {
            async let m = state.boardMembers(boardId)
            async let f = state.friends()
            let (mm, ff) = await (m, f)
            withAnimation(.smooth) { members = mm; friends = ff }
        }
        .refreshable { members = await state.boardMembers(boardId) }
    }

    /// Change picture (from Photos) and Remove picture, under the board's name; what went wrong says so right here.
    @ViewBuilder private var pictureControls: some View {
        HStack(spacing: Space.s) {
            PhotosPicker(selection: $pickedPicture, matching: .images) {
                PictureControl(title: "Change picture", icon: "photo", color: Theme.text)
            }
            .accessibilityIdentifier("board-picture-change")
            if board.picture != nil {
                Button(role: .destructive) { confirmRemovePicture = true } label: {
                    PictureControl(title: "Remove picture", icon: "trash", color: Theme.danger)
                }
                .accessibilityIdentifier("board-picture-remove")
            }
        }
        .buttonStyle(.borderless)
        .disabled(pictureBusy)
        .padding(.top, Space.xs)
        if let pictureError {
            Text(pictureError).font(Typo.meta).foregroundStyle(Theme.danger).multilineTextAlignment(.center)
                .accessibilityIdentifier("board-picture-error")
        }
        if board.encrypted == true {
            Text("Visible to the server, like the board name.").font(Typo.micro).foregroundStyle(Theme.faint)
                .accessibilityIdentifier("board-picture-caption")
        }
    }

    private func changePicture(_ jpeg: Data?) {
        pictureBusy = true
        pictureError = nil
        Task {
            let failed = await state.setBoardPicture(boardId, jpeg: jpeg)
            pictureBusy = false
            pictureSaving = false
            withAnimation(.smooth) { pictureError = failed }
        }
    }

    private func send(_ who: String) {
        let w = who.trimmingCharacters(in: .whitespaces)
        guard !w.isEmpty, !inviting else { return }
        inviting = true
        Task {
            if let msg = await state.invite(boardId, w) {
                withAnimation(.smooth) { sent = msg; to = "" }
                members = await state.boardMembers(boardId)
            }
            inviting = false
        }
    }
}

/// A small capsule button under the board's picture: a quiet icon and its words.
private struct PictureControl: View {
    let title: LocalizedStringKey
    let icon: String
    let color: Color
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon).font(.system(size: 12, weight: .semibold)).accessibilityHidden(true)
            Text(title)
        }
        .font(Typo.meta.weight(.semibold)).foregroundStyle(color)
        .padding(.horizontal, Space.m).frame(minHeight: 32)
        .background(Theme.card, in: Capsule())
        .contentShape(Capsule())
    }
}

/// A row's label in Board info: a quiet icon and plain text (clay is for what needs you, not every row).
struct InfoLabel: View {
    let title: Text
    let icon: String
    var color: Color = Theme.text
    init(_ title: LocalizedStringKey, _ icon: String, color: Color = Theme.text) { self.title = Text(title); self.icon = icon; self.color = color }
    /// Words from code, as they are (localize them first, e.g. Vocab.pick).
    @_disfavoredOverload init<S: StringProtocol>(_ title: S, _ icon: String, color: Color = Theme.text) { self.title = Text(title); self.icon = icon; self.color = color }
    var body: some View {
        Label { title.foregroundStyle(color) } icon: { Image(systemName: icon).foregroundStyle(color == Theme.text ? Theme.muted : color) }
    }
}

/// A new board: a title, and end-to-end encryption (on by default, like the web).
struct NewBoardSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    let open: (Board) -> Void
    @State private var title = ""
    @State private var encrypted = true
    @State private var busy = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: Space.m) {
                        BoardTile(title: title.isEmpty ? "#" : title, size: 40)
                        TextField("What's it for?", text: $title)
                            .font(Typo.body.weight(.medium)).focused($focused).submitLabel(.done).onSubmit(create)
                            .accessibilityIdentifier("new-board-title")
                    }
                }
                .listRowBackground(Theme.card)
                Section {
                    Toggle(isOn: $encrypted) { InfoLabel("End-to-end encrypted", "lock.fill") }.tint(Theme.accent)
                        .accessibilityIdentifier("new-board-encrypted")
                } footer: {
                    Text(encrypted ? "Only members' devices can read it; the server stores only ciphertext." : "A regular board: the server stores what's said, as on most boards.")
                }
                .listRowBackground(Theme.card)
            }
            .listSectionSpacing(.compact)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("New board")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() }.toolbarText() }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: create) { if busy { ProgressView() } else { Text("Create") } }.toolbarText(primary: true)
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                        .accessibilityIdentifier("new-board-create")
                }
            }
            .onAppear { focused = true }
        }
    }

    private func create() {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !busy else { return }
        busy = true
        Task {
            if let b = await state.createBoard(title: t, encrypted: encrypted) { open(b) }
            busy = false
        }
    }
}
