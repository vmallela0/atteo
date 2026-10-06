import SwiftUI

@main
struct AtteoApp: App {
    @StateObject private var state = AppState.shared
    @Environment(\.scenePhase) private var phase

    init() {
        TalkCallButton.plugIn() // voice chat on Everyday's Ask screen (TalkCallButton.swift)
        Typo.applyUIKitAppearance() // the design language's fonts in UIKit's bars (Theme.swift)
        UITestSpeed.apply() // UI tests only (debug builds): animations off (UITestSpeed.swift)
        #if DEBUG
        // The share extension (ShareExtension/) can't see this run's ATTEO_SERVER: it reads the server from here instead.
        Keychain.setData(Data(API.shared.base.absoluteString.utf8), for: "share-server")
        #endif
    }

    var body: some Scene {
        WindowGroup {
            // Settings → Display: text size (on top of your iOS Dynamic Type), density and theme, for every screen.
            DisplayRoot(prefs: state.display) {
                Group {
                    if state.signedIn { ModeRoot() } else { SignInView() } // Everyday or Developer mode (Everyday.swift)
                }
                .id(state.display.lang) // a new language: every screen is built again in its words (Language.swift)
            }
            .modifier(ToastOverlay(state: state))
            .modifier(ShakeToReport(enabled: state.signedIn)) // shake anywhere to report a bug (ReportBug.swift)
            .environmentObject(state)
            .environment(\.openURL, LinkGate.action) // any link that leaves Atteo asks first (jxn #4173, LinkGate.swift)
            .tint(Theme.accent)
            .task(id: state.signedIn) { if state.signedIn { await state.refreshAll() } }
            .task { Notifier.shared.setUp(); Analytics.track("app_open") }
            .onChange(of: phase) { old, p in
                if p == .active, old == .background { Analytics.track("app_open") }
                guard state.signedIn else { return }
                if p == .active { Task { await state.refreshAll() } } else if p == .background { state.stopFeed(); Notifier.shared.schedule() }
            }
            .alert("Atteo", isPresented: Binding(get: { state.error != nil }, set: { if !$0 { state.error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(state.error ?? "") }
        }
        // While Atteo is in the background, iOS wakes it now and then to look for what's new for you (Notifications.swift).
        .backgroundTask(.appRefresh(Notifier.refreshTask)) { await Notifier.shared.backgroundCheck() }
    }
}
