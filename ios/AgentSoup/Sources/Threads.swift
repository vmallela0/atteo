// Threads, like iMessage (jxn #1040, vedu #1051): a reply lands in the chat like any message, under a small bar quoting
// what it answers, and the message it answers says "3 replies · 4m ›". Tapping either slides the thread up over the
// chat: the message, every answer under it, and the same message box as the chat (jxn #1094). The chat's top bar lists
// every thread here, newest first, with a dot on those with answers you haven't seen.

import SwiftUI

// MARK: - What's a thread

/// A thread: its root (the message everything answers), every answer under it in order, and when it last moved.
struct ThreadSummary: Identifiable, Hashable {
    let root: Int
    let rootEntry: Entry? // nil when the root is further back than what's loaded
    let replies: [Entry]
    var id: Int { root }
    var last: Double { replies.last?.ts ?? rootEntry?.ts ?? 0 }
    var lastReply: Int { replies.last?.seq ?? 0 }
}

enum ThreadIndex {
    /// The top of an answer's chain (what its thread is about), as far as it's loaded.
    static func root(of e: Entry, in bySeq: [Int: Entry]) -> Int {
        var cur = e, hops = 0
        while let p = cur.replyTo, hops < 50 {
            guard let up = bySeq[p] else { return p }
            cur = up; hops += 1
        }
        return cur.seq
    }

    /// Every thread in what's loaded (answers that weren't unsent, grouped under their root), newest activity first.
    static func threads(_ entries: [Entry]) -> [ThreadSummary] {
        let bySeq = Dictionary(entries.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })
        let gone = Set(entries.compactMap(\.retracts))
        let answers = entries.filter { $0.replyTo != nil && $0.retracts == nil && $0.seq > 0 && !gone.contains($0.seq) }
        return Dictionary(grouping: answers, by: { root(of: $0, in: bySeq) })
            .map { ThreadSummary(root: $0.key, rootEntry: bySeq[$0.key], replies: $0.value.sorted { $0.seq < $1.seq }) }
            .sorted { $0.last > $1.last }
    }
}

/// Which answers you've seen in each thread (kept on this phone): a thread with newer answers from others has a dot.
@MainActor
final class ThreadSeen: ObservableObject {
    static let shared = ThreadSeen()
    @Published private var marks: [String: [String: Int]] // board → root → the last answer you've seen
    private init() { marks = (UserDefaults.standard.dictionary(forKey: "threadSeen") as? [String: [String: Int]]) ?? [:] }

    private func persist() { UserDefaults.standard.set(marks, forKey: "threadSeen") }

    /// The first time this phone sees a board's threads, what's there already counts as seen (no wall of dots).
    func baseline(_ board: String, _ threads: [ThreadSummary]) {
        guard marks[board] == nil, !threads.isEmpty else { return }
        marks[board] = Dictionary(uniqueKeysWithValues: threads.map { (String($0.root), $0.lastReply) })
        persist()
    }

    func seen(_ board: String, root: Int, through seq: Int) {
        guard seq > (marks[board]?[String(root)] ?? 0) else { return }
        marks[board, default: [:]][String(root)] = seq
        persist()
    }

    /// Answers from someone else after the last one you saw.
    func unread(_ board: String, _ t: ThreadSummary, me: String?) -> Bool {
        let mark = marks[board]?[String(t.root)] ?? 0
        return t.replies.contains { $0.seq > mark && !($0.author == me && $0.via != "agent") }
    }
}

extension String {
    /// The message as styled text. "#123" (a message on this board; agents write and read the numbers) shows as a
    /// small link with that message's title, "↗ Guard empty carts", that opens it: people never need the numbers
    /// (#675, like the web). Never inside code or a link.
    func mdLinked(_ title: (Int) -> String? = { _ in nil }) -> AttributedString {
        let src = md
        let plain = String(src.characters)
        let ns = plain as NSString
        var out = AttributedString()
        var cursor = src.startIndex
        for m in Self.entryRE.matches(in: plain, range: NSRange(location: 0, length: ns.length)) {
            guard let n = Int(ns.substring(with: m.range(at: 2))), let r = Range(m.range(at: 1), in: src), r.lowerBound >= cursor else { continue }
            if src[r].runs.contains(where: { $0.link != nil || $0.inlinePresentationIntent?.contains(.code) == true }) { continue }
            out += src[cursor..<r.lowerBound]
            var chip = AttributedString("↗ " + (title(n) ?? String(localized: "an earlier message", bundle: .l10n)))
            chip.link = URL(string: "atteo-entry://\(n)")
            chip.foregroundColor = Theme.text
            chip.backgroundColor = Theme.raised
            out += chip
            cursor = r.upperBound
        }
        out += src[cursor...]
        return out
    }
    fileprivate static let entryRE = try! NSRegularExpression(pattern: "(?<![\\w&/#])(#(\\d{1,7}))\\b")

