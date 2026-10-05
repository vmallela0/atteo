// "Bring your assistant" (ios/qa/design/everyday, `firstrun`): after sign-in, when you have no assistant connected yet,
// Everyday asks which one you use. Each tile does what the web's connect page does (src/html.ts connectTiles): Grok,
// ChatGPT and Claude copy Atteo's link and open their connectors page (paste it there, sign in, Allow); Muse has no
// one-tap path, so it's a message to paste into a Muse chat, which builds a custom connector (#2050; Muse Code, the
// developer one, gets the settings.json message under it). Each opens the provider's app when it's installed, else its
// website (vedu #2298, AppOpener). Coding agents (Claude Code, Codex) get their one-line command, and
// Developer mode turns on by itself once one connects. Skippable; Settings → Your assistant opens it again.

import SwiftUI

enum AssistantProvider: String, Identifiable, CaseIterable {
    case grok, muse, chatgpt, claude, coding
    var id: String { rawValue }

    var name: String {
        switch self {
        case .grok: return "Grok"
        case .muse: return "Muse"
        case .chatgpt: return "ChatGPT"
        case .claude: return "Claude"
        case .coding: return String(localized: "A coding agent", bundle: .l10n)
        }
    }
    var account: String {
        switch self {
        case .grok: return String(localized: "Your Grok account", bundle: .l10n)
        case .muse: return String(localized: "Your Muse account", bundle: .l10n)
        case .chatgpt: return String(localized: "Your OpenAI account", bundle: .l10n)
        case .claude: return String(localized: "Your Anthropic account", bundle: .l10n)
        case .coding: return "Claude Code, Codex"
        }
    }
    var letter: String {
        switch self {
        case .grok: return "G"
        case .muse: return "M"
        case .chatgpt: return "C"
        case .claude: return "A"
        case .coding: return "</>"
        }
    }
    /// Where to paste the link (the one-tap providers): the page to open, and where it is, as the web says it.
    var page: (link: ProviderLink, where: String)? {
        switch self {
        // grok.com's universal links cover every path ("/*"), so its app opens on its connectors page.
        case .grok: return (.init(app: "https://grok.com/connectors", web: "https://grok.com/connectors"), String(localized: "Grok: New Connector → Custom", bundle: .l10n))
        // ChatGPT's app links don't reach a custom-connector page (only "#settings/Connectors?connector=<an existing
        // one's id>"), so the app opens on its settings ("/#settings" is in chatgpt.com's app links), Connectors from
        // there (vedu #4065). No app: the web's Connectors page.
        case .chatgpt: return (.init(app: "https://chatgpt.com/#settings", web: "https://chatgpt.com/#settings/Connectors"), String(localized: "ChatGPT: Connectors → Create", bundle: .l10n))
        // Claude's app opens "Add custom connector" itself (claude.ai lists that path for its app); the web page as before.
        case .claude: return (.init(app: "https://claude.ai/customize/connectors?modal=add-custom-connector", web: "https://claude.ai/settings/connectors"), String(localized: "Claude: Add custom connector", bundle: .l10n))
        default: return nil
        }
    }
    /// Its chat, to paste a message into (Muse's connect message, Invite an agent's join message); nil: no chat to open
    /// (a coding agent's terminal). Each `app` is a path the provider's apple-app-site-association gives its app.
    var chat: ProviderLink? {
        switch self {
        case .grok: return .init(app: "https://grok.com", web: "https://grok.com")
        // chatgpt.com/open-app opens the app (on the web it goes to the App Store, so the web is plain chatgpt.com).
        case .chatgpt: return .init(app: "https://chatgpt.com/open-app", web: "https://chatgpt.com")
        case .claude: return .init(app: "https://claude.ai/new", web: "https://claude.ai/new")
        // Muse (Meta's, muse.ai): /chat opens its app; the web app is muse.ai (it signs you in first).
        case .muse: return .init(app: "https://muse.ai/chat", web: "https://muse.ai")
        case .coding: return nil
        }
    }
    /// Muse can't do Atteo's sign-in, so its Connect goes through our page that mints a key (/connect/muse, vedu #2290,
    /// #2422): it opens in the browser, where the person's web session signs in, makes the key and copies one message to
    /// paste into a Muse chat. Always atteo.dev (publicBase), never the workers.dev host the app talks to.
    static var museConnectPage: URL? { API.shared.publicBase.appendingPathComponent("connect/muse") }
    static let tiles: [AssistantProvider] = [.grok, .muse, .chatgpt, .claude]
}

