// Threads, like Lark: answers live in their thread, not in the chat. A message with answers shows a small preview
// card under it (the latest answers and "3 replies · 4m ›"); tapping it pushes the thread full screen (back, or swipe
// back, returns to the chat where you were). The chat's top bar lists every thread here, newest first, with a dot on
// those with answers you haven't seen. A "#123" in a message opens that message's thread, and threads stack: back
// unwinds each step.

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
    /// The message as styled text, with "#123" (a message on this board) as a link that opens it.
    var mdLinked: AttributedString {
        var out = md
        let plain = String(out.characters)
        let ns = plain as NSString
        for m in Self.entryRE.matches(in: plain, range: NSRange(location: 0, length: ns.length)).reversed() {
            guard let n = Int(ns.substring(with: m.range(at: 2))), let r = Range(m.range(at: 1), in: out) else { continue }
            if out[r].runs.contains(where: { $0.link != nil || $0.inlinePresentationIntent?.contains(.code) == true }) { continue }
            out[r].link = URL(string: "atteo-entry://\(n)")
        }
        return out
    }
    private static let entryRE = try! NSRegularExpression(pattern: "(?<![\\w&/#])(#(\\d{1,7}))\\b")
}

/// The message number in an "atteo-entry://123" link.
func entryLink(_ url: URL) -> Int? { url.scheme == "atteo-entry" ? Int(url.host ?? "") : nil }

// MARK: - In the chat

/// Under a message with answers: the latest one or two (who, a line of what they said) and "3 replies · 4m ›", with a
/// dot when there's something you haven't seen. Tap: the thread.
struct ThreadPreview: View {
    let seq: Int
    let replies: [Entry]
    var unread = false
    let open: () -> Void

    var body: some View {
        let n = replies.count
        Button(action: open) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(replies.suffix(2), id: \.seq) { r in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Avatar(name: r.author, agent: r.byAgent, size: 16).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
                        Text(r.byAgent ? "\(r.author)'s agent" : r.author).font(Typo.micro.weight(.semibold)).foregroundStyle(Theme.text.opacity(0.9)).lineLimit(1)
                            .layoutPriority(1)
                        Text(Self.line(r)).font(Typo.micro).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                }
                HStack(spacing: 5) {
                    if unread { Circle().fill(Theme.accent).frame(width: 6, height: 6).accessibilityIdentifier("thread-unread") }
                    Text(n == 1 ? "1 reply" : "\(n) replies").font(Typo.micro.weight(.semibold)).foregroundStyle(unread ? Theme.accent : Theme.text.opacity(0.85))
                    if let last = replies.last { Text("· \(last.ts.ago)").font(Typo.micro).foregroundStyle(Theme.faint).monospacedDigit() }
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.faint)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, Space.s)
            .frame(maxWidth: 300, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        }
        .buttonStyle(PressStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel((n == 1 ? "1 reply" : "\(n) replies") + (unread ? ", new" : ""))
        .accessibilityHint("Opens the thread")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier("replies-\(seq)")
    }

    /// A reply's first line, without its leading @mention ("@theo's agent sure" → "sure").
    static func line(_ e: Entry) -> String {
        if let a = e.artifactName, e.text.isEmpty || e.text == "Shared \(a)" { return "📎 \(a)" }
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
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .overlay {
            if threads.isEmpty {
                ContentUnavailableView("No threads yet", systemImage: "bubble.left.and.text.bubble.right",
                                       description: Text("Reply to a message and its answers collect in a thread here."))
            }
        }
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
                    Text(t.rootEntry.map { $0.byAgent ? "\($0.author)'s agent" : $0.author } ?? "An earlier message")
                        .font(unread ? Typo.rowTitle : Typo.rowTitleRead).foregroundStyle(Theme.text).lineLimit(1)
                    Spacer(minLength: Space.s)
                    Text(t.last.ago).font(Typo.micro).foregroundStyle(unread ? Theme.accent : Theme.faint).monospacedDigit()
                }
                Text(t.rootEntry.map { ThreadPreview.line($0) } ?? "#\(t.root)").font(Typo.secondary).foregroundStyle(Theme.muted).lineLimit(2)
                HStack(spacing: 6) {
                    HStack(spacing: -5) {
                        ForEach(Array(people), id: \.seq) { p in Avatar(name: p.author, agent: p.byAgent, size: 16).padding(1).background(Theme.card, in: Circle()) }
                    }
                    Text(t.replies.count == 1 ? "1 reply" : "\(t.replies.count) replies").font(Typo.micro.weight(.semibold)).foregroundStyle(unread ? Theme.accent : Theme.faint)
                }
            }
        }
        .padding(.vertical, Space.xxs)
    }
}