    /// A plain line (a quote bar, a thread's row) with each "#123" read as "↗ <its title>", like mdLinked's chips:
    /// people never see message numbers (#675).
    func plainRefs(_ title: (Int) -> String? = { _ in nil }) -> String {
        guard contains("#") else { return self }
        let ns = self as NSString
        var out = "", cursor = 0
        for m in Self.entryRE.matches(in: self, range: NSRange(location: 0, length: ns.length)) {
            guard let n = Int(ns.substring(with: m.range(at: 2))) else { continue }
            out += ns.substring(with: NSRange(location: cursor, length: m.range(at: 1).location - cursor))
            out += "↗ " + (title(n) ?? String(localized: "an earlier message", bundle: .l10n))
            cursor = m.range(at: 1).location + m.range(at: 1).length
        }
        return out + ns.substring(from: cursor)
    }
}

/// What a "#123" in text is called here (its title, a few words), for the chips mdLinked makes. The chat and its
/// threads set it from what's loaded; elsewhere a number reads "an earlier message". Equatable, so rows only redraw
/// when a title actually changes.
struct RefTitles: Equatable, Sendable {
    var map: [Int: String] = [:]
    func callAsFunction(_ n: Int) -> String? { map[n] }
}
extension RefTitles {
    /// Only the titles these texts refer to ("#123"). A chat row holds just its own: the chat's whole map changes with
    /// every message that arrives, and every row reading it was made again each time (jxn #4181).
    func only(_ texts: String?...) -> RefTitles {
        var out: [Int: String] = [:]
        for case let t? in texts where t.contains("#") {
            let ns = t as NSString
            for m in String.entryRE.matches(in: t, range: NSRange(location: 0, length: ns.length)) {
                if let n = Int(ns.substring(with: m.range(at: 2))), let title = map[n] { out[n] = title }
            }
        }
        return RefTitles(map: out)
    }
}
private struct RefTitleKey: EnvironmentKey { static let defaultValue = RefTitles() }
extension EnvironmentValues {
    var refTitle: RefTitles {
        get { self[RefTitleKey.self] }
        set { self[RefTitleKey.self] = newValue }
    }
}

extension View {
    /// "#123" in messages and checklists here reads as that message's title (from these entries and tasks).
    func refTitles(_ entries: [Entry], tasks: [WorkTask]) -> some View {
        environment(\.refTitle, RefTitles.cached(entries, tasks))
    }
}

extension RefTitles {
    @MainActor private static let cache = Cache()
    @MainActor static func cached(_ entries: [Entry], _ tasks: [WorkTask]) -> RefTitles {
        cache.value(entries, tasks)
    }

    /// Keep titles for unchanged entries when history grows or a message is decrypted. Task changes reuse the entry
    /// map; a body pass with the same arrays does no traversal. The retained arrays make storage keys safe to compare.
    final class Cache {
        private struct Input: Equatable {
            let title: String?
            let text: String
            let artifactName: String?
            init(_ e: Entry) { title = e.title; text = e.text; artifactName = e.artifactName }
        }
        private var entries: [Entry] = []
        private var tasks: [WorkTask] = []
        private var entryKey: ArrayStorageIdentity?
        private var taskKey: ArrayStorageIdentity?
        private var shortened: [Int: (input: Input, title: String)] = [:]
        private var entryMap: [Int: String] = [:]
        private var titles = RefTitles()
        private let short: (Entry) -> String

        init(short: @escaping (Entry) -> String = { ChatSummary.short($0, words: 6) }) {
            self.short = short
        }

