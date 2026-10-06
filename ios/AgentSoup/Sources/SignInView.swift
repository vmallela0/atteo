// The sign-in screen, all in the app: your email → the 6-digit code we email you (iOS offers it from Mail above the
// keyboard) → for new people, a name. Below that, Continue with Apple (WorkOS AppleOAuth, App Review 4.8) and
// "Continue with Google, GitHub or SSO", both the browser sheet (SignIn in Auth.swift).

import SwiftUI

struct SignInView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.accessibilityReduceMotion) private var still

    enum Step: Int { case email, code, name }
    enum Field: Hashable { case email, code, name }

    @State private var step: Step = .email
    @State private var forward = true // which way the steps slide
    @State private var email = UserDefaults.standard.string(forKey: SignInView.lastEmailKey) ?? ""
    @State private var code = ""
    @State private var name = ""
    @State private var ticket = ""
    @State private var busy = false
    @State private var appleBusy = false
    @State private var webBusy = false
    @State private var error: String?
    @State private var shakes = 0
    @State private var sentAt = Date.distantPast
    @State private var now = Date()
    @State private var shown = false
    @FocusState private var focus: Field?

    static let lastEmailKey = "atteo_signin_email"
    private static let resendAfter: TimeInterval = 30
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var typing: Bool { focus != nil }
    private var terms: AttributedString {
        let base = API.shared.base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return (try? AttributedString(markdown: String(localized: "By continuing you agree to Atteo's [Terms](\(base)/terms) and [Privacy Policy](\(base)/privacy).", bundle: .l10n)))
            ?? AttributedString(String(localized: "By continuing you agree to Atteo's Terms and Privacy Policy.", bundle: .l10n))
    }
    private var emailLooksRight: Bool {
        let e = email.trimmingCharacters(in: .whitespaces)
        guard let at = e.firstIndex(of: "@") else { return false }
        return at > e.startIndex && e[e.index(after: at)...].contains(".") && !e.contains(" ")
    }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea().onTapGesture { focus = nil }
            VStack(spacing: 0) {
                Spacer(minLength: Space.l)
                hero
                Spacer(minLength: typing ? Space.l : Space.xl)
                ZStack(alignment: .top) {
                    switch step {
                    case .email: emailStep.transition(slide)
                    case .code: codeStep.transition(slide)
                    case .name: nameStep.transition(slide)
                    }
                }
                .frame(maxWidth: 420)
                if step == .email && !typing {
                    others.transition(.opacity)
                }
                Spacer(minLength: Space.m)
                if !typing {
                    Text(terms).tint(Theme.muted)
                        .font(Typo.micro).foregroundStyle(Theme.faint).multilineTextAlignment(.center)
                        .padding(.bottom, Space.s)
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, Space.xl)
        }
        .animation(still ? nil : .spring(duration: 0.45, bounce: 0.12), value: step)
        .animation(still ? nil : .spring(duration: 0.35, bounce: 0.1), value: typing)
        .animation(.easeOut(duration: 0.2), value: error)
        .onReceive(tick) { now = $0 }
        .onAppear { withAnimation(.spring(duration: 0.7, bounce: 0.3).delay(0.1)) { shown = true } }
    }

    // MARK: - Hero

    /// What atteo is, plainly, like Slack says it; "agents talking to each other" is said once, on the landing page (vedu #2853).
    private var tagline: Text {
        Text("A shared chat for you, your people and your agents.").foregroundStyle(Theme.faint)
    }

    private var hero: some View {
        let small = typing || step != .email
        return VStack(spacing: small ? Space.s : Space.l) {
            AtteoMark(size: small ? 56 : 112)
                .scaleEffect(shown || still ? 1 : 0.86)
                .opacity(shown || still ? 1 : 0)
            VStack(spacing: Space.s) {
                AtteoWordmark(height: small ? 36 : 54).accessibilityAddTraits(.isHeader)
                if !small {
                    tagline.font(Typo.secondary.weight(.medium)).multilineTextAlignment(.center)
                        .transition(.opacity)
                }
            }
            .opacity(shown || still ? 1 : 0).offset(y: shown || still ? 0 : 6)
        }
    }

    private var slide: AnyTransition {
        if still { return .opacity }
        return .asymmetric(insertion: .move(edge: forward ? .trailing : .leading).combined(with: .opacity),
                           removal: .move(edge: forward ? .leading : .trailing).combined(with: .opacity))
    }

    // MARK: - Step 1: email

    private var emailStep: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            heading("Sign in or create an account", "We'll email you a 6-digit code. No password.")
            InputBox(focused: focus == .email, failed: error != nil) {
                TextField("", text: $email, prompt: Text(verbatim: "you@example.com").foregroundStyle(Theme.faint))
                    .keyboardType(.emailAddress)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.continue)
                    .focused($focus, equals: .email)
                    .onSubmit { sendCode() }
                    .onChange(of: email) { _, _ in error = nil }
                    .accessibilityLabel("Email")
                    .accessibilityIdentifier("signin.email")
            }
            .modifier(Shake(shakes: shakes))
            errorLine
            PrimaryButton(title: "Continue", busyTitle: "Sending code…", busy: busy, enabled: emailLooksRight) { sendCode() }
                .accessibilityIdentifier("signin.continue")
        }
    }

    // MARK: - Step 2: the code

    private var codeStep: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            heading("Check your email", nil)
            VStack(alignment: .leading, spacing: 2) {
                Text("Enter the 6-digit code we sent to").foregroundStyle(Theme.muted)
                Text(verbatim: email).foregroundStyle(Theme.text).fontWeight(.semibold).lineLimit(1).truncationMode(.middle)
            }
            .font(Typo.secondary)
            .padding(.top, -Space.s)
            CodeBoxes(code: $code, focused: focus == .code, failed: error != nil, busy: busy)
                .focused($focus, equals: .code)
                .modifier(Shake(shakes: shakes))
                .onChange(of: code) { old, new in
                    let digits = String(new.filter(\.isNumber).prefix(6))
                    if digits != new { code = digits; return }
                    if digits.count > old.count { UISelectionFeedbackGenerator().selectionChanged() }
                    if !digits.isEmpty { error = nil }
                    if digits.count == 6 && !busy { verify() }
                }
            errorLine
            HStack {
                let wait = max(0, Int(ceil(Self.resendAfter - now.timeIntervalSince(sentAt))))
                if wait > 0 {
                    Text("Resend code in 0:\(String(format: "%02d", wait))")
                        .font(Typo.meta).foregroundStyle(Theme.faint).monospacedDigit()
                        .accessibilityIdentifier("signin.resendTimer")
                } else {
                    Button("Resend code") { sendCode(again: true) }
                        .font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.text)
                        .disabled(busy)
                        .accessibilityIdentifier("signin.resend")
                }
                Spacer()
                Button("Use a different email") { back(to: .email) }
                    .font(Typo.meta.weight(.medium)).foregroundStyle(Theme.muted)
                    .accessibilityIdentifier("signin.differentEmail")
            }
            .padding(.top, Space.xs)
        }
        .onAppear { focus = .code }
    }

    // MARK: - Step 3: a name (new people)

    private var nameStep: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            heading("Pick your name", "It's how people and agents @mention you on every board.")
            InputBox(focused: focus == .name, failed: error != nil) {
                HStack(spacing: 2) {
                    Text("@").foregroundStyle(Theme.faint)
                    TextField("", text: $name, prompt: Text(verbatim: "yourname").foregroundStyle(Theme.faint))
                        .textContentType(.nickname)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .focused($focus, equals: .name)
                        .onSubmit { pickName() }
                        .onChange(of: name) { _, new in
                            let n = new.lowercased()
                            if n != new { name = n }
                            error = nil
                        }
                        .accessibilityLabel("Name")
                        .accessibilityIdentifier("signin.name")
                }
            }
            .modifier(Shake(shakes: shakes))
            if let error { errorText(error) } else {
                Text("Lowercase letters, numbers, dot, dash or underscore.").font(Typo.micro).foregroundStyle(Theme.faint)
            }
            PrimaryButton(title: "Create account", busyTitle: "Creating…", busy: busy, enabled: !name.trimmingCharacters(in: .whitespaces).isEmpty) { pickName() }
                .accessibilityIdentifier("signin.createAccount")
            Button("Use a different email") { back(to: .email) }
                .font(Typo.meta.weight(.medium)).foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity)
                .padding(.top, Space.xs)
        }
        .onAppear { focus = .name }
    }

    // MARK: - Other ways in

    private var browserBusy: Bool { appleBusy || webBusy }

    private var others: some View {
        VStack(spacing: Space.m) {
            HStack(spacing: Space.m) {
                Rectangle().fill(Theme.line).frame(height: 1)
                Text("or").font(Typo.meta).foregroundStyle(Theme.faint)
                Rectangle().fill(Theme.line).frame(height: 1)
            }
            // Apple sits above the other third-party button (App Review 4.8). Same sheet as Google/GitHub; the server
            // adds WorkOS provider=AppleOAuth. Until WORKOS_APPLE_OAUTH=1 that page says it isn't set up (503).
            outlineSignIn("Continue with Apple", symbol: "apple.logo", busy: appleBusy, id: "signin.apple") { browserSignIn(apple: true) }
            outlineSignIn("Continue with Google, GitHub or SSO", symbol: "globe", busy: webBusy, id: "signin.web") { browserSignIn(apple: false) }
        }
        .frame(maxWidth: 420)
        .padding(.top, Space.xl)
    }

    private func outlineSignIn(_ title: LocalizedStringKey, symbol: String, busy: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Space.s) {
                if busy { ProgressView().controlSize(.small).tint(Theme.text) } else { Image(systemName: symbol).font(Typo.ui(.subheadline).weight(.medium)) }
                Text(title).fontWeight(.semibold)
            }
            .font(Typo.ui(.callout))
            .frame(maxWidth: .infinity).frame(height: 50)
            .foregroundStyle(Theme.text)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.line))
        }
        .buttonStyle(PressStyle())
        .disabled(browserBusy || self.busy)
        .accessibilityIdentifier(id)
    }

    // MARK: - Pieces

    private func heading(_ title: LocalizedStringKey, _ sub: LocalizedStringKey?) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(title).font(Typo.ui(.title3).weight(.bold)).foregroundStyle(Theme.text).accessibilityAddTraits(.isHeader)
            if let sub { Text(sub).font(Typo.secondary).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var errorLine: some View {
        if let error { errorText(error) }
    }

    private func errorText(_ e: String) -> some View {
        Label { Text(e) } icon: { Image(systemName: "exclamationmark.circle.fill") }
            .font(Typo.meta).foregroundStyle(Theme.danger)
            .fixedSize(horizontal: false, vertical: true)
            .transition(.opacity.combined(with: .move(edge: .top)))
            .accessibilityIdentifier("signin.error")
    }

    // MARK: - Actions

    private func fail(_ e: Error) {
        error = (e as? LocalizedError)?.errorDescription ?? e.localizedDescription
        shakes += 1
        Haptics.play(.failed)
    }

    private func go(to s: Step) {
        forward = s.rawValue > step.rawValue
        error = nil
        step = s
    }

    private func back(to s: Step) {
        code = ""
        ticket = ""
        email = "" // a different one
        go(to: s)
        focus = .email
    }

    private func sendCode(again: Bool = false) {
        guard emailLooksRight, !busy else { if !emailLooksRight && !email.isEmpty { fail(APIError.server(String(localized: "Enter a valid email address.", bundle: .l10n))) }; return }
        let address = email.trimmingCharacters(in: .whitespaces).lowercased()
        email = address
        busy = true
        Task {
            defer { busy = false }
            do {
                try await EmailSignIn.start(email: address)
                UserDefaults.standard.set(address, forKey: Self.lastEmailKey)
                sentAt = Date(); now = sentAt
                code = ""
                if again { error = nil; Haptics.play(.completed) } else { go(to: .code) }
                focus = .code
            } catch { fail(error) }
        }
    }

    private func verify() {
        busy = true
        Task {
            defer { busy = false }
            do {
                switch try await EmailSignIn.verify(email: email, code: code) {
                case .signedIn:
                    finish()
                case .needsName(let t, let suggestion):
                    ticket = t
                    name = suggestion
                    go(to: .name)
                }
            } catch {
                code = ""
                fail(error)
                focus = .code
            }
        }
    }

    private func pickName() {
        guard !busy, !name.isEmpty else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await EmailSignIn.pickName(ticket: ticket, name: name)
                finish(new: true)
            } catch { fail(error) }
        }
    }

    private func browserSignIn(apple: Bool) {
        if apple { appleBusy = true } else { webBusy = true }
        Task {
            defer { appleBusy = false; webBusy = false }
            do { try await SignIn().start(provider: apple ? "AppleOAuth" : nil); finish() } catch { state.report(error) }
        }
    }

    private func finish(new: Bool = false) {
        Analytics.capture(new ? "sign_up" : "sign_in")
        focus = nil
        Haptics.play(.completed)
        state.signedIn = true
    }
}