/// A provider page: `app` is an https universal link that opens the provider's installed app (nil: its app has none
/// for this), `web` is where to go without it. Never put our link or a message in either: those go on the clipboard.
struct ProviderLink: Equatable {
    let app: URL?
    let web: URL
    init(app: String?, web: String) {
        self.app = app.flatMap(URL.init(string:))
        self.web = URL(string: web)!
    }
}

/// Opens a provider: its app when it's installed (a universal link, opened only if an app claims it), else its website.
/// No custom URL schemes (so no LSApplicationQueriesSchemes): every provider has universal links to its app. In the
/// simulator no provider app is installed, so it's always the web.
enum AppOpener {
    /// Opens a URL; `appOnly` succeeds only when an installed app takes it. Tests pass their own.
    typealias Open = @MainActor (_ url: URL, _ appOnly: Bool, _ done: @escaping @MainActor (Bool) -> Void) -> Void
    static let system: Open = { url, appOnly, done in
        UIApplication.shared.open(url, options: appOnly ? [.universalLinksOnly: true] : [:], completionHandler: done)
    }

    @MainActor static func open(_ link: ProviderLink, with open: Open? = nil) {
        let open = open ?? system
        guard let app = link.app else { return open(link.web, false) { _ in } }
        open(app, true) { opened in if !opened { open(link.web, false) { _ in } } }
    }
}

/// A provider's tile mark: its letter (or "</>") in a small rounded square.
struct ProviderMark: View {
    let provider: AssistantProvider
    var body: some View {
        Text(provider.letter).font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.text)
            .frame(width: 40, height: 40).background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.line))
    }
}

/// Atteo's MCP address (what every assistant connects to).
var atteoMCP: String { API.shared.publicBase.appendingPathComponent("mcp").absoluteString }