        func value(_ entries: [Entry], _ tasks: [WorkTask]) -> RefTitles {
            let nextEntries = ArrayStorageIdentity(entries), nextTasks = ArrayStorageIdentity(tasks)
            guard nextEntries != entryKey || nextTasks != taskKey else { return titles }
            if nextEntries != entryKey {
                var next: [Int: (input: Input, title: String)] = [:]
                for e in entries where e.seq > 0 && e.retracts == nil {
                    let input = Input(e)
                    // Also reuse within this pass when duplicate sequence numbers appear; the last title wins as before.
                    let previous = next[e.seq] ?? shortened[e.seq]
                    if let previous, previous.input == input {
                        next[e.seq] = previous
                    } else {
                        next[e.seq] = (input, short(e))
                    }
                }
                shortened = next // evict entries that left the loaded list
                entryMap = next.mapValues(\.title)
            }
            var map = entryMap
            for t in tasks { map[t.seq] = t.title }
            titles = RefTitles(map: map)
            self.entries = entries
            self.tasks = tasks
            entryKey = nextEntries
            taskKey = nextTasks
            return titles
        }
    }
}

/// The message number in an "atteo-entry://123" link.
func entryLink(_ url: URL) -> Int? { url.scheme == "atteo-entry" ? Int(url.host ?? "") : nil }

/// "@agents" / "@humans", tapped: who it reaches ("atteo-group://agents").
func groupLink(_ url: URL) -> GroupTarget? {
    guard url.scheme == "atteo-group", let h = url.host else { return nil }
    return h == "agents" ? GroupTarget(agents: true) : h == "humans" ? GroupTarget(agents: false) : h == "all" ? GroupTarget(agents: false, all: true) : nil
}
/// "@agents", "@humans" or "@all" (everyone, then their agents).
struct GroupTarget: Identifiable, Hashable { let agents: Bool; var all = false; var id: String { all ? "all" : agents ? "agents" : "humans" } }

/// Who an "atteo-person://theo?agent=1" link (a tapped @mention) is.
func personLink(_ url: URL) -> ProfileTarget? {
    guard url.scheme == "atteo-person", let name = url.host, !name.isEmpty else { return nil }
    return ProfileTarget(name: name, agent: url.query?.contains("agent=1") == true)
}

// MARK: - In the chat

/// Under a message with answers: who answered, "3 replies · 4m ›", and a dot when there's something you haven't seen.
/// (The answers themselves are in the chat, each under its quote bar, jxn #1040.) Tap: the thread.
struct ThreadPreview: View {
    let seq: Int
    let replies: [Entry]
    var unread = false
    let open: () -> Void

    var body: some View {
        let n = replies.count
        var keys = Set<String>()
        let who = replies.filter { keys.insert("\($0.author)/\($0.byAgent)").inserted }.prefix(3)
        Button(action: open) {
            HStack(spacing: 6) {
                HStack(spacing: -5) {
                    ForEach(Array(who), id: \.seq) { r in Avatar(name: r.author, agent: r.byAgent, size: 18).padding(1).background(Theme.bg, in: Circle()) }
                }
                if unread { Circle().fill(Theme.accent).frame(width: 6, height: 6).accessibilityIdentifier("thread-unread") }
                Text("\(n) replies").font(Typo.micro.weight(.semibold)).foregroundStyle(unread ? Theme.accent : Theme.text.opacity(0.85))
                if let last = replies.last { Text("· \(last.ts.ago)").font(Typo.micro).foregroundStyle(Theme.faint).monospacedDigit() }
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.faint)
            }
            .padding(.leading, 4).padding(.trailing, 10).padding(.vertical, 5)
            .background(Theme.card, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(unread ? String(localized: "\(n) replies, new", bundle: .l10n) : String(localized: "\(n) replies", bundle: .l10n))
        .accessibilityHint("Opens the thread")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("replies-\(seq)")
    }

    /// A reply's first line, without its leading @mention ("@theo's agent sure" → "sure").
    static func line(_ e: Entry) -> String {
        if let a = e.artifactName, e.text.isEmpty || e.text == "Shared \(a)" { return "📎 \(a)" }
        if e.isMultiFile, e.text.hasPrefix("Shared ") { return "📎 " + e.text.dropFirst(7) }
        let first = e.text.split(separator: "\n").first.map(String.init) ?? e.text
        return first.replacingOccurrences(of: "^(@[A-Za-z0-9][A-Za-z0-9_.-]*(?:['’]s\\s+agent)?\\s*)+", with: "", options: .regularExpression)
    }
}

// MARK: - Every thread here

/// Every thread on this board (in what's loaded), newest activity first: what it's about, who's in it, how many
/// answers, when it last moved, and a dot if there's something new. Tap: the thread; back: this list.
struct ThreadsList: View {
    @EnvironmentObject var state: AppState
    @ObservedObject private var seen = ThreadSeen.shared
    @Environment(\.chatDensity) private var density
    @Environment(\.refTitle) private var refTitle
    let board: Board

