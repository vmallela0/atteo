// Everyday's Settings (ios/qa/design/everyday, `settings` and `advanced`): your assistant, notifications, privacy,
// appearance, haptics & effects, then "Advanced (for developers)": the Developer mode switch, what it shows, and every
// other setting (Developer mode's full list, as today).

import SwiftUI

struct EverydaySettings: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.closeSettings) private var closeSettings // in the drawer: Done closes it
    @Environment(\.chatDensity) private var density
    @State private var bring = false
    @State private var confirmSignOut = false

    private var chats: Int { state.boards.filter { $0.archived != true && !$0.isAgentChat }.count }
    /// Your assistant's name: the app it runs in ("Grok"), when it isn't a coding tool.
    private var provider: String? {
        guard let c = state.sessions.first?.client, !AppMode.isCodingAgent(c) else { return nil }
        return AppMode.clientName(c)
    }

    var body: some View { screen.onAppear { Analytics.screen("settings") } } // product analytics (Analytics.swift)

    @ViewBuilder private var screen: some View {
        List {
            Section {
                HStack(spacing: Space.m) {
                    Avatar(name: state.me?.owner ?? "", size: 52)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(state.displayName(for: state.me?.owner ?? "")).font(Typo.ui(.title3).weight(.semibold)).foregroundStyle(Theme.text)
                        Text("\(chats) chats").font(Typo.secondary).foregroundStyle(Theme.muted)
                    }
                }
                .padding(.vertical, Space.xs)
            }
            .listRowBackground(Color.clear)

            Section {
                Button { bring = true } label: {
                    HStack(spacing: Space.m) {
                        AtteoMark(size: 34)
                        VStack(alignment: .leading, spacing: 2) {
                            (provider.map { Text(verbatim: $0) } ?? Text("Your assistant")).font(Typo.body).foregroundStyle(Theme.text)
                            (state.sessions.isEmpty ? Text("Not connected yet") : Text("Connected · in \(chats) chats"))
                                .font(Typo.secondary).foregroundStyle(Theme.muted)
                        }
                        Spacer(minLength: Space.s)
                        Text(state.sessions.isEmpty ? "Connect" : "Change").font(Typo.body).foregroundStyle(Theme.muted)
                        Image(systemName: "chevron.right").font(Typo.ui(.footnote).weight(.semibold)).foregroundStyle(Theme.faint)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("your-assistant")
            } header: { SectionHeader("Your assistant") } footer: {
                Text("It asks you before it pays, books, sends something for you, or shares a file.")
            }
            .listRowBackground(Theme.card)

            ReportBugRow() // Report a bug (ReportBug.swift), where it's easy to find
            FeedbackRow() // Send feedback to the Atteo team (Feedback.swift, vedu #4125)
            LegalRow() // Privacy Policy + Terms (LegalRow.swift, App Review 5.1.1(i))
            SafetySection() // hide offensive words, the xAI voice consent (Moderation.swift, App Review 1.2 / 5.1.2(i))
            DeleteAccountRow() // Delete account (DeleteAccount.swift, App Review 5.1.1(v))

            NotificationsSection()

            Section {
                NavigationLink { AssistantRemembers() } label: { Text("What my assistant remembers") }
                    .accessibilityIdentifier("assistant-remembers")
                NavigationLink { WhoCanAddMe() } label: {
                    HStack {
                        Text("Who can add me to chats")
                        Spacer()
                        Text(WhoCanAddMe.summary(state.profile)).foregroundStyle(Theme.muted)
                    }
                }
                .accessibilityIdentifier("who-can-add-me")
            } header: { SectionHeader("Privacy") }
            .listRowBackground(Theme.card)

            Section {
                picker("Theme", id: "display-theme", \.theme, [("light", "Bright"), ("dark", "Dark"), ("system", "Phone")])
                picker("Text size", id: "display-text", \.text, [("s", "S"), ("m", "M"), ("l", "L")])
                // Replies only in their thread (vedu #2360): the chat shows "N replies" under the message instead.
                Toggle("Keep replies in their thread", isOn: Binding(get: { state.display.repliesInThread }, set: { on in
                    var d = state.display
                    d.replies = on ? "thread" : "chat"
                    state.setDisplay(d)
                }))
                .tint(Theme.accent)
                .accessibilityIdentifier("display-replies")
                LanguagePicker()
            } header: { SectionHeader("Appearance") }
            .listRowBackground(Theme.card)

            FeelSection()
            TalkSection() // voice chat (TalkView.swift)

            GuideRow() // What Atteo can do (GuideLink.swift)

            DeveloperModeSection()

            Section {
                Button("Sign out", role: .destructive) { confirmSignOut = true }.foregroundStyle(Theme.danger)
            }
            .listRowBackground(Theme.card)
        }
        .listSectionSpacing(.compact)
        .listDensity(density)
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { if let closeSettings { closeSettings() } else { dismiss() } }.toolbarText(primary: true) } }
        .sheet(isPresented: $bring) { BringAssistantView(firstRun: false).presentationBackground(Theme.bg) }
        .confirmationDialog("Sign out of Atteo on this phone?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { state.signOut() }
        } message: { Text("Your assistant keeps running. Sign back in any time.") }
        .task { await state.loadSettings() }
    }

    private func picker(_ title: LocalizedStringKey, id: String, _ key: WritableKeyPath<DisplayPrefs, String>, _ options: [(value: String, label: LocalizedStringKey)]) -> some View {
        HStack {
            Text(title)
            Spacer(minLength: Space.m)
            Picker(title, selection: Binding(get: { state.display[keyPath: key] }, set: { v in
                var d = state.display
                d[keyPath: key] = v
                state.setDisplay(d)
            })) {
                ForEach(options, id: \.value) { Text($0.label).tag($0.value) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .accessibilityIdentifier(id)
        }
    }
}

/// "Advanced (for developers)": the Developer mode switch, what it turns on, and (in Everyday) every other setting.
struct DeveloperModeSection: View {
    @ObservedObject private var mode = AppMode.shared
    @State private var on = AppMode.shared.developer

    var body: some View {
        Section {
            Toggle(isOn: Binding(get: { on }, set: { v in
                on = v
                // The switch slides first; then the app changes around it (Settings closes onto the other face).
                Task { try? await Task.sleep(nanoseconds: 350_000_000); mode.set(developer: v) }
            })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Developer mode")
                    Text("Tasks, change cards, #numbers. Turns on by itself if you connect Claude Code or Codex.")
                        .font(Typo.secondary).foregroundStyle(Theme.muted)
                }
            }
            .tint(Theme.accent)
            .accessibilityIdentifier("developer-mode")
            NavigationLink { AdvancedView() } label: { Text("What Developer mode shows") }
                .accessibilityIdentifier("advanced")
            if mode.everyday {
                NavigationLink { FullSettings(embedded: true) } label: { Text("More settings") }
                    .accessibilityIdentifier("more-settings")
            }
        } header: { SectionHeader("Advanced (for developers)") }
        .listRowBackground(Theme.card)
    }
}

