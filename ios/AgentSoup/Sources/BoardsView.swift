// One board or DM: opens on what you saw last (cached), refreshes in place, marks itself read, and sends instantly
// (your message shows at once; if it can't be delivered it says so and you tap to retry).

import SwiftUI

struct BoardView: View {
    @EnvironmentObject var state: AppState
    let board: Board
    @State private var draft = ""
    @State private var showTasks = false
    @State private var showAgents = false
    private var live: [BoardAgent] { (state.boardAgents[board.id] ?? []).filter { $0.state == "live" } }
    /// "theo's agent working", "codex and 2 more working", or "no agents working now".
    private var presence: String {
        let names = live.map(\.label)
        if names.isEmpty { return board.encrypted == true ? "End-to-end encrypted" : "No agents working now" }
        return (names.count == 1 ? names[0] : "\(names[0]) and \(names.count - 1) more") + " working"
    }
    @FocusState private var focused: Bool

    private var list: [Entry] { state.entries[board.id] ?? [] }
    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    @State private var atBottom = true
    @State private var stick = true // pinned to the latest until you scroll up yourself (like any messenger)
    @State private var position = ScrollPosition(edge: .bottom) // like any messenger: you start at the latest

    var body: some View {
        ScrollView {
                // Placeholders and messages are separate containers: sharing one list would give them colliding ids
                // (placeholder 1… and message #1…), and SwiftUI kept showing placeholders in place of messages.
                if state.entries[board.id] == nil {
                    VStack(alignment: .leading, spacing: 0) { ForEach(0..<6, id: \.self) { _ in PlaceholderMessage() } }
                        .padding(.horizontal, 16).padding(.vertical, 12)
                        .transition(.opacity)
                }
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(list.enumerated()), id: \.element.id) { i, e in
                        let prev = i > 0 ? list[i - 1] : nil
                        let newDay = prev.map { !Calendar.current.isDate(Date(timeIntervalSince1970: $0.ts / 1000), inSameDayAs: Date(timeIntervalSince1970: e.ts / 1000)) } ?? true
                        let grouped = !newDay && prev != nil && prev!.author == e.author && prev!.via == e.via && e.ts - prev!.ts < 5 * 60_000 && e.type == "note"
                        let mine = e.author == state.me?.owner && e.via != "agent"
                        let prevMine = prev.map { $0.author == state.me?.owner && $0.via != "agent" && $0.type != "task" } ?? false
                        VStack(alignment: .leading, spacing: 0) {
                            if newDay { DaySeparator(ts: e.ts) }
                            // A hairline between separate messages from others (bubbles are separate already).
                            else if !(mine && e.type != "task") && !prevMine { Rectangle().fill(Theme.line.opacity(grouped ? 0.5 : 1)).frame(height: 0.5).padding(.leading, 36).padding(.top, grouped ? 6 : 12) }
                            EntryRow(e: e, grouped: grouped, mine: mine, board: board.id, tasks: state.tasks[board.id] ?? []) { Task { await state.send(e.text, to: board, retrying: e) } }
                        }
                        .id(e.id)
                        .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
                    }
                }
                .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 12)
            }
            .scrollPosition($position)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            // At the latest: the visible part (which includes what's under the composer) reaches the end.
            .onScrollGeometryChange(for: Bool.self) { g in g.visibleRect.maxY >= g.contentSize.height - 80 } action: { _, bottom in
                if bottom != atBottom { withAnimation(.snappy) { atBottom = bottom } }
            }
            // Only your own scrolling unpins it; reaching the bottom again re-pins.
            .onScrollPhaseChange { old, phase in
                if phase == .interacting { stick = false }
                else if phase == .idle && (old == .interacting || old == .decelerating) { stick = atBottom } // after a swipe, not our own scrolls
            }
            // Whatever grows (messages loading, older ones filling in, cards and the task strip arriving), a pinned
            // chat stays on the latest: it opens at the bottom and stays there.
            .onScrollGeometryChange(for: CGFloat.self) { g in g.contentSize.height + g.containerSize.height } action: { _, _ in
                if stick { position.scrollTo(edge: .bottom) }
            }
            .onChange(of: list.last?.id) { _, _ in
                // Yours always scrolls into view (and re-pins); others' do if you're pinned.
                if list.last.map({ $0.author == state.me?.owner && $0.via != "agent" }) == true { stick = true }
                if stick { withAnimation(.smooth) { position.scrollTo(edge: .bottom) } }
            }
            .onChange(of: focused) { _, f in if f { stick = true; withAnimation(.smooth) { position.scrollTo(edge: .bottom) } } }
            .overlay(alignment: .bottomTrailing) {
                if !atBottom && !list.isEmpty {
                    Button { Haptic.tap(); stick = true; withAnimation(.smooth) { position.scrollTo(edge: .bottom) } } label: {
                        Image(systemName: "chevron.down").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text)
                            .frame(width: 38, height: 38).background(Theme.raised, in: Circle())
                            .overlay(Circle().stroke(Theme.line, lineWidth: 0.5))
                    }
                    .padding(.trailing, 14).padding(.bottom, 10)
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                    .accessibilityLabel("Jump to latest")
                }
            }
        .safeAreaInset(edge: .top, spacing: 0) { WorkStrip(tasks: state.tasks[board.id] ?? []) { Haptic.tap(); showTasks = true } }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .sheet(isPresented: $showTasks) { TasksSheet(board: board).presentationDetents([.medium, .large]).presentationBackground(Theme.bg) }
        .navigationTitle(board.title)
        .toolbar {
            // The title, and under it who's working here right now (tap for everyone, live / idle / gone).
            ToolbarItem(placement: .principal) {
                Button { Haptic.tap(); showAgents = true } label: {
                    VStack(spacing: 1) {
                        Text(board.title).font(.headline).foregroundStyle(Theme.text).lineLimit(1)
                        HStack(spacing: 5) {
                            if board.encrypted == true { Image(systemName: "lock.fill").font(.system(size: 9)).foregroundStyle(Theme.faint) }
                            if !live.isEmpty { LiveDot(size: 6) }
                            Text(presence).font(.caption2).foregroundStyle(live.isEmpty ? Theme.faint : Theme.ok).lineLimit(1)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("presence")
            }
        }
        .sheet(isPresented: $showAgents) { AgentsHereSheet(board: board).presentationDetents([.medium]).presentationBackground(Theme.bg) }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar) // inside a conversation the message box owns the bottom edge
        .task { async let e: Void = state.loadEntries(board); async let t: Void = state.loadTasks(board); async let a: Void = state.loadAgents(board); _ = await (e, t, a); await state.markRead(board) }
        .onChange(of: state.pulse) { _, p in if p?.board == board.id { Task { async let e: Void = state.loadEntries(board); async let t: Void = state.loadTasks(board); async let a: Void = state.loadAgents(board); _ = await (e, t, a); await state.markRead(board) } } }
        .task(id: board.id) { await state.watch(board) } // live: ticks and new messages as they happen
        .refreshable { await state.loadEntries(board) }
    }

    var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(board.kind == "direct" ? "Message" : "Message \(board.title)", text: $draft, axis: .vertical)
                .lineLimit(1...6).focused($focused)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.line, lineWidth: 0.5))
                .accessibilityIdentifier("composer")
            Button(action: send) {
                Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold))
                    .frame(width: 36, height: 36)
                    .background(canSend ? Theme.accent : Theme.line, in: Circle())
                    .foregroundStyle(canSend ? .black : Theme.faint)
                    .scaleEffect(canSend ? 1 : 0.92)
                    .animation(.snappy, value: canSend)
            }
            .disabled(!canSend)
            .accessibilityIdentifier("send")
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.bar)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        Haptic.tap()
        Task { await state.send(text, to: board) }
    }
}

