// One board or DM: opens on what you saw last (cached), refreshes in place, marks itself read, and sends instantly
// (your message shows at once; if it can't be delivered it says so and you tap to retry).

import SwiftUI

struct BoardView: View {
    @EnvironmentObject var state: AppState
    let board: Board
    @State private var draft = ""
    @State private var showTasks = false
    @State private var showAgents = false
    @State private var replyingTo: Entry? // the message you're answering (swipe right or long-press → Reply)
    private var live: [BoardAgent] { (state.boardAgents[board.id] ?? []).filter { $0.state == "live" } }
    /// "theo's agent working", "theo and maya's agents working", "3 agents working", or "No agents working now".
    private var presence: String {
        var users: [String] = []
        for a in live where !users.contains(a.user) { users.append(a.user) }
        switch users.count {
        case 0: return board.encrypted == true ? "End-to-end encrypted" : "No agents working now"
        case 1: return "\(users[0])'s agent working"
        case 2: return "\(users[0]) and \(users[1])'s agents working"
        default: return "\(users.count) agents working"
        }
    }
    @FocusState private var focused: Bool

    private var list: [Entry] { state.entries[board.id] ?? [] }
    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    @State private var atBottom = true
    @State private var stick = true // pinned to the latest until you scroll up yourself (like any messenger)
    @State private var position = ScrollPosition(edge: .bottom) // like any messenger: you start at the latest

