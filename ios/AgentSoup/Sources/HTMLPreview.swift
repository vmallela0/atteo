// HTML preview (jxn #2008), the app's side of the web's (src/html.ts, "HTML preview (jxn #1309)"): an .html file on a
// board gets Preview next to Open, in a message and in Files. It opens a sheet with the page running, a Full / Phone
// width toggle, and a note that it runs in a sandbox.
//
// Board files are written by other people, so the page is locked down:
// - its own WKWebView with a non-persistent data store (no cookies, storage or credentials of yours), loaded from the
//   text with no base URL (about:blank), no message handlers, no file access;
// - every network load blocked by a content rule list (everything except about:, data: and blob:), and a CSP at the very
//   top of the page (as the web's withCsp: no connections, no forms, no base; inline script and style, data: images and
//   fonts);
// - no navigation after the first load (links, location changes, form posts and window.open are cancelled; in-page
//   #anchors still scroll), no camera, microphone or motion, no link previews, and WebRTC removed before the page runs.
// Encrypted boards: the app can't decrypt files yet (it opens them as stored), so Preview isn't offered there.

import SwiftUI
import WebKit

enum HTMLPreview {
    static func isHTML(_ name: String?) -> Bool {
        guard let n = name?.lowercased() else { return false }
        return n.hasSuffix(".html") || n.hasSuffix(".htm")
    }

    /// Preview is offered for an .html text file (not stored bytes) on a board that isn't end-to-end encrypted.
    @MainActor
    static func available(board: String, name: String?, stored: Bool) -> Bool {
        isHTML(name) && !stored && AppState.shared.boards.first(where: { $0.id == board })?.encrypted != true
    }

    /// The web's CSP (src/html.ts PREVIEW_JS), plus no DNS prefetching.
    static let csp = #"<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'"><meta http-equiv="x-dns-prefetch-control" content="off">"#

    /// The page with the CSP as its first element: right after a leading <!doctype …> (so the page keeps standards mode),
    /// else at the very top. Never after <head> as the web does: content before <head> would push it into the body,
    /// where a CSP meta is ignored.
    static func withCsp(_ html: String) -> String {
        // Only ASCII whitespace may come before the doctype: \s would also match a no-break space, and the parser
        // then treats the doctype as text and moves the CSP meta into <body>, where it's ignored (opus-d #2044).
        if let r = html.range(of: #"^[ \t\n\f\r]*<!doctype[^>]*>"#, options: [.regularExpression, .caseInsensitive]) {
            return String(html[..<r.upperBound]) + csp + String(html[r.upperBound...])
        }
        return csp + html
    }

