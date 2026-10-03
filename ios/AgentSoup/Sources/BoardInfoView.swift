// A board's info: who's in it, invite someone (a friend by name, anyone by email) or share a link, its files, and,
// for its owners, rename and archive. Opened from the board's "Agents here" sheet (the ⓘ in its corner). Also the
// "New board" sheet from Chats.

import SwiftUI

/// The ⓘ in "Agents here": the board's info, full height, over that half sheet.
struct BoardInfoToolbar: ToolbarContent {
    let board: Board
    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) { BoardInfoButton(board: board) }
    }
}

private struct BoardInfoButton: View {
    let board: Board
    @State private var open = false
    var body: some View {
        Button { Haptic.tap(); open = true } label: { Image(systemName: "info.circle").font(.system(size: 16, weight: .semibold)) }
            .accessibilityLabel("Board info")
            .sheet(isPresented: $open) {
                NavigationStack {
                    BoardInfoView(boardId: board.id, fallback: board)
                        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { open = false }.fontWeight(.semibold) } }
                }
                .presentationBackground(Theme.bg)
            }
    }
}

struct BoardInfoView: View {
    @EnvironmentObject var state: AppState
    let boardId: String
    let fallback: Board
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
    @FocusState private var typing: Bool

    /// The board as it is now (a rename shows at once), else what we were handed.
    private var board: Board { state.boards.first { $0.id == boardId } ?? fallback }
    private var direct: Bool { board.kind == "direct" }
    private var owner: Bool { members?.you == "owner" || board.createdBy == state.me?.owner }
    private var suggestions: [Person] {
        let here = Set((members?.members ?? []).map(\.user))
        let q = to.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: "@", with: "")
        guard !to.contains("@") || to.hasPrefix("@") else { return [] }
        return Array(friends.filter { !here.contains($0.name) && (q.isEmpty || $0.name.contains(q) || ($0.displayName ?? "").lowercased().contains(q)) }.prefix(4))
    }

    var body: some View {
        List {
            Section {
                HStack(spacing: Space.m) {
                    if direct { Avatar(name: board.displayName(me: state.me?.owner), size: 52) } else { BoardTile(title: board.title, size: 52) }
                    VStack(alignment: .leading, spacing: Space.xxs) {
                        Text(board.displayName(me: state.me?.owner)).font(.title3.weight(.semibold)).foregroundStyle(Theme.text).lineLimit(2)
                            .accessibilityIdentifier("board-info-title")
                        HStack(spacing: Space.xs) {
                            if board.encrypted == true { Image(systemName: "lock.fill").font(.system(size: 10)) }
                            Text([board.encrypted == true ? "End-to-end encrypted" : nil, members.map { "\($0.members.count) member\($0.members.count == 1 ? "" : "s")" }].compactMap { $0 }.joined(separator: " · "))
                        }
                        .font(Typo.meta).foregroundStyle(Theme.muted)
                    }
                }
                .padding(.vertical, Space.xs)
            }
            .listRowBackground(Color.clear)

            if !direct {
                Section {
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
                                Button { UIPasteboard.general.url = link; Haptic.done(); sent = "Link copied. Anyone with an account can join for 7 days." } label: { Image(systemName: "doc.on.doc").foregroundStyle(Theme.text) }
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

            Section {
                ForEach(members?.members ?? []) { m in
                    HStack(spacing: Space.m) {
                        Avatar(name: m.user, size: 32)
                        VStack(alignment: .leading, spacing: Space.xxs) {
                            Text(m.user == state.me?.owner ? "\(m.displayName ?? m.user) (you)" : m.displayName ?? m.user).font(Typo.rowTitleRead).foregroundStyle(Theme.text).lineLimit(1)
                            if m.displayName != nil { Text("@\(m.user)").font(Typo.micro).foregroundStyle(Theme.faint) }
                        }
                        Spacer()
                        Text(m.role == "owner" ? "Owner" : m.role == "viewer" ? "Can view" : "Can post").font(Typo.micro).foregroundStyle(Theme.faint)
                    }
                }
                if members == nil { ProgressView().frame(maxWidth: .infinity) }
            } header: { SectionHeader("Members\(members.map { " · \($0.members.count)" } ?? "")") }
            .listRowBackground(Theme.card)

            Section {
                NavigationLink { FilesList(board: boardId) } label: { InfoLabel("Files", "doc.on.doc") }
                    .accessibilityIdentifier("board-files")
            }
            .listRowBackground(Theme.card)

            if owner && !direct {
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
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .navigationTitle(direct ? "Info" : "Board info")
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

/// A row's label in Board info: a quiet icon and plain text (clay is for what needs you, not every row).
private struct InfoLabel: View {
    let title: String
    let icon: String
    var color: Color = Theme.text
    init(_ title: String, _ icon: String, color: Color = Theme.text) { self.title = title; self.icon = icon; self.color = color }
    var body: some View {
        Label { Text(title).foregroundStyle(color) } icon: { Image(systemName: icon).foregroundStyle(color == Theme.text ? Theme.muted : color) }
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
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: create) { if busy { ProgressView() } else { Text("Create").fontWeight(.semibold) } }
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