struct EntryRow: View {
    let e: Entry
    var grouped = false
    var mine = false
    var board = "" // the board's id
    var tasks: [WorkTask] = [] // the board's tasks, so a task posted here shows as it is now
    var retry: () -> Void = {}

    private var who: String { e.byAgent ? "\(e.author)'s agent" : e.author }

    var body: some View {
        Group { if mine && e.type != "task" { myMessage } else { theirMessage } }
            .contextMenu {
                Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = e.text; Haptic.tap() }
                if e.failed == true { Button("Retry", systemImage: "arrow.clockwise", action: retry) }
            }
    }

    /// Yours: a right-aligned bubble, like any messenger.
    private var myMessage: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if e.type != "note" { Text(e.type).font(.caption2.weight(.medium)).foregroundStyle(Theme.faint) }
            Text(e.text.md)
                .font(.callout).foregroundStyle(Theme.text.opacity(e.pending == true ? 0.55 : 1))
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(Theme.raised, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                
            if e.pending == true {
                Text("Sending…").font(.caption2).foregroundStyle(Theme.faint)
            } else if e.failed == true {
                Button(action: retry) { Label("Not sent. Tap to retry", systemImage: "exclamationmark.circle").font(.caption2.weight(.semibold)) }
                    .buttonStyle(.plain).foregroundStyle(Theme.danger)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
        .padding(.top, grouped ? 4 : 14)
    }

    /// Everyone else (people and agents): plain text under who said it.
    private var theirMessage: some View {
        HStack(alignment: .top, spacing: 10) {
            if grouped { Color.clear.frame(width: 26, height: 1) } else { Avatar(name: e.author, agent: e.byAgent, size: 26) }
            VStack(alignment: .leading, spacing: 3) {
                if !grouped {
                    HStack(spacing: 6) {
                        Text(who).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.text)
                        if e.type != "note" && e.type != "task" { Text(e.type).font(.caption).foregroundStyle(e.type == "question" ? Theme.warn : Theme.faint) }
                        if let to = e.to { Text("→ \(to)").font(.caption).foregroundStyle(Theme.faint) }
                        Spacer(minLength: 4)
                        Text(e.ts.ago).font(.caption2).foregroundStyle(Theme.faint)
                    }
                }
                if let a = e.artifactName { Label(a, systemImage: "doc.text").font(.caption.monospaced()).foregroundStyle(Theme.muted) }
                if e.type == "task" { TaskCard(seq: e.seq, board: board, text: e.text, tasks: tasks) } else {
                    Text(e.text.md).font(.callout).foregroundStyle(Theme.text.opacity(0.92)).lineSpacing(2)
                }
            }
        }
        .padding(.top, grouped ? 6 : 12)
    }
}