    /// Block every load but about:, data: and blob: (the page itself and what it makes in memory).
    static let rules = #"""
    [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^about:"},"action":{"type":"ignore-previous-rules"}},
     {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},
     {"trigger":{"url-filter":"^blob:"},"action":{"type":"ignore-previous-rules"}}]
    """#

    /// Run before the page in every frame: no WebRTC (STUN would reach the network past the CSP and the rule list).
    static let noRTC = "(()=>{for(const k of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCSessionDescription','RTCIceCandidate']){try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false})}catch(e){}}})();"

    @MainActor private static var compiled: WKContentRuleList?

    /// The compiled rule list (compiled once). Nil if WebKit refuses it: then the page isn't shown at all.
    @MainActor
    static func ruleList() async -> WKContentRuleList? {
        if let compiled { return compiled }
        let list = try? await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "atteo-preview-offline", encodedContentRuleList: rules)
        compiled = list
        return list
    }
}

/// Which file to preview.
struct HTMLPreviewTarget: Identifiable, Hashable {
    let board: String
    let name: String
    let version: Int?
    var id: String { "\(board)/\(name)/\(version ?? 0)" }
}

/// "Preview", beside a file's Open.
struct PreviewButton: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Label("Preview", systemImage: "eye")
                .labelStyle(.titleAndIcon)
                .font(Typo.micro.weight(.semibold)).foregroundStyle(Theme.text)
                .padding(.horizontal, 10).frame(height: 28)
                .background(Theme.raised, in: Rectangle())
                .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
        .accessibilityIdentifier("file-preview")
    }
}

extension View {
    /// Shows the preview sheet while `target` is set.
    func htmlPreview(_ target: Binding<HTMLPreviewTarget?>) -> some View {
        sheet(item: target) { t in HTMLPreviewSheet(target: t) }
    }
}

/// The page, running: its name, Full / Phone, close; the page; the sandbox note.
struct HTMLPreviewSheet: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    let target: HTMLPreviewTarget
    @State private var html: String?
    @State private var rules: WKContentRuleList?
    @State private var failed = false
    @State private var phone = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(Theme.line).frame(height: 0.5)
            GeometryReader { g in
                ZStack {
                    Theme.raised
                    if let html, let rules {
                        SandboxedPage(html: html, rules: rules)
                            .frame(width: phone ? min(390, g.size.width) : g.size.width)
                            .accessibilityIdentifier("preview-page")
                    } else if failed {
                        EmptyNote(icon: "doc", title: "Couldn't open this file", line: "Close this and try again.")
                    } else {
                        ProgressView()
                    }
                }
                .frame(width: g.size.width, height: g.size.height)
            }
            Rectangle().fill(Theme.line).frame(height: 0.5)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "lock.shield").accessibilityHidden(true)
                Text("Runs in a sandbox: it can't see your account or reach the network.")
            }
                .font(Typo.micro).foregroundStyle(Theme.faint)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
                .padding(.horizontal, Space.l).padding(.vertical, Space.s)
                .accessibilityIdentifier("preview-note")
        }
        .background(Theme.bg)
        .presentationDragIndicator(.visible)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("preview-sheet")
        .task { await load() }
    }

    private var header: some View {
        HStack(spacing: Space.s) {
            Text(verbatim: target.name).font(Typo.meta.weight(.semibold).monospaced()).foregroundStyle(Theme.text)
                .lineLimit(1).truncationMode(.middle)
            Spacer(minLength: Space.s)
            HStack(spacing: 2) {
                width(String(localized: "Full", bundle: .l10n), on: !phone, id: "preview-width-full") { phone = false }
                width(String(localized: "preview.width.phone", defaultValue: "Phone", bundle: .l10n), on: phone, id: "preview-width-phone") { phone = true }
            }
            .padding(2)
            .background(Theme.raised, in: Rectangle())
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text("Width"))
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.muted)
                    .frame(width: 30, height: 30).background(Theme.raised, in: Circle())
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Close preview"))
            .accessibilityIdentifier("preview-close")
        }
        .padding(.leading, Space.l).padding(.trailing, Space.xs).padding(.top, Space.s)
    }

    private func width(_ title: String, on: Bool, id: String, _ pick: @escaping () -> Void) -> some View {
        Button(action: pick) {
            Text(verbatim: title).font(Typo.micro.weight(.semibold)).foregroundStyle(on ? Theme.text : Theme.muted)
                .padding(.horizontal, 12).frame(height: 26)
                .background(on ? Theme.card : .clear, in: Rectangle())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier(id)
    }

    private func load() async {
        async let list = HTMLPreview.ruleList()
        async let doc = state.doc(target.board, target.name, version: target.version)
        let (r, d) = await (list, doc)
        // No rule list, no page: it would otherwise run with only the CSP between it and the network.
        guard let r, let d else { failed = true; return }
        rules = r
        html = HTMLPreview.withCsp(d.content)
    }
}

/// The page in a locked-down web view (see the top of this file). Loaded once; its width is the frame's.
struct SandboxedPage: UIViewRepresentable {
    let html: String
    let rules: WKContentRuleList

    func makeCoordinator() -> Guard { Guard() }

    func makeUIView(context: Context) -> WKWebView {
        let c = WKWebViewConfiguration()
        c.websiteDataStore = .nonPersistent()
        let content = WKUserContentController() // no script message handlers: nothing on the page can call the app
        content.add(rules)
        content.addUserScript(WKUserScript(source: HTMLPreview.noRTC, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        c.userContentController = content
        c.defaultWebpagePreferences.allowsContentJavaScript = true
        c.preferences.javaScriptCanOpenWindowsAutomatically = false
        c.preferences.isFraudulentWebsiteWarningEnabled = false // it would ask Safe Browsing about URLs
        c.dataDetectorTypes = []
        c.allowsAirPlayForMediaPlayback = false
        c.allowsPictureInPictureMediaPlayback = false
        c.mediaTypesRequiringUserActionForPlayback = .all
        c.upgradeKnownHostsToHTTPS = false
        let w = WKWebView(frame: .zero, configuration: c)
        w.navigationDelegate = context.coordinator
        w.uiDelegate = context.coordinator
        w.allowsLinkPreview = false
        w.allowsBackForwardNavigationGestures = false
        w.isInspectable = false
        w.backgroundColor = .white
        w.loadHTMLString(html, baseURL: nil)
        return w
    }

    func updateUIView(_ w: WKWebView, context: Context) {}

    static func dismantleUIView(_ w: WKWebView, coordinator: Guard) {
        w.stopLoading()
        w.navigationDelegate = nil
        w.uiDelegate = nil
    }

    /// Lets the first load through and nothing after it; no new windows, no camera, microphone or motion.
    final class Guard: NSObject, WKNavigationDelegate, WKUIDelegate {
        private var started = false

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            let main = action.targetFrame?.isMainFrame == true
            let url = action.request.url?.absoluteString ?? ""
            if !started, main, url == "about:blank" {
                started = true
                decisionHandler(.allow)
            } else if started, main, url.hasPrefix("about:blank#") {
                decisionHandler(.allow) // an in-page #anchor: the same document, nothing loads
            } else {
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
            decisionHandler(.deny)
        }

        func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
            decisionHandler(.deny)
        }
    }
}