struct BringAssistantView: View {
    /// This phone has been through the first run (skipped or connected).
    static let doneKey = "everyday-first-run-done"
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    let firstRun: Bool
    var finish: () -> Void = {}
    @State private var connecting: AssistantProvider?
    @State private var atteoSoon = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    AtteoMark(size: 48).padding(.top, Space.s)
                    VStack(alignment: .leading, spacing: Space.s) {
                        Text("Bring your assistant").font(Typo.ui(.largeTitle).weight(.bold)).foregroundStyle(Theme.text)
                            .accessibilityIdentifier("bring-title")
                        Text("Your assistant can talk to your family's and coworkers' assistants to get things done. It asks you before it pays, books or sends anything.")
                            .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    VStack(spacing: 0) {
                        ForEach(Array(AssistantProvider.tiles.enumerated()), id: \.element) { i, p in
                            if i > 0 { Divider().overlay(Theme.line) }
                            tile(p)
                        }
                    }
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.line))
                    HStack(spacing: Space.m) {
                        Rectangle().fill(Theme.line).frame(height: 0.5)
                        Text("or").font(Typo.secondary).foregroundStyle(Theme.faint)
                        Rectangle().fill(Theme.line).frame(height: 0.5)
                    }
                    atteoTile
                    Button { connecting = .coding } label: {
                        (Text("Use Claude Code or Codex? ").foregroundStyle(Theme.muted) + Text("Connect a coding agent").foregroundStyle(Theme.accent) + Text(" and Developer mode turns on.").foregroundStyle(Theme.muted))
                            .font(Typo.secondary).multilineTextAlignment(.center).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("connect-coding")
                    .padding(.top, Space.s)
                }
                .padding(.horizontal, Space.l).padding(.bottom, Space.xl)
            }
            .background(Theme.bg)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(firstRun ? "Skip" : "Done") { close() }
                        .toolbarText(primary: !firstRun)
                        .accessibilityIdentifier(firstRun ? "first-run-skip" : "bring-done")
                }
            }
            .sheet(item: $connecting) { p in ConnectSteps(provider: p).presentationDetents([.medium, .large]).presentationBackground(Theme.bg) }
            .alert("Atteo's assistant is coming soon", isPresented: $atteoSoon) {
                Button("OK", role: .cancel) {}
            } message: { Text("For now, connect the assistant you already use. You can switch any time in Settings.") }
        }
    }

    private func close() {
        UserDefaults.standard.set(true, forKey: Self.doneKey)
        finish()
        dismiss()
    }

    private func tile(_ p: AssistantProvider) -> some View {
        HStack(spacing: Space.m) {
            ProviderMark(provider: p)
            VStack(alignment: .leading, spacing: 2) {
                Text(p.name).font(Typo.body.weight(.semibold)).foregroundStyle(Theme.text)
                Text(p.account).font(Typo.secondary).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: Space.s)
            Button { connecting = p } label: {
                Text("Connect").font(Typo.secondary.weight(.medium)).foregroundStyle(Theme.text)
                    .padding(.horizontal, Space.m).frame(minHeight: 36)
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(Theme.line))
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressStyle())
            .accessibilityIdentifier("connect-\(p.rawValue)")
        }
        .padding(.horizontal, Space.m).padding(.vertical, Space.m)
    }

    private var atteoTile: some View {
        HStack(spacing: Space.m) {
            AtteoMark(size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text("Use Atteo's assistant").font(Typo.body.weight(.semibold)).foregroundStyle(Theme.text)
                Text("Free, ready now. Switch any time.").font(Typo.secondary).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: Space.s)
            Button { atteoSoon = true } label: {
                Text("Start").font(Typo.secondary.weight(.semibold)).foregroundStyle(Theme.onText)
                    .padding(.horizontal, Space.l).frame(minHeight: 36)
                    .background(Theme.text, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            }
            .buttonStyle(PressStyle())
            .accessibilityIdentifier("atteo-assistant")
        }
        .padding(Space.m)
        .background(Theme.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.accent.opacity(0.45)))
    }
}

/// How to connect one assistant: the one-tap ones copy the link and open their page; the rest, steps to copy.
struct ConnectSteps: View {
    let provider: AssistantProvider
    @Environment(\.dismiss) private var dismiss
    @State private var copied: String?

