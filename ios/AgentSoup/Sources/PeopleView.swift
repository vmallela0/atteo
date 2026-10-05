// New message: find someone (your friends first, then anyone you share a board with or who's listed), see who they
// are, and message them, add them as a friend, or block them. Like starting a chat in any messenger.

import SwiftUI

struct NewMessageSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.chatDensity) private var density
    @Environment(\.dismiss) private var dismiss
    /// Opens a conversation (the sheet closes first).
    let open: (Board) -> Void
    @State private var query = ""
    @State private var results: [Person] = []
    @State private var friends: [Person]?
    @State private var searching = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            List {
                if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    if let friends, !friends.isEmpty {
                        Section { ForEach(friends) { p in link(p) } } header: { SectionHeader("Friends") }
                            .listRowBackground(Theme.bg)
                    }
                } else {
                    Section {
                        ForEach(results) { p in link(p) }
                    }
                    .listRowBackground(Theme.bg)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .safeAreaInset(edge: .top, spacing: 0) { searchField }
            .overlay {
                if !query.trimmingCharacters(in: .whitespaces).isEmpty && results.isEmpty && !searching {
                    ContentUnavailableView("No one by that name", systemImage: "person.crop.circle.badge.questionmark", description: Text("You can find friends, people you share a board with, and anyone listed in People."))
                } else if query.isEmpty && friends?.isEmpty == true {
                    ContentUnavailableView("Find someone", systemImage: "person.2", description: Text("Search by name. Friends can message each other directly."))
                }
            }
            .navigationTitle("New message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() }.toolbarText() } }
            .navigationDestination(for: Person.self) { p in PersonCard(name: p.name, initial: p, open: open) }
            .task { focused = true; friends = await state.friends() }
            .task(id: query) {
                let q = query
                guard !q.trimmingCharacters(in: .whitespaces).isEmpty else { results = []; searching = false; return }
                searching = true
                try? await Task.sleep(nanoseconds: 250_000_000) // as you type, not on every key
                guard !Task.isCancelled else { return }
                let r = await state.searchPeople(q)
                guard !Task.isCancelled else { return }
                withAnimation(.smooth) { results = r }
                searching = false
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: Space.s) {
            Text("To:").font(Typo.secondary).foregroundStyle(Theme.muted)
            TextField("Name", text: $query)
                .font(Typo.body).focused($focused)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityIdentifier("people-search")
            if searching { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, Space.m).frame(height: 40)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .padding(.horizontal, Space.l).padding(.vertical, Space.s)
        .background(Theme.bg)
    }

    private func link(_ p: Person) -> some View {
        NavigationLink(value: p) { PersonRow(p: p) }
            .listRowInsets(EdgeInsets(top: Space.row(density), leading: Space.l, bottom: Space.row(density), trailing: Space.l))
            .listRowSeparator(.hidden)
            .accessibilityIdentifier("person-\(p.name)")
    }
}

struct PersonRow: View {
    let p: Person
    var body: some View {
        HStack(spacing: Space.m) {
            Avatar(name: p.name, size: 40)
            VStack(alignment: .leading, spacing: Space.xxs) {
                Text(p.displayName ?? p.name).font(Typo.rowTitleRead).foregroundStyle(Theme.text).lineLimit(1)
                Text(["@\(p.name)", p.relationLabel].compactMap { $0 }.joined(separator: " · ")).font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1)
            }
        }
    }
}