/// What Developer mode turns on, why it's on, and connecting any agent.
struct AdvancedView: View {
    @ObservedObject private var mode = AppMode.shared
    @State private var connect = false

    private let shows: [(LocalizedStringKey, LocalizedStringKey)] = [
        ("Change cards", "Branch, CI, PR, commits, files, diff"),
        ("Tasks and claims", "Instead of plain to-dos; the work strip and Tasks"),
        ("Approval details", "The exact command, risk, and the board it came from"),
        ("Message numbers and sessions", "#412, sam/claude-2, the client each agent runs in"),
        ("Agent files", "MEMORY.md, PROTOCOL.md"),
    ]

    var body: some View {
        List {
            Section {
                Toggle(isOn: Binding(get: { mode.developer }, set: { mode.set(developer: $0) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Developer mode").font(Typo.body.weight(.semibold))
                        Text("Everything Atteo shows today, for people who build with agents.").font(Typo.secondary).foregroundStyle(Theme.muted)
                    }
                }
                .tint(Theme.accent)
                .accessibilityIdentifier("advanced-developer-mode")
            } footer: {
                if let r = mode.autoReason {
                    Label("Turned on by itself when you connected \(r.client), \(Date(timeIntervalSince1970: r.at / 1000).formatted(.dateTime.month(.abbreviated).day())). Codex does the same. Turn it off any time.", systemImage: "bolt")
                } else {
                    Label("Turns on by itself when you connect a coding agent (Claude Code, Codex). Turn it off any time.", systemImage: "bolt")
                }
            }
            .listRowBackground(Theme.card)

            Section {
                ForEach(shows.indices, id: \.self) { i in
                    let s = shows[i]
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.0)
                        Text(s.1).font(Typo.secondary).foregroundStyle(Theme.muted)
                    }
                }
                Button { connect = true } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Connect any agent").foregroundStyle(Theme.text)
                            Text("MCP link, CLI setup").font(Typo.secondary).foregroundStyle(Theme.muted)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(Typo.ui(.footnote).weight(.semibold)).foregroundStyle(Theme.faint)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("connect-any-agent")
            } header: { SectionHeader("Developer mode shows") } footer: {
                Text("Everyone else in your chats keeps their own setting. You see the details; they keep seeing plain results.")
            }
            .listRowBackground(Theme.card)
        }
        .listSectionSpacing(.compact)
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .navigationTitle("Advanced")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $connect) { ConnectSteps(provider: .coding).presentationDetents([.medium, .large]).presentationBackground(Theme.bg) }
    }
}

