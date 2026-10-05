// The web's newer pieces in the app: a board's SOUL and MEMORY at the top of its info (vedu #1090, #1091/#1092),
// "Remember this" on a message, your agent's name (#1125), your favourite reaction emoji and a searchable picker for
// every other one (#1163), and a short "it worked" line at the top of the screen.

import SwiftUI

extension AppState {
    /// Your reaction row: your favourites, else the server's default preset.
    var favouriteReactions: [String] {
        let r = profile?.reactions ?? []
        return r.isEmpty ? defaultReactions : Array(r.prefix(8))
    }

    /// A board's named agents that "@name" reaches, lowercased name → owner (an ambiguous name needs the owner form).
    func agentNameMap(_ board: String) -> [String: String] {
        Dictionary((agentNames[board] ?? [:]).filter { !$0.value.ambiguous }.map { ($0.value.name.lowercased(), $0.key.lowercased()) }, uniquingKeysWith: { a, _ in a })
    }

    /// A moment's "it worked" line at the top of the screen.
    func say(_ text: String) {
        withAnimation(.snappy) { toast = text }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 2_200_000_000)
            guard let self, self.toast == text else { return }
            withAnimation(.snappy) { self.toast = nil }
        }
    }

    /// Saves your favourite reactions (nil or []: back to the default). Shows at once; back if the server says no.
    func setReactions(_ list: [String]?) async {
        let old = profile
        if var p = profile { p.reactions = list?.isEmpty == false ? list : defaultReactions; profile = p }
        do {
            let value: Any = list ?? NSNull()
            let d = try await API.shared.send("/api/me/profile", body: ["reactions": value], retries: false)
            if let r = try? JSONDecoder.soup.decode(ProfileResponse.self, from: d) { profile = r.profile }
        } catch { profile = old; report(error) }
    }

    /// Names your agent ("Jarvis"), or clears it (nil or ""). Returns what the server said was wrong, or nil.
    func setAgentName(_ name: String?) async -> String? {
        let n = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let value: Any = n.flatMap { $0.isEmpty ? nil : $0 } ?? NSNull()
            let d = try await API.shared.send("/api/me/profile", body: ["agent_name": value], retries: false)
            if let r = try? JSONDecoder.soup.decode(ProfileResponse.self, from: d) { profile = r.profile }
            Haptics.play(.completed)
            return nil
        } catch APIError.server(let m) {
            Haptics.play(.failed)
            return m
        } catch { report(error); return error.localizedDescription }
    }

    // MARK: SOUL and MEMORY

    func soul(_ board: String) async -> Soul? {
        try? await API.shared.get("/api/boards/\(board)/soul", as: SoulResponse.self).soul
    }

    /// Saves the whole SOUL from the version you read. Returns what went wrong (someone saved first: 409), or nil.
    func saveSoul(_ board: String, text: String, base: Int) async -> String? {
        do {
            try await API.shared.send("/api/boards/\(board)/soul", method: "PUT", body: ["text": text, "base_version": base], retries: false)
            Haptics.play(.completed)
            say(String(localized: "Soul saved: agents get the new version", bundle: .l10n))
            return nil
        } catch {
            Haptics.play(.failed)
            return error.localizedDescription
        }
    }

    func memory(_ board: String) async -> MemoryResponse? {
        try? await API.shared.get("/api/boards/\(board)/memory", as: MemoryResponse.self)
    }

    /// "Remember this": a message (by number) or a line you typed, into the board's memory.
    @discardableResult
    func remember(_ seq: Int? = nil, text: String? = nil, in board: String) async -> Bool {
        struct R: Decodable { let duplicate: Bool?; let count: Int? }
        var body: [String: Any] = [:]
        if let seq { body["from"] = seq }
        if let text { body["text"] = text }
        do {
            let d = try await API.shared.send("/api/boards/\(board)/memory", body: body, retries: false)
            let r = try? JSONDecoder.soup.decode(R.self, from: d)
            Haptics.play(.completed)
            say(r?.duplicate == true ? String(localized: "Already remembered", bundle: .l10n) : r?.count.map { String(localized: "Remembered (\($0))", bundle: .l10n) } ?? String(localized: "Remembered", bundle: .l10n))
            NotificationCenter.default.post(name: .memoryChanged, object: board)
            return true
        } catch APIError.server(let m) {
            Haptics.play(.failed)
            error = m.localizedCaseInsensitiveContains("full") ? String(localized: "Memory is full: strike something first.", bundle: .l10n) : m
            return false
        } catch { report(error); return false }
    }

    /// Strikes an item from memory (agents stop reading it).
    func strike(_ item: MemoryItem, in board: String) async -> Bool {
        do {
            try await API.shared.send("/api/boards/\(board)/memory/\(item.id)", method: "DELETE", body: nil, retries: false)
            Haptics.play(.completed)
            say(String(localized: "Struck from memory", bundle: .l10n))
            return true
        } catch { report(error); return false }
    }
}

