import SwiftUI

@main
struct AgentSoupApp: App {
    @StateObject private var state = AppState.shared
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            Group {
                if state.signedIn { MainTabs() } else { SignInView() }
            }
            .environmentObject(state)
            .preferredColorScheme(.dark)
            .tint(Theme.accent)
            .task(id: state.signedIn) { if state.signedIn { await state.refreshAll() } }
            .onChange(of: phase) { _, p in
                guard state.signedIn else { return }
                if p == .active { Task { await state.refreshAll() } } else if p == .background { state.stopTape() }
            }
            .alert("Agent Soup", isPresented: Binding(get: { state.error != nil }, set: { if !$0 { state.error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(state.error ?? "") }
        }
    }
}

struct MainTabs: View {
    @EnvironmentObject var state: AppState
    @State private var tab: Int = {
        #if DEBUG
        return Int(ProcessInfo.processInfo.environment["AGENT_SOUP_TAB"] ?? "") ?? 0 // simulator screenshots
        #else
        return 0
        #endif
    }()

    var body: some View {
        TabView(selection: $tab) {
            Tab("Chats", systemImage: "bubble.left.and.bubble.right.fill", value: 0) { ChatsView() }
                .badge(state.needsYou)
            Tab("Agents", systemImage: "sparkles", value: 1) { AgentsView() }
        }
    }
}

struct SignInView: View {
    @EnvironmentObject var state: AppState
    @State private var busy = false

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            VStack(spacing: 18) {
                Spacer()
                Image(systemName: "circle.hexagongrid.fill").font(.system(size: 54, weight: .semibold)).foregroundStyle(Theme.accent)
                Text("Agent Soup").font(.system(size: 34, weight: .bold, design: .rounded)).foregroundStyle(Theme.text)
                Text("Your agents, and everyone else's.\nApprove, answer and steer from here.").multilineTextAlignment(.center)
                    .font(.callout).foregroundStyle(Theme.muted)
                Spacer()
                Button {
                    busy = true
                    Haptic.tap()
                    Task {
                        defer { busy = false }
                        do { try await SignIn().start(); state.signedIn = true; Haptic.done() } catch { state.report(error) }
                    }
                } label: {
                    HStack { if busy { ProgressView().tint(.black) }; Text(busy ? "Signing in…" : "Sign in").fontWeight(.semibold) }
                        .frame(maxWidth: .infinity).padding(.vertical, 15)
                        .background(Theme.text, in: RoundedRectangle(cornerRadius: 14, style: .continuous)).foregroundStyle(.black)
                }
                .disabled(busy)
                Text("You'll approve the sign-in in your browser.").font(.footnote).foregroundStyle(Theme.faint)
            }
            .padding(24)
        }
    }
}
