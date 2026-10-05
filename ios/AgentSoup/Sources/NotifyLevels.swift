// Notification volume (vedu #2490, src/notify.ts): only what needs you interrupts; the rest comes in a digest.
// The server stamps each inbox item with `interrupt` (now, digest or none) from your level for its board and your quiet
// hours, so the web, this app and (later) real push all agree. Here: the level per board (board Info and the chat's ⋯
// menu), quiet hours (Settings → Notifications), and the digest's one-line summary.

import SwiftUI

/// How much a board may interrupt you.
enum NotifyLevel: String, CaseIterable, Identifiable {
    case everything, needsMe = "needs_me", off
    var id: String { rawValue }
    var label: String {
        switch self {
        case .everything: String(localized: "Everything", bundle: .l10n)
        case .needsMe: String(localized: "Needs me", bundle: .l10n)
        case .off: String(localized: "Off", bundle: .l10n)
        }
    }
    var hint: String {
        switch self {
        case .everything: String(localized: "Every message here notifies you.", bundle: .l10n)
        case .needsMe: String(localized: "Approvals, @you, replies, decisions and DMs notify you at once; the rest comes in a digest.", bundle: .l10n)
        case .off: String(localized: "Off: still in your Inbox, never a notification.", bundle: .l10n)
        }
    }
}

/// When the digest is due, and whether it's quiet now (GET /api/inbox's `notify`).
struct NotifySummary: Codable, Hashable {
    let quietNow: Bool
    let digestAt: Double?
    let digest: [String]
    let tz: String
}

/// What waited for the digest: which board, and what kind of message.
struct DigestEntry: Codable, Hashable {
    let board: String?
    let kind: String
}

/// The digest's notification: "5 updates since the last digest", and where ("3 in Launch · 2 in Design").
enum DigestSummary {
    static func title(_ entries: [DigestEntry]) -> String {
        String(localized: "\(entries.count) updates since the last digest", bundle: .l10n)
    }
    static func body(_ entries: [DigestEntry]) -> String {
        var counts: [String: Int] = [:], order: [String] = []
        for e in entries {
            let b = e.board ?? "Atteo"
            if counts[b] == nil { order.append(b) }
            counts[b, default: 0] += 1
        }
        let top = order.sorted { counts[$0]! > counts[$1]! || (counts[$0]! == counts[$1]! && order.firstIndex(of: $0)! < order.firstIndex(of: $1)!) }
        var parts = top.prefix(3).map { String(localized: "\(counts[$0]!) in \($0)", bundle: .l10n, comment: "Digest body: how many updates in which board") }
        if top.count > 3 { parts.append(String(localized: "\(top.count - 3) more", bundle: .l10n)) }
        return parts.joined(separator: " · ")
    }
}

/// Reads and saves your level for one board.
@MainActor
enum NotifyLevelStore {
    private struct LevelResponse: Decodable { let level: String }
    static func load(_ board: String) async -> NotifyLevel? {
        guard let r = try? await API.shared.get("/api/boards/\(board)/notify", as: LevelResponse.self) else { return nil }
        return NotifyLevel(rawValue: r.level)
    }
    static func save(_ board: String, _ level: NotifyLevel) async -> Bool {
        (try? await API.shared.send("/api/boards/\(board)/notify", method: "PUT", body: ["level": level.rawValue])) != nil
    }
}

/// Board Info → Notifications: Everything, Needs me (the default) or Off, with what that means.
struct NotifyLevelSection: View {
    let boardId: String
    @State private var level: NotifyLevel = .needsMe
    @State private var loaded = false

    var body: some View {
        Section {
            Picker("Notifications", selection: $level) {
                ForEach(NotifyLevel.allCases) { l in Text(l.label).tag(l) }
            }
            .pickerStyle(.segmented)
            .disabled(!loaded)
            .accessibilityIdentifier("notify-level")
            .onChange(of: level) { old, new in
                guard loaded, old != new else { return }
                Haptics.play(.touch)
                Task { if !(await NotifyLevelStore.save(boardId, new)) { level = old } }
            }
        } header: { SectionHeader("Notifications") } footer: { Text(verbatim: level.hint).accessibilityIdentifier("notify-level-hint") }
        .listRowBackground(Theme.card)
        .task {
            if let l = await NotifyLevelStore.load(boardId) { level = l }
            loaded = true
        }
    }
}

/// The chat's ⋯ menu: the same three levels.
struct NotifyLevelMenu: View {
    let boardId: String
    @State private var level: NotifyLevel = .needsMe

    var body: some View {
        Picker(selection: Binding(get: { level }, set: { new in
            let old = level
            level = new
            Task { if !(await NotifyLevelStore.save(boardId, new)) { level = old } }
        })) {
            ForEach(NotifyLevel.allCases) { l in Text(l.label).tag(l) }
        } label: {
            Label("Notifications", systemImage: level == .off ? "bell.slash" : "bell")
        }
        .pickerStyle(.menu)
        .accessibilityIdentifier("notify-level-menu")
        .task { if let l = await NotifyLevelStore.load(boardId) { level = l } }
    }
}

/// Settings → Notifications → Quiet hours: nothing interrupts then except urgent approvals (saved in this phone's zone).
struct QuietHoursRows: View {
    private struct Prefs: Decodable {
        struct Quiet: Decodable { let on: Bool; let start: String; let end: String; let tz: String }
        let quiet: Quiet
        let digest: [String]
    }
    @State private var on = false
    @State private var start = QuietHoursRows.date("22:00")
    @State private var end = QuietHoursRows.date("07:00")
    @State private var digest: [String] = ["09:00", "13:00", "18:00"]
    @State private var loaded = false

    static func date(_ hhmm: String) -> Date {
        let p = hhmm.split(separator: ":").compactMap { Int($0) }
        return Calendar.current.date(bySettingHour: p.first ?? 0, minute: p.count > 1 ? p[1] : 0, second: 0, of: Date()) ?? Date()
    }
    static func hhmm(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    var body: some View {
        Group {
            Toggle(isOn: $on) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Quiet hours")
                    Text("Nothing interrupts you then, except urgent approvals.").font(.caption).foregroundStyle(Theme.muted)
                }
            }
            .accessibilityIdentifier("quiet-hours")
            if on {
                DatePicker("Starts", selection: $start, displayedComponents: .hourAndMinute).accessibilityIdentifier("quiet-start")
                DatePicker("Ends", selection: $end, displayedComponents: .hourAndMinute).accessibilityIdentifier("quiet-end")
            }
            Text(verbatim: String(localized: "Digest at \(digest.joined(separator: ", ")).", bundle: .l10n))
                .font(.caption).foregroundStyle(Theme.muted)
                .accessibilityIdentifier("digest-times")
        }
        .disabled(!loaded)
        .onChange(of: on) { _, _ in save() }
        .onChange(of: start) { _, _ in save() }
        .onChange(of: end) { _, _ in save() }
        .task {
            let tz = TimeZone.current.identifier.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "UTC"
            if let p = try? await API.shared.get("/api/me/notify?tz=\(tz)", as: Prefs.self) {
                on = p.quiet.on; start = Self.date(p.quiet.start); end = Self.date(p.quiet.end); digest = p.digest
            }
            loaded = true
        }
    }

    private func save() {
        guard loaded else { return }
        let body: [String: Any] = ["quiet": ["on": on, "start": Self.hhmm(start), "end": Self.hhmm(end), "tz": TimeZone.current.identifier]]
        Task { _ = try? await API.shared.send("/api/me/notify", method: "PUT", body: body) }
    }
}