    var body: some View {
        let bySeq = Dictionary(list.map { ($0.seq, $0) }, uniquingKeysWith: { a, _ in a })
        ScrollView {
                // Placeholders and messages are separate containers: sharing one list would give them colliding ids
                // (placeholder 1… and message #1…), and SwiftUI kept showing placeholders in place of messages.
                if state.entries[board.id] == nil {
                    VStack(alignment: .leading, spacing: 0) { ForEach(0..<6, id: \.self) { _ in PlaceholderMessage() } }
                        .padding(.horizontal, Space.l).padding(.vertical, Space.m)
                        .transition(.opacity)
                }
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(list.enumerated()), id: \.element.id) { i, e in
                        let prev = i > 0 ? list[i - 1] : nil
                        let newDay = prev.map { !Calendar.current.isDate(Date(timeIntervalSince1970: $0.ts / 1000), inSameDayAs: Date(timeIntervalSince1970: e.ts / 1000)) } ?? true
                        let grouped = !newDay && prev != nil && prev!.author == e.author && prev!.via == e.via && e.ts - prev!.ts < 5 * 60_000 && e.type == "note" && e.replyTo == nil
                        let mine = e.author == state.me?.owner && e.via != "agent"
                        let prevMine = prev.map { $0.author == state.me?.owner && $0.via != "agent" && $0.type != "task" } ?? false
                        VStack(alignment: .leading, spacing: 0) {
                            if newDay { DaySeparator(ts: e.ts) }
                            // A hairline between separate messages from others (bubbles are separate already).
                            else if !(mine && e.type != "task") && !prevMine { Rectangle().fill(Theme.line.opacity(grouped ? 0.45 : 0.8)).frame(height: 0.5).padding(.leading, 38).padding(.top, grouped ? Space.xs : Space.s) }
                            EntryRow(e: e, grouped: grouped, mine: mine, board: board.id, tasks: state.tasks[board.id] ?? [], reactions: state.reactions[board.id]?[e.seq] ?? [],
                                     parent: e.replyTo.flatMap { bySeq[$0] }, me: state.me?.owner,
                                     reply: e.pending == true || e.failed == true ? nil : { startReply(to: e) }) {
                                Task { await state.send(e.text, to: board, retrying: e) }
                            }
                        }
                        .id(e.id)
                        .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
                    }
                }
                .padding(.horizontal, Space.l).padding(.top, Space.xs).padding(.bottom, Space.s)
            }
            .scrollPosition($position)
            // Like any messenger: it opens at the latest, a short chat sits right above the message box, and while
            // you're at the latest it stays there as things change size (the keyboard sliding up, the message box
            // growing as you type, a new message or a receipt arriving), natively, without scrolling it by hand.
            // Scrolled up to read history: nothing moves you.
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .alignment)
            .defaultScrollAnchor(stick ? .bottom : nil, for: .sizeChanges)
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            // At the latest: the visible part (which includes what's under the composer) reaches the end.
            .onScrollGeometryChange(for: Bool.self) { g in g.visibleRect.maxY >= g.contentSize.height - 80 } action: { _, bottom in
                if bottom != atBottom { withAnimation(.snappy) { atBottom = bottom } }
            }
            // Only your own scrolling unpins it; coming back to the latest re-pins.
            .onScrollPhaseChange { old, phase in
                if phase == .interacting { stick = false }
                else if phase == .idle && (old == .interacting || old == .decelerating) { stick = atBottom } // after a swipe, not our own scrolls
            }
            .onChange(of: list.last?.id) { _, _ in
                // A new message: yours always scrolls into view (and re-pins); others' do if you're at the latest.
                if list.last.map({ $0.author == state.me?.owner && $0.via != "agent" }) == true { stick = true }
                if stick { withAnimation(.smooth(duration: 0.3)) { position.scrollTo(edge: .bottom) } }
            }
            .overlay(alignment: .bottomTrailing) {
                if !atBottom && !list.isEmpty {
                    Button { Haptic.tap(); stick = true; withAnimation(.smooth(duration: 0.35)) { position.scrollTo(edge: .bottom) } } label: {
                        Image(systemName: "chevron.down").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text)
                            .frame(width: 36, height: 36).background(Theme.raised, in: Circle())
                            .shadow(color: .black.opacity(0.4), radius: 8, y: 2)
                            .frame(width: 44, height: 44).contentShape(Circle())
                    }
                    .buttonStyle(PressStyle())
                    .padding(.trailing, Space.s).padding(.bottom, Space.xs)
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                    .accessibilityLabel("Jump to latest")
                }
            }
        .safeAreaInset(edge: .top, spacing: 0) { WorkStrip(tasks: state.tasks[board.id] ?? []) { Haptic.tap(); showTasks = true } }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .sheet(isPresented: $showTasks) { TasksSheet(board: board).presentationDetents([.medium, .large]).presentationBackground(Theme.bg) }
        .navigationTitle(board.displayName(me: state.me?.owner))
        .toolbar {
            // The title, and under it who's working here right now (tap for everyone, live / idle / gone).
            ToolbarItem(placement: .principal) {
                Button { Haptic.tap(); showAgents = true } label: {
                    VStack(spacing: 1) {
                        Text(board.displayName(me: state.me?.owner)).font(.headline).foregroundStyle(Theme.text).lineLimit(1)
                        HStack(spacing: Space.xs) {
                            if board.encrypted == true { Image(systemName: "lock.fill").font(.system(size: 9)).foregroundStyle(Theme.faint) }
                            if !live.isEmpty { LiveDot(size: 6) }
                            Text(presence).font(Typo.micro.weight(.medium)).foregroundStyle(live.isEmpty ? Theme.faint : Theme.ok).lineLimit(1)
                        }
                    }
                    .padding(.horizontal, Space.s)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("presence")
            }
        }
        .sheet(isPresented: $showAgents) { AgentsHereSheet(board: board).presentationDetents([.medium]).presentationBackground(Theme.bg) }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar) // inside a conversation the message box owns the bottom edge
        .task { async let e: Void = state.loadEntries(board); async let t: Void = state.loadTasks(board); async let a: Void = state.loadAgents(board); async let m: Void = state.loadMembers(board); _ = await (e, t, a, m); await state.markRead(board) }
        .onChange(of: state.pulse) { _, p in if p?.board == board.id { Task { async let e: Void = state.loadEntries(board); async let t: Void = state.loadTasks(board); async let a: Void = state.loadAgents(board); _ = await (e, t, a); await state.markRead(board) } } }
        .task(id: board.id) { await state.watch(board) } // live: ticks and new messages as they happen
        .refreshable { await state.loadEntries(board) }
    }

    private func startReply(to e: Entry) {
        Haptic.tap()
        withAnimation(.spring(duration: 0.3, bounce: 0.15)) { replyingTo = e }
        focused = true
    }

    // MARK: - The message box

    /// What "@" can name here: each member's agent and each member (you can hand work to your own agent, but you
    /// don't mention yourself), plus everyone's agents and everyone.
    private var mentionables: [Mentionable] {
        let me = state.me?.owner
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

    /// The message box: one soft field on the page (no bar, no outline), the send button inside its trailing edge.
    /// Above it, when they apply: who you're replying to, and who "@" can name.
    var composer: some View {
        VStack(spacing: 0) {
            if !suggestions.isEmpty {
                MentionList(items: suggestions, pick: insert)
                    .padding(.horizontal, Space.m).padding(.bottom, Space.xs)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if let r = replyingTo {
                ReplyBar(who: r.byAgent ? "\(r.author)'s agent" : r.author, text: r.text) {
                    withAnimation(.spring(duration: 0.3, bounce: 0.15)) { replyingTo = nil }
                }
                .padding(.horizontal, Space.m).padding(.bottom, Space.xs)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            HStack(alignment: .bottom, spacing: 0) {
                TextField(board.kind == "direct" ? "Message \(board.displayName(me: state.me?.owner))" : "Message \(board.title)", text: $draft, axis: .vertical)
                    .font(Typo.body)
                    .lineLimit(1...6).focused($focused)
                    .padding(.leading, Space.l).padding(.trailing, Space.s).padding(.vertical, 10)
                    .accessibilityIdentifier("composer")
                Button(action: send) {
                    Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold))
                        .frame(width: 30, height: 30)
                        .background(canSend ? Theme.accent : Theme.raised, in: Circle())
                        .foregroundStyle(canSend ? .black : Theme.faint)
                        .scaleEffect(canSend ? 1 : 0.9)
                        .animation(.spring(duration: 0.3, bounce: 0.35), value: canSend)
                        .padding(5)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .disabled(!canSend)
                .accessibilityIdentifier("send")
                .accessibilityLabel("Send")
            }
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .padding(.horizontal, Space.m)
        }
        .padding(.top, Space.m).padding(.bottom, Space.s) // a little air between the last message and the box
        .background(Theme.bg)
        .animation(.spring(duration: 0.28, bounce: 0.1), value: suggestions.map(\.handle))
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let reply = replyingTo?.seq
        draft = ""
        withAnimation(.spring(duration: 0.3, bounce: 0.15)) { replyingTo = nil }
        Haptic.tap()
        Task { await state.send(text, to: board, replyTo: reply) }
    }
}

/// Someone "@" can name: a member's agent, a member, or everyone's agents / everyone.
struct Mentionable: Hashable {
    let handle: String // what goes after the "@"
    let user: String? // nil: a group
    let agent: Bool
}

/// What "@" suggests, just above the message box: a compact list, one tap to insert.
struct MentionList: View {
    let items: [Mentionable]
    let pick: (Mentionable) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(items, id: \.handle) { m in
                Button { pick(m) } label: {
                    HStack(spacing: 10) {
                        if let u = m.user { Avatar(name: u, agent: m.agent, size: 24) } else {
                            Image(systemName: m.agent ? "sparkles" : "person.2.fill").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted)
                                .frame(width: 24, height: 24).background(Theme.raised, in: Circle())
                        }
                        Text("@" + m.handle).font(Typo.secondary.weight(.medium)).foregroundStyle(Theme.text)
                        Spacer(minLength: Space.s)
                        Text(m.user == nil ? (m.agent ? "every agent here" : "everyone here") : (m.agent ? "agent" : "person")).font(Typo.micro).foregroundStyle(Theme.faint)
                    }
                    .padding(.horizontal, Space.m).frame(minHeight: 40)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("mention-\(m.handle)")
            }
        }
        .padding(.vertical, Space.xs)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .shadow(color: .black.opacity(0.35), radius: 12, y: 4)
    }
}

