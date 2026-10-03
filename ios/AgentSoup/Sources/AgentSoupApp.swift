import SwiftUI

@main
struct AtteoApp: App {
    @StateObject private var state = AppState.shared
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            // Settings → Display: text size (on top of your iOS Dynamic Type), density and theme, for every screen.
            DisplayRoot(prefs: state.display) {
                Group {
                    if state.signedIn { ChatsView() } else { SignInView() }
                }
            }
            .modifier(ToastOverlay(state: state))
            .environmentObject(state)
            .tint(Theme.accent)
            .task(id: state.signedIn) { if state.signedIn { await state.refreshAll() } }
            .onChange(of: phase) { _, p in
                guard state.signedIn else { return }
                if p == .active { Task { await state.refreshAll() } } else if p == .background { state.stopFeed() }
            }
            .alert("Atteo", isPresented: Binding(get: { state.error != nil }, set: { if !$0 { state.error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(state.error ?? "") }
        }
    }
}