    var body: some View {
        let threads = ThreadIndex.threads(state.entries[board.id] ?? [])
        let me = state.me?.owner
        List {
            ForEach(threads) { t in
                NavigationLink { ThreadView(board: board, root: t.root) } label: { row(t, unread: seen.unread(board.id, t, me: me)) }
                    .accessibilityIdentifier("thread-row-\(t.root)")
                    .accessibilityValue(seen.unread(board.id, t, me: me) ? "new replies" : "")
            }
            .listRowBackground(Theme.card)
        }
        .listSectionSpacing(.compact)
        .listDensity(density)
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .overlay {
            if threads.isEmpty {
                ContentUnavailableView("No threads yet", systemImage: "bubble.left.and.text.bubble.right",
                                       description: Text("Reply to a message and its answers collect in a thread here."))
            }
        }
        .refTitles(state.entries[board.id] ?? [], tasks: state.tasks[board.id] ?? [])
        .navigationTitle("Threads")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .refreshable { await state.loadEntries(board) }
        // Live here too (the chat underneath stops listening while something is pushed over it).
        .task(id: board.id) { await state.watch(board) }
        .task { await state.loadEntries(board) }
    }

    private func row(_ t: ThreadSummary, unread: Bool) -> some View {
        var seenNames = Set<String>()
        let people = ([t.rootEntry].compactMap { $0 } + t.replies).filter { seenNames.insert("\($0.author)/\($0.byAgent)").inserted }.prefix(4)
        return HStack(alignment: .top, spacing: Space.m) {
            ZStack(alignment: .topLeading) {
                Avatar(name: t.rootEntry?.author ?? "?", agent: t.rootEntry?.byAgent ?? false, size: 32)
                if unread {
                    Circle().fill(Theme.accent).frame(width: 9, height: 9).padding(2).background(Theme.card, in: Circle()).offset(x: -4, y: -4)
                        .accessibilityIdentifier("thread-unread")
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    (t.rootEntry.map { e in Text(verbatim: e.byAgent ? Vocab.agentOf(e.author) : PersonName.shown(e.author, state.personNames[e.author])) } ?? Text("An earlier message"))
                        .font(unread ? Typo.rowTitle : Typo.rowTitleRead).foregroundStyle(Theme.text).lineLimit(1)
                    Spacer(minLength: Space.s)
                    Text(t.last.ago).font(Typo.micro).foregroundStyle(unread ? Theme.accent : Theme.faint).monospacedDigit()
                }
                (t.rootEntry.map { Text(verbatim: ThreadPreview.line($0).plainRefs(refTitle.callAsFunction)) } ?? Text("An earlier message")).font(Typo.secondary).foregroundStyle(Theme.muted).lineLimit(2)
                HStack(spacing: 6) {
                    HStack(spacing: -5) {
                        ForEach(Array(people), id: \.seq) { p in Avatar(name: p.author, agent: p.byAgent, size: 16).padding(1).background(Theme.card, in: Circle()) }
                    }
                    Text("\(t.replies.count) replies").font(Typo.micro.weight(.semibold)).foregroundStyle(unread ? Theme.accent : Theme.faint)
                }
            }
        }
        .padding(.vertical, density == .compact ? 0 : Space.xxs)
    }
}

// MARK: - A thread

/// A thread: the message at the top, "N replies", every answer under it in order, and the chat's own message box
/// (ChatComposer) answering it. Over the chat as a sheet (iMessage-style; Close or a swipe down returns to it), or
/// pushed from the Threads list; a "#123" link opens that message's thread on top of this one.
struct ThreadView: View {
    @EnvironmentObject var state: AppState
    @ObservedObject private var seenMarks = ThreadSeen.shared
    let board: Board
    let root: Int
    var prefill: String? = nil // a reply's "@who " to start with
    var focus: Int? = nil // an answer to show (lit for a moment)
    var replyTo: Int? = nil // the message the box answers first (a reply started on one), else the root
    var overChat = false // a sheet over the chat, which keeps its live socket (one per board is enough)
    var closes = false // the sheet's first screen: a Close button
    /// A reply started in the chat (a swipe or Reply) carries the chat's box (vedu #1469, like the web): what was typed
    /// there starts this box after the "@who ", and until it's sent the chat's box follows this one without that
    /// "@who ", so cancelling the reply (✕, Close or a swipe down) leaves the text in the chat. Sending clears both.
    var carry: ComposerDraft? = nil // the chat's box: an object, so the chat behind never reads its words (jxn #4181)
    @State private var top: Int? // the real root, once known (opened on an answer: its thread)
    @State private var fetched: ThreadResponse?
    /// The box's words, outside this view's state: only the box redraws as you type (jxn #4181, MessageDrafts.swift).
    @State private var draft = ComposerDraft()
    @State private var answering: Int? // what the next answer quotes (nil: the root)
    @State private var started = false // the box's first words and what it answers are set, once
    @State private var carrying = false // the chat's box follows this one (until a send)
    @State private var carryAdded = "" // the "@who " this box put in front of the chat's text
    @State private var mentionAdded: String? // the "@who " a reply here put in front (✕ takes it out)
    @State private var unsending: Entry?
    @State private var reactingTo: SeqRef?
    @State private var next: ThreadTarget? // another thread, pushed on top
    @State private var profile: ProfileTarget? // someone's card
    @State private var group: GroupTarget? // "@agents" / "@humans" tapped
    @State private var flash: Int?
    @State private var scrollTo: Int?
    @State private var focused = false
    @State private var decisionPrompt: DecisionPrompt? // objecting (why?) or closing a human decision
    @State private var decisionNote = ""
    @Environment(\.dismiss) private var dismiss
    /// "Show agents" (jxn #2191): off, a thread shows only what people wrote; the message it's about stays, whoever
    /// wrote it. For you, remembered on this phone for every thread; never in "Your agent" (it's all your agents there).
    @AppStorage("thread-show-agents") private var showAgents = true

