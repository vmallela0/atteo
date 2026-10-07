// Notifications, until real push (#1007): the app icon's badge counts what needs you, and while Atteo is in the
// background iOS wakes it now and then (a background app refresh) to look at your inbox and approvals; anything new
// that's for you (a mention, a reply, an approval, a decision) becomes a local notification. Tapping one opens its
// chat. An end-to-end encrypted board's message is decrypted here, on the phone; a push for one carries only
// ciphertext, and the notification extension (NotifyExtension/) does the same. Permission is asked when it makes
// sense (after you've sent your first message or answered an approval, or from Settings), never at launch.

import BackgroundTasks
import SwiftUI
import UserNotifications

@MainActor
final class Notifier: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    static let refreshTask = "com.atteo.app.refresh"
    private static let seenKey = "notified-ids", askedKey = "notifications-asked"
    private static let pendingKey = "digest-pending", digestAtKey = "digest-at"
    /// The inbox, with this phone's time zone (the digest's times are local until you save quiet hours).
    nonisolated static var inboxPath: String {
        "/api/inbox?tz=" + (TimeZone.current.identifier.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "UTC")
    }

    @Published private(set) var status: UNAuthorizationStatus = .notDetermined

    /// At launch: tapping a notification comes here; what's allowed is read.
    func setUp() {
        UNUserNotificationCenter.current().delegate = self
        Task { await readStatus() }
    }

    func readStatus() async {
        status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// Asks once, at a moment that makes sense (you've just done something you'd want to hear back about).
    func askIfSensible() {
        guard !UserDefaults.standard.bool(forKey: Self.askedKey) else { return }
        #if DEBUG
        if API.environment("STILL") != nil { return } // UI tests: no system prompt in the way
        #endif
        Task { await ask() }
    }

    /// Asks for alerts, sounds and the badge (Settings → Notifications asks too).
    @discardableResult
    func ask() async -> Bool {
        UserDefaults.standard.set(true, forKey: Self.askedKey)
        let ok = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        await readStatus()
        if ok { await badge(AppState.shared.needsYou) }
        return ok
    }

    /// The app icon's number: everything that needs you.
    func badge(_ n: Int) async {
        guard status == .authorized || status == .provisional else { return }
        try? await UNUserNotificationCenter.current().setBadgeCount(n)
    }

    static func approvalName(state: AppState) -> String {
        let owner = state.me?.owner ?? ""
        return state.agentDisplayName(for: owner).map { agentLabel(owner, $0) } ?? String(localized: "Your agent", bundle: .l10n)
    }

    static func senderName(_ i: InboxItem, state: AppState) -> String {
        if i.kind == "approval" { return approvalName(state: state) }
        if i.actorVia == "agent" { return i.actorName.map { agentLabel(i.actor, $0) } ?? state.displayName(for: i.actor, agent: true) }
        return state.displayName(for: i.actor)
    }

    /// What's new for you since last time: notifies (only when Atteo isn't on screen) and keeps the badge right.
    /// The first look ever only notes what's there, so an old inbox doesn't arrive as a pile of notifications.
    /// Only what interrupts notifies at once (the server's `interrupt`: your level for the board and your quiet hours);
    /// digest items wait, and once the digest's slot passes they arrive as one summary (vedu #2490).
    func check(inbox: [InboxItem], approvals: [Approval], notify: Bool, summary: NotifySummary? = nil) async {
        let ids = Set(inbox.filter { $0.readAt == nil }.map { "i\($0.id)" } + approvals.map { "a\($0.id)" })
        let stored = UserDefaults.standard.array(forKey: Self.seenKey) as? [String]
        defer { UserDefaults.standard.set(Array(ids.union(stored ?? []).suffix(500)), forKey: Self.seenKey) }
        // On screen, you're looking at all of it: nothing waits for a digest.
        if !notify { Self.setPending([]); if let d = summary?.digestAt { UserDefaults.standard.set(d, forKey: Self.digestAtKey) } }
        guard let stored, notify, status == .authorized || status == .provisional else { return }
        let seen = Set(stored)
        let center = UNUserNotificationCenter.current()
        var pending = Self.pending()
        let approvalMode = Dictionary(inbox.compactMap { i in i.approvalId.map { ($0, i.interrupt ?? "now") } }, uniquingKeysWith: { a, _ in a })
        let titles = Dictionary(inbox.map { ($0.boardId, $0.boardTitle) }, uniquingKeysWith: { a, _ in a })
        defer { Self.setPending(pending) }
        for a in approvals where !seen.contains("a\(a.id)") {
            switch approvalMode[a.id] ?? "now" {
            case "digest": pending.append(DigestEntry(board: a.boardId.flatMap { titles[$0] ?? nil }, kind: "approval")); continue
            case "none": continue
            default: break
            }
            let c = UNMutableNotificationContent()
            let agent = Self.approvalName(state: AppState.shared)
            c.title = String(localized: "\(agent) asks: \(a.title)", bundle: .l10n)
            c.body = a.previewDetails.isEmpty ? String(localized: "Approve or deny in Atteo.", bundle: .l10n) : String(a.previewDetails.prefix(180))
            c.sound = .default
            c.userInfo = a.boardId.map { ["board": $0] } ?? [:]
            c.threadIdentifier = "approvals"
            try? await center.add(UNNotificationRequest(identifier: "a\(a.id)", content: c, trigger: nil))
        }
        var opened = 0
        let encrypted = Set(AppState.shared.boards.filter { $0.encrypted == true }.map(\.id)), full = PushPreview.full
        for i in inbox where i.readAt == nil && !seen.contains("i\(i.id)") {
            if i.kind == "approval", i.approvalId != nil { continue } // its request arrives above, once
            let mode = i.interrupt ?? (Self.worthIt(i.kind) ? "now" : "none") // an older server: as before
            if mode == "digest" { pending.append(DigestEntry(board: i.boardTitle, kind: i.kind)); continue }
            guard mode == "now" else { continue }
            let c = UNMutableNotificationContent()
            let who = Self.senderName(i, state: AppState.shared)
            c.title = i.boardTitle.map { String(localized: "\(who) in \($0)", bundle: .l10n, comment: "Notification title: who wrote, in which board") } ?? who
            c.body = String(i.excerpt.prefix(180))
            if Self.sealed(i, encryptedBoards: encrypted) {
                // End-to-end encrypted: the server only has ciphertext; this phone reads it, or says only that it's new.
                // At most 5 fetched per look, so a background wake (about 30 seconds) still gets to notify.
                // Only if you've chosen to see encrypted messages in notifications (PushPreview, off by default).
                opened += 1
                let text = full && opened <= 5 ? await BoardCrypto.shared.text(i.boardId, seq: i.seq) : nil
                c.body = text.map { String($0.prefix(180)) } ?? String(localized: "New message (end-to-end encrypted)", bundle: .l10n)
            }
            c.sound = .default
            c.userInfo = i.boardId.isEmpty ? [:] : ["board": i.boardId, "seq": i.seq]
            c.threadIdentifier = i.boardId
            try? await center.add(UNNotificationRequest(identifier: "i\(i.id)", content: c, trigger: nil))
        }
        // The digest: once its slot passes (the server says when, in your zone, skipping quiet hours), one summary.
        if let due = summary?.digestAt, due > UserDefaults.standard.double(forKey: Self.digestAtKey) {
            if !pending.isEmpty {
                let c = UNMutableNotificationContent()
                c.title = DigestSummary.title(pending)
                c.body = DigestSummary.body(pending)
                c.threadIdentifier = "digest"
                try? await center.add(UNNotificationRequest(identifier: "digest-\(Int(due))", content: c, trigger: nil))
            }
            pending = []
            UserDefaults.standard.set(due, forKey: Self.digestAtKey)
        }
    }

    /// What's waiting for the next digest (kept between background wakes).
    static func pending() -> [DigestEntry] {
        guard let d = UserDefaults.standard.data(forKey: pendingKey) else { return [] }
        return (try? JSONDecoder().decode([DigestEntry].self, from: d)) ?? []
    }
    static func setPending(_ p: [DigestEntry]) {
        UserDefaults.standard.set(try? JSONEncoder().encode(Array(p.suffix(200))), forKey: pendingKey)
    }

    /// A message on an end-to-end encrypted board: the board says so, or the server's stand-in does ("🔒 encrypted",
    /// src/board.ts, for every notification there; an older server's "🔒 Encrypted message").
    nonisolated static func sealed(_ i: InboxItem, encryptedBoards: Set<String>) -> Bool {
        !i.boardId.isEmpty && i.seq > 0 && (encryptedBoards.contains(i.boardId) || i.excerpt == "🔒 encrypted" || i.excerpt.hasPrefix("🔒 Encrypted message"))
    }

    /// Mentions, replies, decisions and approvals: what's for you. (Friend and contact notes stay in the app.)
    private static func worthIt(_ kind: String) -> Bool { ["mention", "agent", "reply", "approval", "decision"].contains(kind) }

    /// A background wake: look, notify, and ask to be woken again.
    func backgroundCheck() async {
        schedule()
        guard Keychain.token != nil else { return }
        async let i = try? API.shared.get(Self.inboxPath, as: InboxResponse.self, timeout: 20)
        async let a = try? API.shared.get("/api/approvals", as: ApprovalsResponse.self, timeout: 20)
        let (ii, aa) = await (i, a)
        guard let ii, let aa else { return }
        await readStatus()
        await check(inbox: ii.items, approvals: aa.approvals, notify: true, summary: ii.notify)
        let needs = aa.approvals.count + ii.items.filter { $0.readAt == nil && !$0.boardId.isEmpty }.count + AppState.shared.contacts.count
        await badge(needs)
    }

    /// Asks iOS to wake Atteo in a while (it decides when: roughly every 15 minutes at best, less when you rarely use it).
    nonisolated func schedule() {
        let r = BGAppRefreshTaskRequest(identifier: Self.refreshTask)
        r.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(r)
    }

    // Tapping a notification: its chat.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let board = info["board"] as? String else { return }
        let seq = info["seq"] as? Int
        await MainActor.run {
            let s = AppState.shared
            guard let b = s.boards.first(where: { $0.id == board }) else { return }
            if let seq { s.jumpRequest = AppState.JumpRequest(board: board, seq: seq) }
            s.openRequest = b
        }
    }

    // On screen: no banner (the app already shows it).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [] }
}