extension Double {
    /// "just now", "5m ago": a time (ms) as a short phrase in the app's language.
    var agoPhrase: String {
        Date().timeIntervalSince1970 - self / 1000 < 60 ? String(localized: "just now", bundle: .l10n) : String(localized: "\(ago) ago", bundle: .l10n)
    }
}

extension Notification.Name {
    /// Something was remembered on a board (its info sheet refreshes its MEMORY).
    static let memoryChanged = Notification.Name("atteo.memoryChanged")
}

/// The short "it worked" line, over everything at the top.
struct ToastOverlay: ViewModifier {
    @ObservedObject var state: AppState
    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            if let t = state.toast {
                Text(t).font(Typo.secondary.weight(.semibold)).foregroundStyle(Theme.onText)
                    .padding(.horizontal, Space.l).padding(.vertical, Space.s)
                    .background(Theme.text, in: Capsule())
                    .shadow(color: .black.opacity(0.25), radius: 10, y: 3)
                    .padding(.top, Space.s)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .accessibilityIdentifier("toast")
                    .onTapGesture { withAnimation(.snappy) { state.toast = nil } }
            }
        }
    }
}

// MARK: - SOUL and MEMORY in the board's info

/// The board's SOUL (who it is and how it works; people edit it) and MEMORY (facts agents keep; people strike any),
/// at the top of its info. Hidden where the server has neither.
/// What the info sheet loaded of a board's SOUL and MEMORY (nil: the server has none; the section stays hidden).
@MainActor
final class SoulMemoryModel: ObservableObject {
    @Published var soul: Soul?
    @Published var memory: MemoryResponse?
    @Published var editing = false // the SOUL editor is open (presented by the sheet: a List section can't present)
    func load(_ board: String, _ state: AppState) async {
        async let s = state.soul(board)
        async let m = state.memory(board)
        let (ss, mm) = await (s, m)
        withAnimation(.smooth) { soul = ss; memory = mm }
    }
}

struct SoulMemorySections: View {
    @EnvironmentObject var state: AppState
    let board: Board
    @ObservedObject var model: SoulMemoryModel // loaded by the sheet (a List section can't load itself while it's empty)
    private var soul: Soul? { model.soul }
    private var memory: MemoryResponse? { model.memory }
    @State private var expanded = false
    @State private var adding = ""
    @State private var striking: Set<Int> = []
    private var canEdit: Bool { board.archived != true }

    var body: some View {
        Group {
            if let soul {
                Section {
                    // (Empty: just the one row to write it, so what's below stays in view.)
                    if !soul.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(soul.text).font(Typo.secondary).foregroundStyle(Theme.text)
                            .lineLimit(expanded ? nil : 5)
                            .onTapGesture { withAnimation(.snappy) { expanded.toggle() } }
                            .accessibilityIdentifier("soul-text")
                        Text(verbatim: ["v\(soul.version)", soul.updatedBy.map { String(localized: "edited by \($0)", bundle: .l10n) }, soul.updatedAt.map(\.agoPhrase)].compactMap { $0 }.joined(separator: " · "))
                            .font(Typo.micro).foregroundStyle(Theme.faint)
                    }
                    if canEdit {
                        Button { model.editing = true } label: { InfoLabel(soul.text.isEmpty ? "Write who this board is and how you work" : "Edit", "pencil") }
                            .accessibilityIdentifier("soul-edit")
                    }
                } header: { SectionHeader("Soul") }
                .listRowBackground(Theme.card)
            }
            if let memory {
                Section {
                    if memory.items.isEmpty && !canEdit {
                        Text("Nothing yet.").font(Typo.secondary).foregroundStyle(Theme.muted)
                    }
                    ForEach(memory.items) { it in
                        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(it.text).font(Typo.secondary).foregroundStyle(Theme.text)
                                Text(verbatim: [it.who, it.from.map { "#\($0)" }, it.ts.agoPhrase].compactMap { $0 }.joined(separator: " · "))
                                    .font(Typo.micro).foregroundStyle(Theme.faint)
                            }
                            Spacer(minLength: Space.s)
                            if canEdit {
                                Button { strike(it) } label: {
                                    Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.muted)
                                        .frame(width: 28, height: 28).background(Theme.raised, in: Circle())
                                }
                                .buttonStyle(.borderless)
                                .disabled(striking.contains(it.id))
                                .accessibilityLabel("Strike this from memory")
                                .accessibilityIdentifier("memory-strike-\(it.id)")
                            }
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("memory-item-\(it.id)")
                    }
                    if canEdit {
                        HStack(spacing: Space.s) {
                            TextField(memory.items.isEmpty ? "Remember something for the agents…" : "Remember something…", text: $adding)
                                .submitLabel(.done).onSubmit(add)
                                .accessibilityIdentifier("memory-add")
                            if !adding.trimmingCharacters(in: .whitespaces).isEmpty {
                                Button("Add", action: add).fontWeight(.semibold).buttonStyle(.borderless)
                            }
                        }
                    }
                } header: { memory.items.isEmpty ? SectionHeader("Memory") : SectionHeader("Memory · \(memory.items.count)/\(memory.max ?? 50)") }
                .listRowBackground(Theme.card)
            }
        }
    }

    private func load() async { await model.load(board.id, state) }

    private func add() {
        let t = adding.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        Task { if await state.remember(text: t, in: board.id) { adding = "" } }
    }

    private func strike(_ it: MemoryItem) {
        striking.insert(it.id)
        Task {
            if await state.strike(it, in: board.id) { withAnimation(.smooth) { model.memory = memory.map { MemoryResponse(items: $0.items.filter { $0.id != it.id }, max: $0.max) } } }
            striking.remove(it.id)
        }
    }
}