/// Someone, at a glance: picture, name, a line about them, how you're connected, and what you can do.
struct PersonCard: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    let name: String
    var initial: Person?
    let open: (Board) -> Void
    var agentFirst = false // opened on their agent ("@theo's agent", an agent's picture): its section leads, lit
    var ask: (() -> Void)? = nil // "Ask theo's agent" here (a chat's box); nil: in a DM
    var board: String? = nil // opened from a chat: Mute on this board is in its menu (Moderation.swift)
    @State private var agent: MeAgentResponse.Agent?
    @State private var p: Person?
    @State private var presence: String?
    @State private var busy = false
    @State private var confirmBlock = false

    var body: some View {
        let person = p ?? initial
        ScrollViewReader { proxy in
        ScrollView {
            VStack(spacing: Space.l) {
                VStack(spacing: Space.s) {
                    Avatar(name: name, size: 84)
                    Text(person?.displayName ?? name).font(Typo.ui(.title2).weight(.semibold)).foregroundStyle(Theme.text)
                    HStack(spacing: Space.xs) {
                        Text("@\(name)")
                        if let presence, presence != "offline" { Text("·"); Text(presence).foregroundStyle(Theme.ok) }
                    }
                    .font(Typo.meta).foregroundStyle(Theme.muted)
                    if let r = person?.relationLabel { Pill(text: r, color: person?.relation == "friend" ? Theme.ok : Theme.muted).padding(.top, Space.xxs) }
                }
                .padding(.top, Space.l)
                if let bio = person?.bio, !bio.isEmpty {
                    Text(bio).font(Typo.body).foregroundStyle(Theme.text).multilineTextAlignment(.center).padding(.horizontal, Space.l)
                }
                actions(person)
                    .padding(.horizontal, Space.l)
                if person?.relation != "friend" && person?.relation != "blocked" {
                    Text("Friends can message each other directly. Being friends doesn't open any of your boards to them.")
                        .font(Typo.micro).foregroundStyle(Theme.faint).multilineTextAlignment(.center).padding(.horizontal, Space.xl)
                }
                agentSection.id("agent").padding(.horizontal, Space.l).padding(.bottom, Space.l)
            }
            .frame(maxWidth: .infinity)
        }
        .onChange(of: agent != nil) { _, has in if has && agentFirst { withAnimation(.smooth) { proxy.scrollTo("agent", anchor: .top) } } }
        }
        .background(Theme.bg)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if person?.relation != "blocked" {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        // Mute on this board: their posts (and their agents') fold to one line and stop notifying you.
                        if let board, name.lowercased() != state.me?.owner.lowercased() {
                            if state.isMuted(name, on: board) {
                                Button("Unmute on this board", systemImage: "speaker.wave.2") { Task { _ = await state.unmute(name, on: board) } }
                            } else {
                                Button("Mute on this board", systemImage: "speaker.slash") { Task { _ = await state.mute(name, on: board) } }
                                    .accessibilityIdentifier("person-mute")
                            }
                        }
                        Button("Block \(name)", systemImage: "hand.raised", role: .destructive) { confirmBlock = true }
                    } label: { ToolbarIcon("ellipsis").frame(width: 32, height: 32).contentShape(Rectangle()) }
                    .accessibilityLabel("More")
                }
            }
        }
        .confirmationDialog("Block \(name)?", isPresented: $confirmBlock, titleVisibility: .visible) {
            Button("Block", role: .destructive) { Task { if await state.block(name) { p?.relation = "blocked"; if p == nil, var i = initial { i.relation = "blocked"; p = i } } } }
        } message: { Text("They can't message you, add you as a friend, or find you. You can unblock them on the web.") }
        .task {
            async let r = state.person(name)
            async let a = try? API.shared.get("/api/agents/\(name)", as: MeAgentResponse.self)
            let (rr, aa) = await (r, a)
            withAnimation(.smooth) {
                if let rr { p = rr.person; presence = rr.presence }
                agent = aa?.agent
            }
        }
    }

    /// Their agent: its picture, what it knows, whether it's working now (and on what), and a way to ask it something.
    @ViewBuilder private var agentSection: some View {
        let mine = (state.boardAgents.values.flatMap { $0 }).filter { $0.user == name }
        let best = mine.min { rank($0.state) < rank($1.state) }
        if agent != nil || !mine.isEmpty {
            VStack(alignment: .leading, spacing: Space.m) {
                HStack(spacing: Space.m) {
                    Avatar(name: name, agent: true, size: 44)
                        .overlay(alignment: .bottomTrailing) { if let best { StateDot(state: best.state).padding(2).background(Theme.card, in: Circle()).offset(x: 4, y: 4) } }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Vocab.agentOf(name)).font(Typo.rowTitle).foregroundStyle(Theme.text)
                        Text(best.map { $0.status ?? stateLine($0.state, $0.lastSeen) } ?? (agent?.online == true ? String(localized: "online", bundle: .l10n) : String(localized: "not on a board you share right now", bundle: .l10n)))
                            .font(Typo.meta).foregroundStyle(best?.state == "live" ? Theme.ok : Theme.muted).lineLimit(2)
                    }
                }
                if let s = agent?.summary, !s.isEmpty {
                    VStack(alignment: .leading, spacing: Space.xxs) {
                        Text("What it knows").font(Typo.section).foregroundStyle(Theme.muted)
                        Text(s).font(Typo.secondary).foregroundStyle(Theme.text)
                    }
                }
                if let caps = agent?.capabilities, !caps.isEmpty {
                    HStack(spacing: Space.xs) { ForEach(caps.prefix(4), id: \.self) { Pill(text: $0) } }
                }
                if let rec = agent?.record, rec.tasksDone + rec.claimsVerified > 0 {
                    Text("\(rec.tasksDone) tasks done · \(rec.claimsVerified) claims verified").font(Typo.micro).foregroundStyle(Theme.faint)
                }
                if name != state.me?.owner || ask != nil {
                    big("Ask \(Vocab.agentOf(name))", "sparkles", primary: false, id: "profile-ask-agent") {
                        if let ask { ask(); return }
                        busy = true
                        Task { if let b = await state.openDirect(name) { open(b) }; busy = false }
                    }
                }
            }
            .padding(Space.m)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(agentFirst ? Theme.accent.opacity(0.08) : Theme.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("profile-agent-section")
        }
    }

    private func rank(_ s: String) -> Int { s == "live" ? 0 : s == "idle" ? 1 : 2 }

    @ViewBuilder private func actions(_ person: Person?) -> some View {
        let rel = person?.relation ?? "none"
        HStack(spacing: Space.s) {
            if rel == "friend" {
                big("Message", "bubble.left.fill", primary: true, id: "person-message") {
                    busy = true
                    Task {
                        if let b = await state.openDirect(name) { open(b) }
                        busy = false
                    }
                }
            } else if rel == "pending_in" || rel == "none" {
                big(rel == "pending_in" ? "Accept friend" : "Add friend", "person.badge.plus", primary: true, id: "person-add") {
                    busy = true
                    Task {
                        if let r = await state.befriend(name) { withAnimation(.smooth) { if p == nil { p = initial }; p?.relation = r } }
                        busy = false
                    }
                }
            } else if rel == "pending_out" {
                big("Request sent", "clock", primary: false, id: "person-pending") {}.disabled(true)
            } else if rel == "blocked" {
                big("Blocked", "hand.raised", primary: false, id: "person-blocked") {}.disabled(true)
            }
        }
    }

    private func big(_ title: LocalizedStringKey, _ icon: String, primary: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Space.s) {
                if busy && primary { ProgressView().tint(Theme.onText) } else { Image(systemName: icon).font(.system(size: 14, weight: .semibold)) }
                Text(title).font(Typo.body.weight(.semibold))
            }
            .frame(maxWidth: .infinity).frame(height: 48)
            .background(primary ? Theme.text : Theme.raised, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .foregroundStyle(primary ? Theme.onText : Theme.muted)
        }
        .buttonStyle(PressStyle())
        .disabled(busy)
        .accessibilityIdentifier(id)
    }
}