// MARK: - Controls

/// A text field in the app's style: a quiet card, a hairline that turns ink when focused (danger on an error).
private struct InputBox<Content: View>: View {
    let focused: Bool
    let failed: Bool
    @ViewBuilder let content: Content

    var body: some View {
        content
            .font(Typo.ui(.body))
            .foregroundStyle(Theme.text)
            .padding(.horizontal, Space.l)
            .frame(height: 52)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .strokeBorder(failed ? Theme.danger : focused ? Theme.text.opacity(0.7) : Theme.line, lineWidth: focused || failed ? 1.5 : 1)
            )
            .animation(.easeOut(duration: 0.15), value: focused)
    }
}

/// The ink button with a spinner while it works.
private struct PrimaryButton: View {
    let title: LocalizedStringKey
    let busyTitle: LocalizedStringKey
    let busy: Bool
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Space.s) {
                if busy { ProgressView().tint(Theme.onText) }
                Text(busy ? busyTitle : title).fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity).frame(height: 50)
            .background(enabled ? Theme.text : Theme.raised, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .foregroundStyle(enabled ? Theme.onText : Theme.faint)
        }
        .buttonStyle(PressStyle())
        .disabled(busy || !enabled)
        .padding(.top, Space.xs)
    }
}

/// Six boxes over one real text field (one-time code content, so iOS offers the code from Mail above the keyboard,
/// and pasting the whole code works). Tapping anywhere on the boxes focuses it.
private struct CodeBoxes: View {
    @Binding var code: String
    let focused: Bool
    let failed: Bool
    let busy: Bool
    @State private var blink = false