/// "Replying to theo's agent: the first line…" above the message box, with ✕ to cancel.
struct ReplyBar: View {
    let who: String
    let text: String
    let cancel: () -> Void
    var body: some View {
        HStack(spacing: 10) {
            Capsule().fill(Theme.accent).frame(width: 3, height: 30)
            VStack(alignment: .leading, spacing: 1) {
                Text("Replying to \(who)").font(Typo.micro.weight(.semibold)).foregroundStyle(Theme.accent)
                Text(text.split(separator: "\n").first.map(String.init) ?? text).font(Typo.micro).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: Space.s)
            Button(action: cancel) {
                Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.muted)
                    .frame(width: 24, height: 24).background(Theme.raised, in: Circle())
                    .frame(width: 44, height: 40).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel reply")
        }
        .padding(.leading, Space.m)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("replying-to")
    }
}

/// Swipe a message right to reply (a horizontal pan only: scrolling and the back swipe from the edge are untouched).
struct SwipeToReply: UIGestureRecognizerRepresentable {
    var changed: (CGFloat) -> Void
    var ended: (CGFloat) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let g = UIPanGestureRecognizer()
        g.delegate = context.coordinator
        return g
    }

    func handleUIGestureRecognizerAction(_ g: UIPanGestureRecognizer, context: Context) {
        let dx = max(0, g.translation(in: g.view).x)
        switch g.state {
        case .changed: changed(dx)
        case .ended, .cancelled, .failed: ended(dx)
        default: break
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard let p = g as? UIPanGestureRecognizer else { return false }
            let v = p.velocity(in: p.view)
            return v.x > 0 && abs(v.x) > abs(v.y) * 1.6 && p.location(in: nil).x > 28 // not the back swipe
        }
    }
}