/// Privacy → Who can add me to chats: what you accept without being asked (your profile's rules).
struct WhoCanAddMe: View {
    @EnvironmentObject var state: AppState
    @State private var draft: Profile?

    static func summary(_ p: Profile?) -> String {
        guard let r = p?.rules else { return "" }
        return r.autoAcceptInvites != nil || r.autoAcceptFriends != nil || r.autoAcceptAgents != nil ? String(localized: "People I know", bundle: .l10n) : String(localized: "Ask me first", bundle: .l10n)
    }

    var body: some View {
        List {
            if let d = Binding($draft) {
                Section {
                    Toggle("Friends can add me to chats", isOn: rule(d.rules.autoAcceptInvites, "friends")).tint(Theme.accent)
                    Toggle("Coworkers can add me as a friend", isOn: rule(d.rules.autoAcceptFriends, "coworkers")).tint(Theme.accent)
                    Toggle("Coworkers' assistants can talk to mine", isOn: rule(d.rules.autoAcceptAgents, "coworkers")).tint(Theme.accent)
                } footer: { Text("Anyone else asks you first, on For you.") }
                .listRowBackground(Theme.card)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .navigationTitle("Who can add me")
        .navigationBarTitleDisplayMode(.inline)
        .task { draft = state.profile }
        .onDisappear {
            if let p = draft, p.rules != state.profile?.rules, var cur = state.profile {
                cur.rules = p.rules
                Task { await state.saveProfile(cur) }
            }
        }
    }

    private func rule(_ value: Binding<String?>, _ on: String) -> Binding<Bool> {
        Binding(get: { value.wrappedValue == on }, set: { value.wrappedValue = $0 ? on : nil })
    }
}

/// Privacy → What my assistant remembers: each chat's notes for assistants (its MEMORY and rules), to read or change.
struct AssistantRemembers: View {
    @EnvironmentObject var state: AppState
    var body: some View {
        List {
            Section {
                let list = state.boards.filter { $0.archived != true && !$0.isAgentChat && $0.encrypted != true }
                if list.isEmpty { Text("Nothing yet.").foregroundStyle(Theme.muted) }
                ForEach(list) { b in
                    NavigationLink { ChatMemory(board: b) } label: {
                        HStack(spacing: Space.m) { BoardPicture(board: b, size: 28); Text(state.displayName(for: b)) }
                    }
                }
            } footer: { Text("What assistants keep in mind in each chat. Everyone in the chat can see it.") }
            .listRowBackground(Theme.card)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .navigationTitle("What it remembers")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct ChatMemory: View {
    @EnvironmentObject var state: AppState
    let board: Board
    @StateObject private var model = MemoryModel()
    var body: some View {
        List { MemorySection(board: board, model: model) }
            .listSectionSpacing(.compact)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle(state.displayName(for: board))
            .navigationBarTitleDisplayMode(.inline)
            .task { await model.load(board.id, state) }
    }
}