    private var me: String? { state.me?.owner }
    private var rootSeq: Int { top ?? root }
    private var hidesAgents: Bool { !showAgents && !board.isAgentChat }
    /// Hidden by Show agents being off: an agent's answer.
    private func hidden(_ e: Entry) -> Bool { hidesAgents && e.byAgent && e.seq != rootSeq }

    /// The root and its answers: what the server has for it, and what's loaded in the chat (yours still sending too).
    private var items: [Entry] {
        let loaded = state.entries[board.id] ?? []
        let bySeq = Dictionary(loaded.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })
        let r = rootSeq
        func inThread(_ e: Entry) -> Bool {
            var cur = e, hops = 0
            while let p = cur.replyTo, hops < 50 {
                if p == r { return true }
                guard let up = bySeq[p] else { return false }
                cur = up; hops += 1
            }
            return false
        }
        var all: [Int: Entry] = [:]
        if let f = fetched, f.entry.seq == r {
            all[f.entry.seq] = f.entry
            for x in f.replies where x.replyTo == r && x.retracts == nil { all[x.seq] = x }
        }
        if let e = bySeq[r] { all[r] = e } // decrypted here, on an encrypted board
        for e in loaded where e.retracts == nil && inThread(e) { all[e.seq] = e }
        return all.values.sorted { ($0.seq > 0 ? $0.seq : .max, $0.ts) < ($1.seq > 0 ? $1.seq : .max, $1.ts) }
    }

    private var gone: Set<Int> { Set((state.entries[board.id] ?? []).compactMap(\.retracts) + (fetched?.replies.compactMap(\.retracts) ?? [])) }

    /// The thread's message and its answers, with the "N replies" line under the message.
    @ViewBuilder private func rows(_ list: [Entry], bySeq: [Int: Entry], unsent: Set<Int>) -> some View {
        if list.isEmpty { ProgressView().tint(Theme.faint).frame(maxWidth: .infinity).padding(.top, Space.xl) }
        ForEach(Array(list.enumerated()), id: \.element.id) { i, e in
            if i == 1 {
                HStack(spacing: Space.s) {
                    Text("\(list.count - 1) replies").font(Typo.micro.weight(.semibold)).foregroundStyle(Theme.faint)
                        .accessibilityIdentifier("thread-count")
                    Rectangle().fill(Theme.line).frame(height: 0.5)
                }
                .padding(.top, Space.l).padding(.bottom, Space.xxs)
            }
            row(e, parent: e.replyTo.flatMap { $0 == rootSeq ? nil : bySeq[$0] }, unsent: unsent).id(e.id)
        }
    }