    /// What to paste into a Muse chat (the web's message, word for word: Muse builds a custom connector, #2050/#2055).
    private var museMessage: String {
        "Create a custom connector for this MCP server: \(atteoMCP)\nThen sign in to Atteo when it asks. It is how you work with agents owned by other people, on shared boards."
    }
    /// Developer Muse (Muse Code) instead: the server goes in its settings file.
    private var museCodeMessage: String {
        "Add an MCP server named \"atteo\" to your settings (~/.config/muse/settings.json), transport streamable_http, url \(atteoMCP), then sign in to it when it asks. It is how you work with agents owned by other people, on shared boards."
    }
    private var commands: [(label: String, text: String)] {
        [("Claude Code", "claude mcp add --transport http --scope user atteo \(atteoMCP)"),
         ("Codex", "codex mcp add atteo --url \(atteoMCP) && codex mcp login atteo")]
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    if let page = provider.page {
                        step(1, "Copy Atteo's link and open \(provider.name)")
                        // Copied first, so it's on the clipboard when the app (or the page) comes up.
                        openButton("Copy link & open \(provider.name)") { copy(atteoMCP); AppOpener.open(page.link) }
                        copyField(atteoMCP)
                        step(2, "Paste it in \(page.where)")
                        step(3, "Sign in when it asks, and choose Allow")
                        Text("Then tell \(provider.name) “list my Atteo chats”. Once it's connected, it shows up here by itself.")
                            .font(Typo.secondary).foregroundStyle(Theme.muted)
                    } else if provider == .muse, let page = AssistantProvider.museConnectPage {
                        // Our connect page: it mints a key and copies the message; the person pastes it into Muse once.
                        Text("Muse connects with a key instead of a sign-in. Make one on Atteo's page, copy the message, and paste it into a Muse chat.")
                            .font(Typo.body).foregroundStyle(Theme.text)
                        openButton("Get Muse's key") { AppOpener.open(ProviderLink(app: nil, web: page.absoluteString)) }
                        // Developer Muse sets up from its settings file instead: small, under the main way.
                        Text("Muse Code: paste this instead.").font(Typo.meta).foregroundStyle(Theme.muted).padding(.top, Space.s)
                        copyField(museCodeMessage, mono: true)
                    } else if provider == .muse, let chat = provider.chat {
                        // The message, then Muse's app (or muse.ai) to paste it into a chat (vedu #2298).
                        openButton("Copy message & open \(provider.name)") { copy(museMessage); AppOpener.open(chat) }
                        copyField(museMessage)
                        Text("Paste it into a Muse chat.").font(Typo.body).foregroundStyle(Theme.text)
                        // Developer Muse sets up from its settings file instead: small, under the main way.
                        Text("Muse Code: paste this instead.").font(Typo.meta).foregroundStyle(Theme.muted).padding(.top, Space.s)
                        copyField(museCodeMessage, mono: true)
                    } else {
                        Text("Paste one line in your terminal; it opens a browser to sign in.").font(Typo.body).foregroundStyle(Theme.text)
                        ForEach(commands, id: \.label) { c in
                            Text(c.label).font(Typo.section).foregroundStyle(Theme.muted)
                            copyField(c.text, mono: true)
                        }
                        Label("Developer mode turns on by itself once a coding agent connects. You can turn it off in Settings.", systemImage: "bolt")
                            .font(Typo.secondary).foregroundStyle(Theme.muted)
                    }
                    if let copied { Text(copied).font(Typo.meta).foregroundStyle(Theme.ok).accessibilityIdentifier("connect-copied") }
                }
                .padding(Space.l)
            }
            .background(Theme.bg)
            .navigationTitle(provider == .coding ? Text("Connect a coding agent") : Text("Connect \(provider.name)"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.toolbarText(primary: true) } }
        }
    }

    /// The sheet's main button: copies and opens the provider's app (or its page).
    private func openButton(_ title: LocalizedStringKey, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: "arrow.up.right.square")
                .font(Typo.body.weight(.semibold)).foregroundStyle(Theme.onText)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(Theme.text, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(PressStyle())
        .accessibilityIdentifier("connect-open")
    }

    private func step(_ n: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.m) {
            Text("\(n)").font(Typo.meta.weight(.bold)).foregroundStyle(Theme.text)
                .frame(width: 22, height: 22).background(Theme.card, in: Circle()).onFirstLine(6)
            Text(text).font(Typo.body).foregroundStyle(Theme.text)
        }
    }

    private func copyField(_ text: String, mono: Bool = false) -> some View {
        HStack(alignment: .top, spacing: Space.s) {
            Text(text).font(mono ? Typo.mono(.footnote) : Typo.secondary).foregroundStyle(Theme.text)
                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
            Button { copy(text) } label: { Image(systemName: "doc.on.doc").font(.system(size: 14)).foregroundStyle(Theme.muted).frame(width: 32, height: 32) }
                .accessibilityLabel("Copy")
        }
        .padding(Space.m)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func copy(_ t: String) {
        UIPasteboard.general.string = t
        Haptics.play(.copied)
        withAnimation(.smooth) { copied = String(localized: "Copied.", bundle: .l10n) }
    }
}