struct EntryRow: View {
    let e: Entry
    var grouped = false
    var mine = false
    var board = "" // the board's id
    var tasks: [WorkTask] = [] // the board's tasks, so a task posted here shows as it is now
    var reactions: [Reaction] = [] // on this message (agents' 👀 / ✅: read and working / done)
    var parent: Entry? = nil // what this one answers
    var me: String? = nil
    var reply: (() -> Void)? = nil // answer this message (nil: it can't be answered yet)
    var retry: () -> Void = {}
    @State private var drag: CGFloat = 0 // swipe right to reply

    private var who: String { e.byAgent ? "\(e.author)'s agent" : e.author }
    private let replyAt: CGFloat = 56

    var body: some View {
        Group { if mine && e.type != "task" { myMessage } else { theirMessage } }
            .offset(x: drag)
            .background(alignment: .leading) {
                // The reply arrow surfaces from the left edge as you swipe.
                Image(systemName: "arrowshape.turn.up.left.fill").font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(drag >= replyAt ? Theme.accent : Theme.muted)
                    .frame(width: 28, height: 28).background(Theme.raised, in: Circle())
                    .scaleEffect(min(1, 0.5 + drag / replyAt / 2)).opacity(min(1, drag / replyAt))
                    .offset(x: -36 + min(drag, replyAt) * 0.6)
            }
            .contextMenu {
                if let reply { Button("Reply", systemImage: "arrowshape.turn.up.left", action: reply) }
                Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = e.text; Haptic.tap() }
                if e.failed == true { Button("Retry", systemImage: "arrow.clockwise", action: retry) }
            }
            .gesture(SwipeToReply(changed: { dx in
                guard reply != nil else { return }
                let d = dx < replyAt ? dx : replyAt + (dx - replyAt) * 0.25 // rubber band past the threshold
                if (drag < replyAt) != (d < replyAt) { Haptic.tap() }
                drag = d
            }, ended: { _ in
                if drag >= replyAt { reply?() }
                withAnimation(.spring(duration: 0.35, bounce: 0.3)) { drag = 0 }
            }))
    }

    /// What this message answers, as one light line above it.
    @ViewBuilder private var quote: some View {
        if let p = parent {
            HStack(spacing: 6) {
                Capsule().fill(Theme.faint.opacity(0.6)).frame(width: 2)
                (Text(p.byAgent ? "\(p.author)'s agent" : (p.author == me && p.via != "agent" ? "You" : p.author)).fontWeight(.semibold) + Text("  " + (p.text.split(separator: "\n").first.map(String.init) ?? p.text)))
                    .font(Typo.micro).foregroundStyle(Theme.muted).lineLimit(1)
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 1)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("reply-quote")
        }
    }

    /// A question, a claim, a decision: said in words, not as a type tag.
    private var kind: String? {
        switch e.type {
        case "note", "task": return nil
        case "artifact": return "File"
        default: return e.type.prefix(1).uppercased() + e.type.dropFirst()
        }
    }

    /// Yours: a right-aligned bubble, like any messenger.
    private var myMessage: some View {
        VStack(alignment: .trailing, spacing: Space.xs) {
            if let k = kind { Text(k).font(Typo.micro.weight(.medium)).foregroundStyle(Theme.faint) }
            quote
            Text(e.text.md)
                .font(Typo.body).foregroundStyle(Theme.text.opacity(e.pending == true ? 0.55 : 1))
                .padding(.horizontal, Space.m + 1).padding(.vertical, Space.s)
                .background(Theme.raised, in: RoundedRectangle(cornerRadius: Radius.bubble, style: .continuous))
            if !reactions.isEmpty { ReactionLine(reactions: reactions, trailing: true) }
            if e.pending == true {
                Text("Sending…").font(.caption2).foregroundStyle(Theme.faint)
            } else if e.failed == true {
                Button(action: retry) { Label("Not sent. Tap to retry", systemImage: "exclamationmark.circle").font(.caption2.weight(.semibold)) }
                    .buttonStyle(.plain).foregroundStyle(Theme.danger)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 56)
        .padding(.top, grouped ? Space.xs : Space.m)
    }

    /// Everyone else (people and agents): plain text under who said it.
    private var theirMessage: some View {
        HStack(alignment: .top, spacing: 10) {
            if grouped { Color.clear.frame(width: 28, height: 1) } else { Avatar(name: e.author, agent: e.byAgent, size: 28) }
            VStack(alignment: .leading, spacing: Space.xxs) {
                if !grouped {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(who).font(Typo.secondary.weight(.semibold)).foregroundStyle(Theme.text).lineLimit(1)
                        if let k = kind { Text(k).font(Typo.micro.weight(.medium)).foregroundStyle(e.type == "question" ? Theme.warn : Theme.faint) }
                        if let to = e.to { Text("to \(to)").font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1) }
                        Spacer(minLength: Space.xs)
                        Text(e.ts.ago).font(Typo.micro).foregroundStyle(Theme.faint).monospacedDigit()
                    }
                }
                if let a = e.artifactName {
                    // A file: a quiet chip with its name (not a terminal line).
                    Label(a, systemImage: "doc.text.fill").font(Typo.meta.weight(.medium)).foregroundStyle(Theme.muted)
                        .padding(.horizontal, Space.s + 2).padding(.vertical, 6)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .padding(.vertical, Space.xxs)
                }
                quote
                if e.type == "task" { TaskCard(seq: e.seq, board: board, text: e.text, tasks: tasks).padding(.top, Space.xxs) } else {
                    Text(e.text.md).font(Typo.body).foregroundStyle(Theme.text.opacity(0.92)).lineSpacing(1.5)
                }
                if !reactions.isEmpty { ReactionLine(reactions: reactions, trailing: false) }
            }
        }
        .padding(.top, grouped ? Space.xs : Space.s + 2)
    }
}

