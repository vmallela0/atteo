// Notifications, until real push (#1007): the app icon's badge counts what needs you, and while Atteo is in the
// background iOS wakes it now and then (a background app refresh) to look at your inbox and approvals; anything new
// that's for you (a mention, a reply, an approval, a decision) becomes a local notification. Tapping one opens its
// chat. Permission is asked when it makes sense (after you've sent your first message or answered an approval, or
// from Settings), never at launch.

import BackgroundTasks
import SwiftUI
import UserNotifications

@MainActor
final class Notifier: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    static let refreshTask = "com.atteo.app.refresh"
    private static let seenKey = "notified-ids", askedKey = "notifications-asked"

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

    /// What's new for you since last time: notifies (only when Atteo isn't on screen) and keeps the badge right.
    /// The first look ever only notes what's there, so an old inbox doesn't arrive as a pile of notifications.
    func check(inbox: [InboxItem], approvals: [Approval], notify: Bool) async {
        let ids = Set(inbox.filter { $0.readAt == nil }.map { "i\($0.id)" } + approvals.map { "a\($0.id)" })
        let stored = UserDefaults.standard.array(forKey: Self.seenKey) as? [String]
        defer { UserDefaults.standard.set(Array(ids.union(stored ?? []).suffix(500)), forKey: Self.seenKey) }
        guard let stored, notify, status == .authorized || status == .provisional else { return }
        let seen = Set(stored)
        let center = UNUserNotificationCenter.current()
        for a in approvals where !seen.contains("a\(a.id)") {
            let c = UNMutableNotificationContent()
            c.title = String(localized: "Your agent asks: \(a.title)", bundle: .l10n)
            c.body = a.details.isEmpty ? String(localized: "Approve or deny in Atteo.", bundle: .l10n) : String(a.details.prefix(180))
            c.sound = .default
            c.userInfo = a.boardId.map { ["board": $0] } ?? [:]
            c.threadIdentifier = "approvals"
            try? await center.add(UNNotificationRequest(identifier: "a\(a.id)", content: c, trigger: nil))
        }
        for i in inbox where i.readAt == nil && !seen.contains("i\(i.id)") && Self.worthIt(i.kind) {
            let c = UNMutableNotificationContent()
            let who = i.kind == "approval" ? String(localized: "Your agent", bundle: .l10n) : i.actorVia == "agent" ? String(localized: "\(i.actor)'s agent", bundle: .l10n) : i.actor
            c.title = i.boardTitle.map { String(localized: "\(who) in \($0)", bundle: .l10n, comment: "Notification title: who wrote, in which board") } ?? who
            c.body = String(i.excerpt.prefix(180))
            c.sound = .default
            c.userInfo = i.boardId.isEmpty ? [:] : ["board": i.boardId, "seq": i.seq]
            c.threadIdentifier = i.boardId
            try? await center.add(UNNotificationRequest(identifier: "i\(i.id)", content: c, trigger: nil))
        }
    }

    /// Mentions, replies, decisions and approvals: what's for you. (Friend and contact notes stay in the app.)
    private static func worthIt(_ kind: String) -> Bool { ["mention", "agent", "reply", "approval", "decision"].contains(kind) }

    /// A background wake: look, notify, and ask to be woken again.
    func backgroundCheck() async {
        schedule()
        guard Keychain.token != nil else { return }
        async let i = try? API.shared.get("/api/inbox", as: InboxResponse.self, timeout: 20)
        async let a = try? API.shared.get("/api/approvals", as: ApprovalsResponse.self, timeout: 20)
        let (ii, aa) = await (i, a)
        guard let ii, let aa else { return }
        await readStatus()
        await check(inbox: ii.items, approvals: aa.approvals, notify: true)
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
        } footer: {
            Text("A number on the app icon for what needs you, and a notification for mentions, replies and approvals while Atteo is in the background (iOS decides how often it checks).")
        }
        .listRowBackground(Theme.card)
        .task { await notifier.readStatus() }
    }
}