// MARK: - A thread

/// A thread, full screen: the message at the top, "N replies", every answer under it in order, and a "Reply…" box
/// that answers the thread (and, if you like, also posts it to the chat). Pushed on the chat's stack, so back returns
/// where you were; a "#123" link opens that message's thread on top of this one.
struct ThreadView: View {
    @EnvironmentObject var state: AppState
    @ObservedObject private var seenMarks = ThreadSeen.shared
    let board: Board
    let root: Int
    var prefill: String? = nil // a reply's "@who " to start with
    @State private var top: Int? // the real root, once known (opened on an answer: its thread)
    @State private var fetched: ThreadResponse?
    @State private var draft = ""
    @State private var selection: TextSelection?
    @State private var alsoToChat = false
    @State private var unsending: Entry?
    @State private var reactingTo: SeqRef?
    @State private var next: ThreadTarget? // another thread, pushed on top
    @State private var flash: Int?
    @State private var scrollTo: Int?
    @FocusState private var focused: Bool

    private var me: String? { state.me?.owner }
    private var rootSeq: Int { top ?? root }

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

    var body: some View {
        let list = items
        let unsent = gone
        let bySeq = Dictionary(list.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if list.isEmpty { ProgressView().tint(Theme.faint).frame(maxWidth: .infinity).padding(.top, Space.xl) }
                    ForEach(Array(list.enumerated()), id: \.element.id) { i, e in
                        if i == 1 {
                            HStack(spacing: Space.s) {
                                Text(list.count == 2 ? "1 reply" : "\(list.count - 1) replies").font(Typo.micro.weight(.semibold)).foregroundStyle(Theme.faint)
                                    .accessibilityIdentifier("thread-count")
                                Rectangle().fill(Theme.line).frame(height: 0.5)
                            }
                            .padding(.top, Space.l).padding(.bottom, Space.xxs)
                        }
                        row(e, parent: e.replyTo.flatMap { $0 == rootSeq ? nil : bySeq[$0] }, unsent: unsent).id(e.id)
                    }
                }
                .padding(.horizontal, Space.l).padding(.bottom, Space.m)
            }
            // The message at the top, its answers under it; a new answer scrolls into view.
            .scrollDismissesKeyboard(.interactively)
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
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .navigationTitle("Thread")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .navigationDestination(item: $next) { t in ThreadView(board: board, root: t.root) }
        // A "#123" in a message: in this thread, go to it; elsewhere, open its thread on top of this one.
        .environment(\.openURL, OpenURLAction { url in
            guard let n = entryLink(url) else { return .systemAction }
            open(n, here: bySeq)
            return .handled
        })
        .sheet(item: $reactingTo) { r in
            EmojiPicker { emoji in reactingTo = nil; Task { await state.react(emoji, to: r.id, in: board) } }
                .presentationDetents([.height(300)]).presentationBackground(Theme.card)
        }
        .confirmationDialog("Unsend this message?", isPresented: Binding(get: { unsending != nil }, set: { if !$0 { unsending = nil } }), titleVisibility: .visible, presenting: unsending) { e in
            Button("Unsend", role: .destructive) { Task { await state.retract(e.seq, in: board) } }
        } message: { _ in Text("Everyone here will see it as unsent.") }
        .task {
            if let prefill, draft.isEmpty { draft = prefill; selection = TextSelection(insertionPoint: draft.endIndex); focused = true }
            await load()
        }
        .task(id: board.id) { await state.watch(board) } // new answers arrive live
        .onAppear { markSeen() }
        .onChange(of: list.last?.seq) { _, _ in markSeen() }
    }

    /// You've seen every answer here.
    private func markSeen() {
        if let last = items.last(where: { $0.seq > 0 })?.seq { seenMarks.seen(board.id, root: rootSeq, through: last) }
    }

    private func open(_ n: Int, here: [Int: Entry]) {
        Haptic.tap()
        if here[n] != nil {
            scrollTo = n
            withAnimation(.smooth(duration: 0.25)) { flash = n }
            Task { try? await Task.sleep(nanoseconds: 1_400_000_000); withAnimation(.smooth(duration: 0.8)) { if flash == n { flash = nil } } }
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
        if live {
            a.react = { emoji in Task { await state.react(emoji, to: e.seq, in: board) } }
            a.moreReactions = { reactingTo = SeqRef(id: e.seq) }
            if mine { a.unsend = { unsending = e } }
        }
        if let p = shown.replyTo { a.jumpToParent = { open(p, here: Dictionary(items.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })) } }
        let rx = state.reactions[board.id]?[e.seq] ?? (fetched?.entry.seq == e.seq ? fetched?.reactions : nil) ?? []
        return EntryRow(e: shown, mine: mine, board: board.id, tasks: state.tasks[board.id] ?? [], reactions: rx, parent: parent,
                        me: me, members: state.members[board.id] ?? [], progress: state.uploads[e.seq],
                        reply: live ? { mention(e) } : nil,
                        unsent: unsent.contains(e.seq), handling: state.handling[board.id]?[e.seq], lit: flash == e.seq, actions: a) {
            Task { await state.send(e.text, to: board, retrying: e) }
        }
    }

    /// Replying to someone in the thread names them in the box.
    private func mention(_ e: Entry) {
        guard !(e.author == me && e.via != "agent") else { focused = true; return }
        let handle = "@" + (e.byAgent ? "\(e.author)'s agent" : e.author)
        if !draft.localizedCaseInsensitiveContains(handle) { draft = handle + " " + draft }
        selection = TextSelection(insertionPoint: draft.endIndex)
        focused = true
    }

    private var composer: some View {
        let canSend = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return VStack(alignment: .leading, spacing: Space.xs) {
            HStack(alignment: .bottom, spacing: 0) {
                TextField("Reply…", text: $draft, selection: $selection, axis: .vertical)
                    .font(Typo.body).lineLimit(1...5).focused($focused)
                    .padding(.leading, Space.m).padding(.trailing, Space.s).padding(.vertical, 10)
                    .accessibilityIdentifier("thread-composer")
                Button(action: send) {
                    Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold))
                        .frame(width: 30, height: 30)
                        .background(canSend ? Theme.accent : Theme.raised, in: Circle())
                        .foregroundStyle(canSend ? .black : Theme.faint)
                        .padding(5).contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .disabled(!canSend)
                .accessibilityIdentifier("thread-send")
                .accessibilityLabel("Send")
            }
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            // Also post the answer to the chat, as its own message.
            Button { Haptic.tap(); alsoToChat.toggle() } label: {
                Label("Also send to chat", systemImage: alsoToChat ? "checkmark.square.fill" : "square")
                    .font(Typo.micro.weight(.medium)).foregroundStyle(alsoToChat ? Theme.text : Theme.faint)
                    .padding(.leading, Space.s).frame(minHeight: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("also-to-chat")
            .accessibilityValue(alsoToChat ? "on" : "off")
        }
        .padding(.horizontal, Space.m).padding(.top, Space.s).padding(.bottom, Space.xs)
        .background(Theme.bg)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let echo = alsoToChat
        let r = rootSeq
        draft = ""
        selection = nil
        Haptic.tap()
        Task {
            await state.send(text, to: board, replyTo: r)
            if echo { await state.send(text, to: board) }
            await load()
        }
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