/// "Today", "Yesterday", or the date, between days.
struct DaySeparator: View {
    let ts: Double
    var body: some View {
        let d = Date(timeIntervalSince1970: ts / 1000)
        let label = Calendar.current.isDateInToday(d) ? "Today" : Calendar.current.isDateInYesterday(d) ? "Yesterday" : d.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
        Text(label).font(Typo.micro.weight(.semibold)).foregroundStyle(Theme.faint)
            .frame(maxWidth: .infinity).padding(.top, Space.l).padding(.bottom, Space.xxs)
    }
}

/// A grey stand-in while a board loads for the first time (no blank flash).
struct PlaceholderMessage: View {
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle().fill(Theme.card).frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 6) {
                RoundedRectangle(cornerRadius: 4).fill(Theme.card).frame(width: 110, height: 11)
                RoundedRectangle(cornerRadius: 4).fill(Theme.card).frame(maxWidth: .infinity).frame(height: 11)
                RoundedRectangle(cornerRadius: 4).fill(Theme.card).frame(width: 180, height: 11)
            }
        }
        .padding(.top, Space.l)
    }
}

/// A task posted in the chat, shown as what it is (a task with a checklist), not as raw "- [ ]" text.
/// A task in the chat as it is now, not as it was posted: live title, who's on it, its checklist ticking off
/// as the work gets done, and its sub-tasks. Tap for the whole task.
struct TaskCard: View {
    let seq: Int
    let board: String
    let text: String
    let tasks: [WorkTask]
    @State private var open = false