/// Settings → Notifications: what's allowed, and a way to turn them on.
struct NotificationsSection: View {
    @ObservedObject private var notifier = Notifier.shared
    @State private var fullPreviews = PushPreview.full // encrypted chats: "New message" (off) or the words
    @Environment(\.openURL) private var openURL

    var body: some View {
        Section {
            HStack {
                Text("Notifications")
                Spacer()
                switch notifier.status {
                case .authorized, .provisional, .ephemeral:
                    Text("On").foregroundStyle(Theme.muted)
                case .denied:
                    Button("Open Settings") { if let u = URL(string: UIApplication.openSettingsURLString) { openURL(u) } }.buttonStyle(.borderless)
                default:
                    Button("Turn on") { Task { await notifier.ask() } }.buttonStyle(.borderless).fontWeight(.semibold)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("notifications-row")
            QuietHoursRows()
            Toggle("Show encrypted messages", isOn: $fullPreviews)
                .onChange(of: fullPreviews) { _, on in PushPreview.full = on }
                .accessibilityIdentifier("encrypted-previews")
        } footer: {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("A number on the app icon for what needs you. Approvals, @you, replies, decisions and DMs notify you at once; the rest comes in a digest. Change it per chat in its Info. iOS decides how often Atteo checks in the background.")
                Text("End-to-end encrypted chats say only “New message” unless you show their messages: then this phone decrypts them, and iOS keeps them with its notifications and can show them on the lock screen.")
            }
        }
        .listRowBackground(Theme.card)
        .task { await notifier.readStatus() }
    }
}