/// Writing the board's SOUL: the whole text, saved from the version you opened (someone saving first says so).
struct SoulEditor: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    let board: String
    let soul: Soul
    let saved: () -> Void
    @State private var text = ""
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Space.s) {
                Text("Who this board is and how you work. Every agent reads it when it joins, and again when it changes. Only people can edit it.")
                    .font(Typo.meta).foregroundStyle(Theme.muted)
                TextEditor(text: $text)
                    .font(Typo.mono(.callout))
                    .scrollContentBackground(.hidden)
                    .padding(Space.s)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                    .accessibilityIdentifier("soul-editor")
                if let problem { Text(problem).font(Typo.meta).foregroundStyle(Theme.danger).accessibilityIdentifier("soul-error") }
            }
            .padding(Space.l)
            .background(Theme.bg)
            .navigationTitle("Soul")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() }.toolbarText() }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { save() } label: { if busy { ProgressView() } else { Text("Save") } }
                        .toolbarText(primary: true).disabled(busy || text == soul.text)
                        .accessibilityIdentifier("soul-save")
                }
            }
            .onAppear { text = soul.text }
        }
    }

    private func save() {
        busy = true
        problem = nil
        Task {
            let failed = await state.saveSoul(board, text: text, base: soul.version)
            busy = false
            if let failed { problem = failed } else { saved(); dismiss() }
        }
    }
}

// MARK: - Every emoji, searchable

/// Every emoji the system draws, with its Unicode name for search ("fire", "thumbs up").
enum EmojiCatalog {
    /// The ones people reach for, first (then everything else in Unicode's order).
    static let common = ["👍", "👎", "❤️", "🔥", "🎉", "😂", "😮", "😢", "🙏", "👏", "💯", "✅", "❌", "👀", "🚀", "🤔",
                         "😅", "🙌", "💡", "⚠️", "🐛", "🔧", "📌", "⏳", "🫡", "😍", "🤝", "💪", "👌", "😬", "🙃", "✨"]
    static let all: [(emoji: String, name: String)] = {
        var out: [(String, String)] = []
        let named: (String) -> String = { e in e.unicodeScalars.first?.properties.name?.lowercased() ?? "" }
        for e in common { out.append((e, named(e))) }
        let ranges: [ClosedRange<UInt32>] = [0x1F600...0x1F64F, 0x1F44D...0x1F4FF, 0x1F300...0x1F44C, 0x1F680...0x1F6FF, 0x1F90C...0x1F9FF, 0x1FA70...0x1FAFF, 0x2600...0x27BF]
        for r in ranges {
            for v in r {
                guard let s = Unicode.Scalar(v), s.properties.isEmojiPresentation, let name = s.properties.name, !common.contains(String(s)) else { continue }
                out.append((String(s), name.lowercased()))
            }
        }
        // A few common ones drawn as emoji only with the variation selector.
        for (e, n) in [("✔️", "check mark"), ("☀️", "sun"), ("✌️", "victory hand"), ("☺️", "smiling face")] where !out.contains(where: { $0.0 == e }) { out.append((e, n)) }
        return out
    }()

    static func search(_ q: String) -> [String] {
        let q = q.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return all.map(\.emoji) }
        return all.filter { $0.name.contains(q) || $0.emoji == q }.map(\.emoji)
    }
}

/// The full emoji picker behind "+": your favourites first, a search field, and every emoji in a grid.
struct EmojiPicker: View {
    @EnvironmentObject var state: AppState
    var title: LocalizedStringKey = "React"
    let pick: (String) -> Void
    @State private var query = ""

