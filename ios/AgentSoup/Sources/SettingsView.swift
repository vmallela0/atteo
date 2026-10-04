// You and your agent: pictures, name, bio, what your agent is known for, what you accept automatically, everything
// that can act as you (revoke any of it), and sign out. Edits save when you leave.

import PhotosUI
import SwiftUI

/// Settings: Everyday's short list (EverydaySettings.swift), or, in Developer mode, everything (as today), with the
/// Developer mode switch at the bottom.
struct SettingsView: View {
    var body: some View {
        NavigationStack {
            if Vocab.everyday { EverydaySettings() } else { FullSettings() }
        }
    }
}

/// Every setting (Developer mode's Settings; Everyday's "More settings").
struct FullSettings: View {
    /// Pushed from Everyday's Settings: no Developer mode switch here (it's on the page before).
    var embedded = false
    init(embedded: Bool = false) { self.embedded = embedded }
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.chatDensity) private var density
    @State private var draft: Profile?
    @State private var summary = ""
    @State private var agentListed = false
    @State private var loadedAgent = false
    @State private var confirmSignOut = false

    var body: some View {
        List {
            Section { pictures }
                .listRowBackground(Color.clear)

            if let d = Binding($draft) {
                Section {
                    TextField(state.me?.owner ?? "Name", text: Binding(get: { d.wrappedValue.displayName ?? "" }, set: { d.wrappedValue.displayName = $0 }))
                        .accessibilityIdentifier("display-name")
                    TextField("A line about you", text: Binding(get: { d.wrappedValue.bio ?? "" }, set: { d.wrappedValue.bio = $0 }), axis: .vertical)
                        .lineLimit(1...4)
                    Toggle("Show me in People", isOn: d.listed).tint(Theme.accent)
                } header: { SectionHeader("You") }
                .listRowBackground(Theme.card)
            }

            Section {
                AgentNameField()
                TextField("What your agent knows (Stripe, our checkout repo…)", text: $summary, axis: .vertical)
                    .lineLimit(1...4)
                    .accessibilityIdentifier("agent-summary")
                Toggle("Others can find your agent", isOn: $agentListed).tint(Theme.accent)
            } header: { SectionHeader("Your agent") } footer: {
                Text("Listed agents show up when other people's agents look for help. They still need your OK to start a conversation.")
            }
            .listRowBackground(Theme.card)

            if let d = Binding($draft) {
                Section {
                    Toggle("Board invites from friends", isOn: rule(d.rules.autoAcceptInvites, "friends")).tint(Theme.accent)
                    Toggle("Friend requests from coworkers", isOn: rule(d.rules.autoAcceptFriends, "coworkers")).tint(Theme.accent)
                    Toggle("Agents from coworkers", isOn: rule(d.rules.autoAcceptAgents, "coworkers")).tint(Theme.accent)
                } header: { SectionHeader("Accept automatically") }
                .listRowBackground(Theme.card)
            }

            Section {
                displayPicker("Text size", id: "display-text", \.text, [("s", "S"), ("m", "M"), ("l", "L")])
                displayPicker("Density", id: "display-density", \.density, [("comfortable", "Comfortable"), ("compact", "Compact")])
                displayPicker("Theme", id: "display-theme", \.theme, [("system", "System"), ("light", "Light"), ("dark", "Dark")])
            } header: { SectionHeader("Display") } footer: {
                Text("Text size adds to your iPhone's own setting. Saved to your account, so the web follows it too.")
            }
            .listRowBackground(Theme.card)

            Section {
                NavigationLink { FavouriteReactionsEditor() } label: {
                    HStack {
                        Text("Reactions")
                        Spacer()
                        Text(state.favouriteReactions.joined()).lineLimit(1).foregroundStyle(Theme.muted)
                    }
                }
                .accessibilityIdentifier("favourite-reactions")
            } footer: { Text("The emoji you see first when you hold a message.") }
            .listRowBackground(Theme.card)

            NotificationsSection()
            FeelSection()
            VoiceSection()
            TalkSection() // voice chat (TalkView.swift)

            Section {
                if state.connections.isEmpty { Text("Nothing connected yet.").foregroundStyle(Theme.muted) }
                ForEach(state.connections) { c in
                    ConnectionRow(c: c)
                        .swipeActions { Button("Revoke", role: .destructive) { Haptics.play(.warning); Task { await state.revoke(c) } } }
                }
            } header: { SectionHeader("Connected") } footer: { Text("Everything that can act as you. Swipe to revoke one; it stops at once.") }
            .listRowBackground(Theme.card)

            // Everyday or Developer mode (Everyday.swift): the switch, last before signing out.
            if !embedded { DeveloperModeSection() }

            Section {
                Button("Sign out", role: .destructive) { confirmSignOut = true }.foregroundStyle(Theme.danger)
            }
            .listRowBackground(Theme.card)
        }
        .listSectionSpacing(.compact)
        .listDensity(density)
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .navigationTitle(embedded ? "More settings" : "Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.toolbarText(primary: true) } }
        .confirmationDialog("Sign out of Atteo on this phone?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { state.signOut() }
        } message: { Text("Your agents keep running. Sign back in any time.") }
        .task {
            draft = state.profile
            if let me = state.me { summary = me.summary ?? ""; agentListed = me.listed ?? false; loadedAgent = true }
            await state.loadSettings()
            if draft == nil { draft = state.profile }
            if !loadedAgent, let me = state.me { summary = me.summary ?? ""; agentListed = me.listed ?? false; loadedAgent = true }
        }
        .onDisappear { saveIfChanged() }
    }

    /// Your picture and your agent's, side by side; tap either to choose a photo.
    private var pictures: some View {
        HStack(spacing: 32) {
            Spacer(minLength: 0)
            PictureButton(name: state.me?.owner ?? "", agent: false, caption: "You")
            PictureButton(name: state.me?.owner ?? "", agent: true, caption: "Your agent")
            Spacer(minLength: 0)
        }
        .padding(.vertical, 0)
    }

    /// One display setting: its name over a segmented control. A change applies at once and is saved to your profile.
    private func displayPicker(_ title: String, id: String, _ key: WritableKeyPath<DisplayPrefs, String>, _ options: [(value: String, label: String)]) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text(title).font(Typo.secondary).foregroundStyle(Theme.muted)
            Picker(title, selection: Binding(get: { state.display[keyPath: key] }, set: { v in
                var d = state.display
                d[keyPath: key] = v
                state.setDisplay(d)
            })) {
                ForEach(options, id: \.value) { Text($0.label).tag($0.value) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityIdentifier(id)
        }
        .padding(.vertical, Space.row(density) / 2)
    }

    private func rule(_ value: Binding<String?>, _ on: String) -> Binding<Bool> {
        Binding(get: { value.wrappedValue == on }, set: { value.wrappedValue = $0 ? on : nil })
    }

    private func saveIfChanged() {
        let p = draft, old = state.profile
        let s = summary.trimmingCharacters(in: .whitespacesAndNewlines), l = agentListed
        let agentChanged = loadedAgent && (s != (state.me?.summary ?? "") || l != (state.me?.listed ?? false))
        Task {
            // Display settings save as you change them; only the rest of the profile is compared here.
            // (So are your agent's name and your reactions.)
            if var p { p.display = old?.display; p.agentName = old?.agentName; p.reactions = old?.reactions; if p != old { await state.saveProfile(p) } }
            if agentChanged { await state.saveAgent(summary: s, listed: l) }
        }
    }
}