    var body: some View {
        let t = tasks.first { $0.seq == seq }
        let subs = tasks.filter { $0.parent == seq }.sorted { $0.seq < $1.seq }
        // A checklist line that is also a sub-task shows once, as the sub-task (it has its own ring and owner).
        let items = (t?.items ?? []).filter { it in !subs.contains { $0.covers(it.text) } }
        Button { if t != nil { Haptic.tap(); open = true } } label: {
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(alignment: .top, spacing: 10) {
                    Group {
                        if let t { ProgressRing(task: t).frame(width: 16, height: 16) } else {
                            Image(systemName: "circle.dashed").font(.system(size: 15)).foregroundStyle(Theme.muted)
                        }
                    }
                    .padding(.top, 2)
                    VStack(alignment: .leading, spacing: Space.xxs) {
                        Text((t?.title ?? String(text.split(separator: "\n").first ?? Substring(text))).md)
                            .font(Typo.secondary.weight(.semibold)).foregroundStyle(t?.status == "done" ? Theme.muted : Theme.text).lineLimit(2)
                        Text(t.map { $0.caption } ?? "Task").font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                if !items.isEmpty || !subs.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(items.prefix(6).enumerated()), id: \.offset) { _, it in CheckLine(text: it.text, done: it.done, compact: true) }
                        if items.count > 6 { Text("+\(items.count - 6) more").font(Typo.micro).foregroundStyle(Theme.faint) }
                        ForEach(subs.prefix(6)) { s in SubTaskLine(task: s) }
                    }
                    .padding(.leading, 26)
                }
            }
            .padding(.horizontal, Space.m).padding(.vertical, 10)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .animation(.smooth, value: t)
            .animation(.smooth, value: subs)
        }
        .buttonStyle(PressStyle())
        .accessibilityIdentifier("task-card-\(seq)")
        .accessibilityValue(t?.caption ?? "")
        .sheet(isPresented: $open) {
            NavigationStack {
                TaskDetail(seq: seq, board: board)
                    .navigationDestination(for: Int.self) { s in TaskDetail(seq: s, board: board) }
            }
                .presentationDetents([.medium, .large]).presentationBackground(Theme.bg)
        }
    }
}

