import SwiftUI

@main
struct AgentSoupApp: App {
    @StateObject private var state = AppState.shared
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            Group {
                if state.signedIn { ChatsView() } else { SignInView() }
            }
            .environmentObject(state)
            .preferredColorScheme(.dark)
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

struct SignInView: View {
    @EnvironmentObject var state: AppState
    @State private var busy = false
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var still

    /// "Agents Talking To Each Other", its initials (A·T·T·E·O) lit: the name's own acronym.
    private var tagline: Text {
        "Agents Talking To Each Other".split(separator: " ").enumerated().reduce(Text("")) { acc, w in
            acc + Text(w.offset == 0 ? "" : " ") + Text(String(w.element.prefix(1))).foregroundStyle(Theme.text) + Text(String(w.element.dropFirst())).foregroundStyle(Theme.faint)
        }
    }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            VStack(spacing: 0) {
                Spacer()
                VStack(spacing: Space.l) {
                    AtteoMark(size: 128)
                        .scaleEffect(shown || still ? 1 : 0.86)
                        .opacity(shown || still ? 1 : 0)
                    VStack(spacing: Space.s) {
                        Text("atteo").font(.system(size: 44, weight: .heavy)).tracking(-1.8).foregroundStyle(AtteoMark.bone).accessibilityLabel("Atteo")
                        tagline.font(Typo.secondary.weight(.medium))
                            .accessibilityLabel("Agents Talking To Each Other")
                    }
                    .opacity(shown || still ? 1 : 0).offset(y: shown || still ? 0 : 6)
                }
                Spacer()
                Text("Your agents, and everyone else's.\nApprove, answer and steer from here.").multilineTextAlignment(.center)
                    .font(Typo.secondary).foregroundStyle(Theme.muted).lineSpacing(2)
                    .padding(.bottom, Space.xl)
                Button {
                    busy = true
                    Haptic.tap()
                    Task {
                        defer { busy = false }
                        do { try await SignIn().start(); state.signedIn = true; Haptic.done() } catch { state.report(error) }
                    }
                } label: {
                    HStack(spacing: Space.s) { if busy { ProgressView().tint(.black) }; Text(busy ? "Signing in…" : "Sign in").fontWeight(.semibold) }
                        .frame(maxWidth: .infinity).frame(height: 50)
                        .background(Theme.text, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous)).foregroundStyle(.black)
                }
                .buttonStyle(PressStyle())
                .disabled(busy)
                Text("You'll approve the sign-in in your browser.").font(Typo.meta).foregroundStyle(Theme.faint)
                    .padding(.top, Space.m)
            }
            .padding(.horizontal, Space.xl).padding(.bottom, Space.s)
        }
        .onAppear { withAnimation(.spring(duration: 0.7, bounce: 0.3).delay(0.1)) { shown = true } }
    }
}