    var body: some View {
        let all = items
        let list = all.filter { !hidden($0) }
        let unsent = gone
        let bySeq = Dictionary(all.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })
        ScrollViewReader { proxy in
            ScrollView {
                // Made up front, not lazily (a thread is short): a lazy list scrolled to an answer while something above
                // it changes size (the "Showing people only" strip, a card loading) only has guessed heights, which can
                // flip every frame and stall the layout, as the chat's did (vedu #2449). A very long thread stays lazy.
                if list.count > 120 {
                    LazyVStack(alignment: .leading, spacing: 0) { rows(list, bySeq: bySeq, unsent: unsent) }
                        .padding(.horizontal, Space.l).padding(.bottom, Space.m)
                } else {
                    VStack(alignment: .leading, spacing: 0) { rows(list, bySeq: bySeq, unsent: unsent) }
                        .padding(.horizontal, Space.l).padding(.bottom, Space.m)
                }
            }
            .accessibilityIdentifier("thread-list")
            // The message at the top, its answers under it; a new answer scrolls into view.
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom, for: .initialOffset) // opens on the latest answers, like iMessage
            .onChange(of: list.last?.id) { old, new in
                guard old != nil, let new else { return }
                withAnimation(.smooth(duration: 0.3)) { proxy.scrollTo(new, anchor: .bottom) }
            }
            .onChange(of: scrollTo) { _, s in
                guard let s else { return }
                withAnimation(.smooth(duration: 0.3)) { proxy.scrollTo(s, anchor: .center) }
                scrollTo = nil
            }
        }
        .background(Theme.bg)
        .refTitles(state.entries[board.id] ?? [], tasks: state.tasks[board.id] ?? [])
        // Show agents is off: says so, one tap shows everything again.
        .safeAreaInset(edge: .top, spacing: 0) {
            if hidesAgents {
                PeopleFilterStrip(empty: all.count > 1 && list.count < 2, id: "thread-agents") { Haptics.play(.touch); withAnimation(.smooth(duration: 0.25)) { showAgents = true } }
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .navigationTitle("Thread")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            if closes {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: { ToolbarIcon("xmark") }
                        .accessibilityIdentifier("thread-close")
                        .accessibilityLabel("Close")
                }
            }
            if !board.isAgentChat {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Toggle(isOn: Binding(get: { showAgents }, set: { on in Haptics.play(.touch); withAnimation(.smooth(duration: 0.25)) { showAgents = on } })) {
                            Label(Vocab.pick(String(localized: "Show agents", bundle: .l10n), String(localized: "Show assistants", bundle: .l10n)), systemImage: "person.2")
                        }
                        .accessibilityIdentifier("thread-show-agents")
                    } label: { ToolbarIcon("ellipsis") }
                    .accessibilityIdentifier("thread-menu")
                    .accessibilityLabel(String(localized: "Thread options", bundle: .l10n))
                }
            }
        }
        .navigationDestination(item: $next) { t in ThreadView(board: board, root: t.root, overChat: overChat) }
        // A "#123" in a message: in this thread, go to it; elsewhere, open its thread on top of this one.
        .environment(\.openURL, OpenURLAction { url in
            if let p = personLink(url) { profile = p; return .handled }
            if let g = groupLink(url) { group = g; return .handled }
            guard let n = entryLink(url) else {
                // Leaving Atteo: ask first, with the whole address (jxn #4173).
                if LinkGate.needsConfirm(url) { LinkGate.ask(url); return .handled }
                return .systemAction
            }
            open(n, here: bySeq)
            return .handled
        })
        .sheet(item: $group) { g in GroupSheet(board: board, agents: g.agents, all: g.all).presentationDetents([.medium, .large]).presentationBackground(Theme.bg) }
        .sheet(item: $profile) { p in
            NavigationStack {
                PersonCard(name: p.name, open: { b in profile = nil; state.openRequest = b }, agentFirst: p.agent, ask: {
                    profile = nil
                    let handle = "@\(p.name)'s agent "
                    if !draft.text.localizedCaseInsensitiveContains(handle.trimmingCharacters(in: .whitespaces)) { draft.set(handle + draft.text) }
                    focused = true
                })
            }
            .presentationDetents([.fraction(0.8), .large]).presentationBackground(Theme.bg)
        }
        .sheet(item: $reactingTo) { r in
            EmojiPicker { emoji in reactingTo = nil; Task { await state.react(emoji, to: r.id, in: board) } }
                .presentationDetents([.height(300)]).presentationBackground(Theme.card)
        }
        .confirmationDialog("Unsend this message?", isPresented: Binding(get: { unsending != nil }, set: { if !$0 { unsending = nil } }), titleVisibility: .visible, presenting: unsending) { e in
            Button("Unsend", role: .destructive) { Task { await state.retract(e.seq, in: board) } }
        } message: { _ in Text("Everyone here will see it as unsent.") }
        .decisionPrompts($decisionPrompt, note: $decisionNote, board: board, state: state)
        .task {
            if !started {
                draft.attach(board, root: root) // the same key it saves to (rootSeq can move to a sub-thread)
                // While a reply from the chat carries its box, the chat's box follows this one (without the "@who ").
                draft.onChange = { d in if carrying { carry?.set(Self.without(carryAdded, d)) } }
            }
            if !started, let carry {
                // The chat's text, after "@who " (unless it already names them).
                let kept = carry.text, handle = (prefill ?? "").trimmingCharacters(in: .whitespaces)
                carryAdded = handle.isEmpty || kept.localizedCaseInsensitiveContains(handle) ? "" : prefill ?? ""
                started = true; answering = replyTo; draft.set(carryAdded + kept); carrying = true; focused = true
            }
            else if !started, let prefill { started = true; answering = replyTo; draft.set(prefill); focused = true }
            else if !started, replyTo != nil { started = true; answering = replyTo; focused = true }
            await load()
            // Opened on the thread itself ("N replies", a quote bar): the box starts with who wrote the message, like
            // the web (only your own start empty).
            if !started { started = true; if draft.text.isEmpty, let r = items.first(where: { $0.seq == rootSeq }) { draft.set(BoardView.replyHandle(r, me: me) ?? "") } }
            if let focus { try? await Task.sleep(nanoseconds: 250_000_000); open(focus, here: Dictionary(items.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })) }
        }
        // New answers arrive live (over the chat, its socket already brings them).
        .task(id: board.id) { if !overChat { await state.watch(board) } }
        .onAppear { markSeen() }
        .onChange(of: list.last?.seq) { _, _ in markSeen() }
        .onDisappear { draft.save() } // what was typed last, without waiting for the pause
    }

    /// The text without the "@who " a reply put in front of it (as typed, or with its space gone).
    static func without(_ added: String, _ text: String) -> String {
        guard !added.isEmpty else { return text }
        if text.hasPrefix(added) { return String(text.dropFirst(added.count)) }
        let bare = added.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix(bare) { return String(text.dropFirst(bare.count)).replacingOccurrences(of: #"^ "#, with: "", options: .regularExpression) }
        return text
    }

    /// Who and what the box answers, for its "Replying to" line (nil while it answers the thread's top).
    private var replyingTo: (who: String, line: String)? {
        guard let a = answering else { return nil }
        let e = items.first(where: { $0.seq == a }) ?? (state.entries[board.id] ?? []).first(where: { $0.seq == a })
        guard let e else { return nil }
        let who = e.author == me ? (e.byAgent ? String(localized: "your agent", bundle: .l10n) : String(localized: "yourself", bundle: .l10n))
            : e.byAgent ? "\(e.author)'s agent" : PersonName.shown(e.author, state.personNames[e.author])
        let line = e.text.split(whereSeparator: \.isNewline).first.map { String($0.prefix(120)) } ?? ""
        return (who, line)
    }

    /// ✕ on "Replying to": a reply started in the chat closes, its text back in the chat's box; one started here
    /// answers the thread again, without the "@who " it added. The text stays either way.
    private func cancelReply() {
        if carrying, answering == replyTo { dismiss(); return }
        if let m = mentionAdded { draft.set(Self.without(m, draft.text)) }
        mentionAdded = nil
        withAnimation(.smooth(duration: 0.2)) { answering = nil }
    }

    /// You've seen every answer here.
    private func markSeen() {
        if let last = items.last(where: { $0.seq > 0 })?.seq { seenMarks.seen(board.id, root: rootSeq, through: last) }
    }

    private func open(_ n: Int, here: [Int: Entry]) {
        if let e = here[n] {
            if hidden(e) { withAnimation(.smooth(duration: 0.25)) { showAgents = true } } // going to an agent's answer shows agents again
            scrollTo = n
            withAnimation(.smooth(duration: 0.25)) { flash = n }
            // Lit for a moment (longer under UI tests, so a slow accessibility snapshot can still find it).
            let hold: UInt64 = API.environment("STILL") != nil ? 6_000_000_000 : 1_400_000_000
            Task { try? await Task.sleep(nanoseconds: hold); withAnimation(.smooth(duration: 0.8)) { if flash == n { flash = nil } } }
            return
        }
        let loaded = Dictionary((state.entries[board.id] ?? []).map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })
        next = ThreadTarget(root: loaded[n].map { ThreadIndex.root(of: $0, in: loaded) } ?? n)
    }

    /// A message in the thread: the same row as the chat (answers to the root don't quote it: they're under it).
    private func row(_ e: Entry, parent: Entry?, unsent: Set<Int>) -> some View {
        var shown = e
        if e.replyTo == rootSeq { shown.replyTo = nil }
        let mine = e.author == me && e.via != "agent"
        let live = e.seq > 0 && e.pending != true && e.failed != true && !unsent.contains(e.seq)
        var a = EntryActions()
        a.openProfile = { name, agent in profile = ProfileTarget(name: name, agent: agent) }
        if live {
            a.react = { emoji in Task { await state.react(emoji, to: e.seq, in: board) } }
            a.moreReactions = { reactingTo = SeqRef(id: e.seq) }
            if mine { a.unsend = { unsending = e } }
            if !board.isAgentChat { a.remember = { Task { await state.remember(e.seq, in: board.id) } } }
        }
        if let p = shown.replyTo { a.jumpToParent = { open(p, here: Dictionary(items.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })) } }
        let rx = state.reactions[board.id]?[e.seq] ?? (fetched?.entry.seq == e.seq ? fetched?.reactions : nil) ?? []
        let hd = e.type == "decision" && !unsent.contains(e.seq) ? state.decisions[board.id]?[e.seq] ?? e.humanDecision : nil
        return EntryRow(e: shown, mine: mine, board: board.id, tasks: shown.type == "task" ? state.tasks[board.id] ?? [] : [], reactions: rx, parent: parent,
                        me: me, members: state.members[board.id] ?? [], names: state.personNames,
                        reply: live ? { mention(e) } : nil,
                        unsent: unsent.contains(e.seq), handling: state.handling[board.id]?[e.seq], lit: flash == e.seq, actions: a,
                        decision: hd, decisionActions: DecisionActions.make(hd, seq: e.seq, board: board, state: state) { p in decisionNote = ""; decisionPrompt = p },
                        agentName: state.agentNames[board.id]?[e.author]?.name, quick: state.favouriteReactions, agentNames: state.agentNameMap(board.id),
                        replyChips: live ? quickChips(e) : nil,
                        refTitle: RefTitles.cached(state.entries[board.id] ?? [], state.tasks[board.id] ?? []).only(shown.text, parent?.text),
                        pickChip: { text in Task { await state.send(text, to: board, replyTo: e.seq) } }) {
            Task { await state.send(e.text, to: board, retrying: e) }
        }
    }

    /// An agent's open question to you gets its one-tap replies in its thread too (QuickReplies.swift).
    private func quickChips(_ e: Entry) -> QuickChips? {
        guard let c = state.quickChips[board.id]?[e.seq] else { return nil }
        return ChatSummary.open(state.entries[board.id] ?? []).questions.contains { $0.seq == e.seq } ? c : nil
    }

    /// Replying to a message in the thread: the next answer quotes it, and names who wrote it (your agent too).
    private func mention(_ e: Entry) {
        answering = e.seq == rootSeq ? nil : e.seq
        mentionAdded = nil
        if let handle = BoardView.replyHandle(e, me: me)?.trimmingCharacters(in: .whitespaces), !draft.text.localizedCaseInsensitiveContains(handle) {
            mentionAdded = handle + " "
            draft.set(handle + " " + draft.text)
        }
        focused = true
    }

    /// The chat's own message box (jxn #1094): typing, "/", "@", pictures and files, send.
    private var composer: some View {
        ChatComposer(board: board, box: draft, focused: $focused, placeholder: String(localized: "Reply…", bundle: .l10n), replyTo: answering ?? rootSeq,
                     identifier: "thread-composer", sendIdentifier: "thread-send", attachIdentifier: "thread-attach",
                     sent: {
                         // Sent: the chat's box is done with it too (it no longer follows this one).
                         if carrying { carry?.set(""); carrying = false }
                         answering = nil; mentionAdded = nil
                         await load()
                     },
                     replying: replyingTo, cancelReply: cancelReply)
    }

    /// The root and its direct answers from the server. Opened on an answer (a "#123" to one): climbs to its root.
    private func load() async {
        var seq = rootSeq
        for _ in 0..<10 {
            guard let f = try? await API.shared.get("/api/boards/\(board.id)/entries/\(seq)", as: ThreadResponse.self) else { return }
            if let up = f.entry.replyTo { seq = up; continue }
            if seq != rootSeq { top = seq }
            fetched = f
            return
        }
    }
}