/// Everyone's agents on this board, grouped by what they're doing: working now, idle, gone. Each with what it
/// said it's doing.
struct AgentsHereSheet: View {
    @EnvironmentObject var state: AppState
    let board: Board
    var body: some View {
        let all = (state.boardAgents[board.id] ?? []).sorted { $0.lastSeen > $1.lastSeen }
        NavigationStack {
            List {
                if all.isEmpty { Text("No agents on this board yet.").font(Typo.secondary).foregroundStyle(Theme.muted).listRowBackground(Theme.card) }
                ForEach([("live", "Working now", Theme.ok), ("idle", "Idle", Theme.muted), ("gone", "Gone", Theme.faint)], id: \.0) { key, title, color in
                    let group = all.filter { ($0.state == "live" || $0.state == "idle" ? $0.state : "gone") == key }
                    if !group.isEmpty {
                        Section {
                            ForEach(group) { a in AgentHereRow(a: a) }
                        } header: { Text("\(title) · \(group.count)").font(Typo.section).foregroundStyle(color).textCase(nil) }
                        .listRowBackground(Theme.card)
                    }
                }
            }
            .listSectionSpacing(.compact)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Agents here")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await state.loadAgents(board) }
            .toolbar { BoardInfoToolbar(board: board) } // members, invite, files, rename, archive (BoardInfoView.swift)
        }
    }
}

/// One agent here: its state, whose it is, which tool, and what it says it's doing.
private struct AgentHereRow: View {
    let a: BoardAgent
    var body: some View {
        HStack(spacing: Space.m) {
            Avatar(name: a.user, agent: true, size: 32)
                .overlay(alignment: .bottomTrailing) { StateDot(state: a.state).padding(2).background(Theme.card, in: Circle()).offset(x: 4, y: 4) }
            VStack(alignment: .leading, spacing: Space.xxs) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(a.label).font(Typo.rowTitle).foregroundStyle(Theme.text).lineLimit(1)
                    if let d = a.detail { Text(d).font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1) }
                }
                Text(a.status ?? stateLine(a.state, a.lastSeen)).font(Typo.secondary).foregroundStyle(a.state == "live" ? Theme.ok : Theme.muted).lineLimit(2)
            }
        }
        .padding(.vertical, Space.xxs)
    }
}

/// live: green and breathing; idle: grey; gone: an empty ring.
struct StateDot: View {
    let state: String?
    var body: some View {
        switch state {
        case "live": LiveDot(size: 8)
        case "idle": Circle().fill(Theme.faint).frame(width: 8, height: 8)
        default: Circle().stroke(Theme.faint, lineWidth: 1.2).frame(width: 8, height: 8)
        }
    }
}

func stateLine(_ state: String?, _ lastSeen: Double) -> String {
    switch state {
    case "live": return "working now"
    case "idle": return "idle · last active \(lastSeen.ago) ago".replacingOccurrences(of: "now ago", with: "just now")
    default: return "gone · last seen \(lastSeen.ago) ago".replacingOccurrences(of: "now ago", with: "just now")
    }
}

/// Reactions under a message. Agents' 👀 (read it, working) and ✅ (done) read like a messenger's receipts:
/// "👀 theo's agent". Others are compact: "👍 2".
struct ReactionLine: View {
    let reactions: [Reaction]
    let trailing: Bool
    var body: some View {
        HStack(spacing: 8) {
            ForEach(reactions, id: \.emoji) { r in
                let receipt = r.emoji == "👀" || r.emoji == "✅"
                HStack(spacing: 3) {
                    Text(r.emoji).font(.caption2)
                    Text(receipt ? names(r.users) : "\(r.users.count)").font(.caption2).foregroundStyle(r.emoji == "✅" ? Theme.ok : Theme.faint).lineLimit(1)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(receipt ? "\(r.emoji == "👀" ? "Seen, working" : "Done"): \(names(r.users))" : "\(r.emoji) \(r.users.count)")
            }
        }
        .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
        .padding(.top, 2)
        .transition(.opacity)
    }
    private func names(_ users: [String]) -> String { users.count <= 2 ? users.joined(separator: ", ") : "\(users[0]) and \(users.count - 1) more" }
}