/// A big avatar you tap to replace (or long-press to remove).
private struct PictureButton: View {
    @EnvironmentObject var state: AppState
    let name: String
    let agent: Bool
    let caption: String
    @State private var item: PhotosPickerItem?
    @State private var busy = false
    @State private var cropping: CropRequest?
    @State private var saving = false

    var body: some View {
        VStack(spacing: 8) {
            PhotosPicker(selection: $item, matching: .images) {
                Avatar(name: name, agent: agent, size: 64)
                    .overlay { if busy { ProgressView().tint(Theme.text) } }
                    .overlay(alignment: .bottomTrailing) {
                        Image(systemName: "camera.fill").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.bg)
                            .padding(6).background(Theme.text, in: Circle()).offset(x: 4, y: 4)
                    }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(agent ? "Change your agent's picture" : "Change your picture")
            .contextMenu {
                Button("Remove picture", systemImage: "trash", role: .destructive) { Task { await state.setAvatar(nil, agent: agent) } }
            }
            Text(caption).font(.caption).foregroundStyle(Theme.muted)
        }
        .onChange(of: item) { _, it in
            guard let it else { return }
            busy = true
            Task {
                // Crop and touch it up first (#1001), then save.
                if let data = try? await it.loadTransferable(type: Data.self), let img = UIImage(data: data) { cropping = CropRequest(image: img.uprightAndSmall()) }
                else { busy = false }
                item = nil
            }
        }
        .sheet(item: $cropping, onDismiss: { if !saving { busy = false } }) { c in
            PictureEditor(image: c.image, round: !agent, side: 320) { jpeg in
                cropping = nil
                guard let jpeg else { busy = false; return }
                saving = true
                Task { await state.setAvatar(jpeg, agent: agent); busy = false; saving = false }
            }
            .presentationBackground(Theme.bg)
        }
    }
}

/// The middle square of a photo, 320 px, as JPEG (well under the server's 200 KB).
func squareJPEG(_ data: Data, side: CGFloat = 320) -> Data? {
    guard let img = UIImage(data: data) else { return nil }
    let s = min(img.size.width, img.size.height)
    let scale = side / s
    let size = CGSize(width: img.size.width * scale, height: img.size.height * scale)
    let format = UIGraphicsImageRendererFormat(); format.scale = 1
    let out = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
        img.draw(in: CGRect(x: (side - size.width) / 2, y: (side - size.height) / 2, width: size.width, height: size.height))
    }
    return out.jpegData(compressionQuality: 0.82)
}

private struct ConnectionRow: View {
    let c: Connection
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.m) {
            Image(systemName: icon).font(.system(size: 15)).foregroundStyle(Theme.muted).frame(width: 22).onFirstLine()
            VStack(alignment: .leading, spacing: 2) {
                Text(c.label ?? "Connection").font(.subheadline.weight(.medium)).foregroundStyle(Theme.text).lineLimit(1)
                Text(c.lastUsed.map { "used \($0.ago) ago".replacingOccurrences(of: "now ago", with: "just now") } ?? "never used").font(.caption).foregroundStyle(Theme.faint)
            }
        }
    }
    private var icon: String {
        switch c.kind {
        case "app": return "iphone" // the Atteo app
        case "cli": return "sparkles" // an agent: the CLI or an MCP connection (Claude, Cursor…)
        default: return "key" // a personal token
        }
    }
}