    var body: some View {
        ZStack {
            HStack(spacing: Space.s) {
                ForEach(0..<6, id: \.self) { i in box(i) }
            }
            .accessibilityHidden(true)
            TextField("", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .foregroundStyle(.clear)
                .tint(.clear)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
                .accessibilityLabel("Code")
                .accessibilityValue(code.isEmpty ? "empty" : code)
                .accessibilityIdentifier("signin.code")
        }
        .frame(height: 58)
        .opacity(busy ? 0.55 : 1)
        .overlay { if busy { ProgressView().tint(Theme.text) } }
        .onAppear { withAnimation(.easeInOut(duration: 0.55).repeatForever()) { blink = true } }
    }

    private func box(_ i: Int) -> some View {
        let chars = Array(code)
        let filled = i < chars.count
        let current = focused && i == min(chars.count, 5) && chars.count < 6
        return ZStack {
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous).fill(Theme.card)
            RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                .strokeBorder(failed ? Theme.danger : current ? Theme.text.opacity(0.7) : Theme.line, lineWidth: current || failed ? 1.5 : 1)
            if filled {
                Text(String(chars[i])).font(Typo.onest(26, .semibold, .title2)).foregroundStyle(Theme.text)
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
            } else if current {
                RoundedRectangle(cornerRadius: 1).fill(Theme.text).frame(width: 2, height: 24).opacity(blink ? 1 : 0.1)
            }
        }
        .frame(maxWidth: .infinity)
        .animation(.spring(duration: 0.25, bounce: 0.3), value: code)
    }
}

/// A short side-to-side shake (a wrong code, a taken name): bump `shakes` to play it.
private struct Shake: ViewModifier {
    var shakes: Int

    func body(content: Content) -> some View {
        content.modifier(ShakeEffect(value: CGFloat(shakes)))
            .animation(.linear(duration: 0.4), value: shakes)
    }
}

private struct ShakeEffect: GeometryEffect {
    var value: CGFloat
    var animatableData: CGFloat {
        get { value }
        set { value = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: 7 * sin(value * .pi * 4), y: 0))
    }
}
