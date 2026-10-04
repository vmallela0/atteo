// "Bring your assistant" (ios/qa/design/everyday, `firstrun`): after sign-in, when you have no assistant connected yet,
// Everyday asks which one you use. Each tile does what the web's connect page does (src/html.ts connectTiles): Grok,
// ChatGPT and Claude copy Atteo's link and open their connectors page (paste it there, sign in, Allow); Muse has no
// one-tap path, so it's a message to paste into a Muse chat, which builds a custom connector (#2050; Muse Code, the
// developer one, gets the settings.json message under it). Coding agents (Claude Code, Codex) get their one-line command, and
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
    /// Where to paste the link (the one-tap providers), as the web says it.
    var page: (url: String, where: String)? {
        switch self {
        case .grok: return ("https://grok.com/connectors", String(localized: "Grok: New Connector → Custom", bundle: .l10n))
        case .chatgpt: return ("https://chatgpt.com/#settings/Connectors", String(localized: "ChatGPT: Connectors → Create", bundle: .l10n))
        case .claude: return ("https://claude.ai/settings/connectors", String(localized: "Claude: Add custom connector", bundle: .l10n))
        default: return nil
        }
    }
    /// Its chat, to paste a message into (Invite an agent's join message); nil: no web chat to open (Muse, a coding
    /// agent's terminal).
    var chat: URL? {
        switch self {
        case .grok: return URL(string: "https://grok.com")
        case .chatgpt: return URL(string: "https://chatgpt.com")
        case .claude: return URL(string: "https://claude.ai/new")
        default: return nil
        }
    }
    static let tiles: [AssistantProvider] = [.grok, .muse, .chatgpt, .claude]
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
var atteoMCP: String { API.shared.base.appendingPathComponent("mcp").absoluteString }

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
                        Text("Bring your assistant").font(.largeTitle.weight(.bold)).foregroundStyle(Theme.text)
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
    @Environment(\.openURL) private var openURL
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
                        Button {
                            copy(atteoMCP)
                            if let u = URL(string: page.url) { openURL(u) }
                        } label: {
                            Label("Copy link & open \(provider.name)", systemImage: "arrow.up.right.square")
                                .font(Typo.body.weight(.semibold)).foregroundStyle(Theme.onText)
                                .frame(maxWidth: .infinity, minHeight: 48)
                                .background(Theme.text, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .buttonStyle(PressStyle())
                        .accessibilityIdentifier("connect-open")
                        copyField(atteoMCP)
                        step(2, "Paste it in \(page.where)")
                        step(3, "Sign in when it asks, and choose Allow")
                        Text("Then tell \(provider.name) “list my Atteo chats”. Once it's connected, it shows up here by itself.")
                            .font(Typo.secondary).foregroundStyle(Theme.muted)
                    } else if provider == .muse {
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

    private func step(_ n: Int, _ text: LocalizedStringKey) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.m) {
            Text("\(n)").font(Typo.meta.weight(.bold)).foregroundStyle(Theme.text)
                .frame(width: 22, height: 22).background(Theme.card, in: Circle()).onFirstLine(6)
            Text(text).font(Typo.body).foregroundStyle(Theme.text)
        }
    }

    private func copyField(_ text: String, mono: Bool = false) -> some View {
        HStack(alignment: .top, spacing: Space.s) {
            Text(text).font(mono ? .system(.footnote, design: .monospaced) : Typo.secondary).foregroundStyle(Theme.text)
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