    var body: some View {
        let found = EmojiCatalog.search(query)
        VStack(alignment: .leading, spacing: Space.s) {
            Text(title).font(Typo.section).foregroundStyle(Theme.muted)
            HStack(spacing: Space.s) {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.faint)
                TextField("Search emoji", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("emoji-search")
            }
            .padding(.horizontal, Space.m).frame(height: 38)
            .background(Theme.raised, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            ScrollView {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Space.xs), count: 8), alignment: .leading, spacing: Space.xs) {
                    if query.isEmpty {
                        ForEach(state.favouriteReactions, id: \.self) { e in cell(e, id: "fav") }
                    }
                    ForEach(found, id: \.self) { e in cell(e, id: "emoji") }
                }
                if found.isEmpty { Text("No emoji match “\(query)”.").font(Typo.secondary).foregroundStyle(Theme.muted).padding(.top, Space.s) }
            }
        }
        .padding(Space.l)
    }

    private func cell(_ e: String, id: String) -> some View {
        Button { pick(e) } label: { Text(e).font(Typo.ui(.title2)).frame(maxWidth: .infinity, minHeight: 40).contentShape(Rectangle()) }
            .buttonStyle(PressStyle())
            .accessibilityIdentifier("\(id)-\(e)")
    }
}

// MARK: - Settings: your agent's name

/// What you call your agent ("Jarvis"), saved when you're done typing; what the server won't take says why, right here.
/// It always shows with you as its owner: "Jarvis · vedu's agent".
struct AgentNameField: View {
    @EnvironmentObject var state: AppState
    @State private var name = ""
    @State private var problem: String?
    @State private var loaded = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xxs) {
            TextField("Name your agent (Jarvis, Friday…)", text: $name)
                .textInputAutocapitalization(.words).autocorrectionDisabled()
                .submitLabel(.done).focused($focused)
                .onSubmit(save)
                .accessibilityIdentifier("agent-name")
            if let problem {
                Text(problem).font(Typo.meta).foregroundStyle(Theme.danger).accessibilityIdentifier("agent-name-error")
            } else if let n = state.profile?.agentName, !n.isEmpty, let me = state.me?.owner {
                Text("Shows as “\(agentLabel(me, n))”").font(Typo.micro).foregroundStyle(Theme.faint)
            }
        }
        .onChange(of: focused) { _, f in if !f { save() } }
        .onChange(of: state.profile?.agentName) { _, n in if !focused { name = n ?? "" } }
        .onAppear { if !loaded { loaded = true; name = state.profile?.agentName ?? "" } }
        .onDisappear { if focused || name != (state.profile?.agentName ?? "") { save() } }
    }

    private func save() {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard n != (state.profile?.agentName ?? "") else { problem = nil; return }
        Task {
            let failed = await state.setAgentName(n)
            withAnimation(.smooth) { problem = failed }
        }
    }
}

// MARK: - Settings: your favourite reactions

/// Pick and order the emoji on your reaction row (up to 8): drag to reorder, swipe to remove, + to add, Reset for the
/// default. Saved to your account, so the web uses them too.
struct FavouriteReactionsEditor: View {
    @EnvironmentObject var state: AppState
    @State private var list: [String] = []
    @State private var picking = false

    var body: some View {
        List {
            Section {
                ForEach(list, id: \.self) { e in
                    HStack { Text(e).font(Typo.ui(.title3)); Spacer() }
                        .accessibilityIdentifier("favourite-\(e)")
                }
                .onMove { from, to in list.move(fromOffsets: from, toOffset: to); save() }
                .onDelete { at in guard list.count - at.count >= 1 else { return }; list.remove(atOffsets: at); save() }
                if list.count < 8 {
                    Button { picking = true } label: { InfoLabel("Add an emoji", "plus") }
                        .accessibilityIdentifier("favourite-add")
                }
            } footer: { Text("Up to 8, in the order they show when you hold a message. Saved to your account, so the web uses them too.") }
            .listRowBackground(Theme.card)
            Section {
                Button("Reset to the default") { list = defaultReactions; Task { await state.setReactions(nil) } }
                    .foregroundStyle(Theme.text)
                    .accessibilityIdentifier("favourite-reset")
            }
            .listRowBackground(Theme.card)
        }
        .environment(\.editMode, .constant(.active))
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .navigationTitle("Reactions")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { list = state.favouriteReactions }
        .sheet(isPresented: $picking) {
            EmojiPicker(title: "Add to your reactions") { e in
                picking = false
                if !list.contains(e) && list.count < 8 { list.append(e); save() }
            }
            .presentationDetents([.medium, .large]).presentationBackground(Theme.card)
        }
    }

    private func save() { let l = list; Task { await state.setReactions(l) } }
}