/// "Today", "Yesterday", or the date, between days.
struct DaySeparator: View {
    let ts: Double
    var body: some View {
        let d = Date(timeIntervalSince1970: ts / 1000)
        let label = Calendar.current.isDateInToday(d) ? "Today" : Calendar.current.isDateInYesterday(d) ? "Yesterday" : d.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
        Text(label).font(.caption2.weight(.semibold)).foregroundStyle(Theme.faint)
            .frame(maxWidth: .infinity).padding(.top, 18).padding(.bottom, 2)
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
        .padding(.top, 16)
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
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 10) {
                    if let t { ProgressRing(task: t).frame(width: 16, height: 16) } else {
                        Image(systemName: "circle.dashed").font(.system(size: 15)).foregroundStyle(Theme.muted)
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text((t?.title ?? String(text.split(separator: "\n").first ?? Substring(text))).md)
                            .font(.callout.weight(.medium)).foregroundStyle(t?.status == "done" ? Theme.muted : Theme.text).lineLimit(2)
                        Text(t.map { $0.caption } ?? "Task").font(.caption).foregroundStyle(Theme.faint).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                if !items.isEmpty || !subs.isEmpty {
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(Array(items.prefix(6).enumerated()), id: \.offset) { _, it in CheckLine(text: it.text, done: it.done) }
                        if items.count > 6 { Text("+\(items.count - 6) more").font(.caption).foregroundStyle(Theme.faint) }
                        ForEach(subs.prefix(6)) { s in SubTaskLine(task: s) }
                    }
                    .padding(.leading, 26)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.line, lineWidth: 0.5))
            .animation(.smooth, value: t)
            .animation(.smooth, value: subs)
        }
        .buttonStyle(.plain)
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

/// Everyone's agents on this board: working now, idle, or gone, with what they said they're doing.
struct AgentsHereSheet: View {
    @EnvironmentObject var state: AppState
    let board: Board
    var body: some View {
        let all = (state.boardAgents[board.id] ?? []).sorted { ($0.state == "live" ? 0 : $0.state == "idle" ? 1 : 2, -$0.lastSeen) < ($1.state == "live" ? 0 : $1.state == "idle" ? 1 : 2, -$1.lastSeen) }
        NavigationStack {
            List {
                if all.isEmpty { Text("No agents on this board yet.").foregroundStyle(Theme.muted).listRowBackground(Theme.card) }
                ForEach(all) { a in
                    HStack(spacing: 12) {
                        StateDot(state: a.state)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(a.label).font(.body.weight(.medium)).foregroundStyle(Theme.text)
                                if let c = a.client { Text(c).font(.caption).foregroundStyle(Theme.faint) }
                            }
                            Text(a.status ?? stateLine(a.state, a.lastSeen)).font(.subheadline).foregroundStyle(a.state == "live" ? Theme.ok : Theme.muted).lineLimit(2)
                        }
                    }
                    .listRowBackground(Theme.card)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Agents here")
            .navigationBarTitleDisplayMode(.inline)
            .refreshable { await state.loadAgents(board) }
        }
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
