// A board's call in the app (vedu #5383): the web's call (src/callWeb.ts, /call.js) in a web view, since the audio is
// WebRTC to Cloudflare Realtime and WebKit has it built in. The page is a small shell the app writes with the server as
// its origin; its requests to the call and voice routes carry the app's token (pages never take a token, the JSON API
// does). The audio session is Talk's (AudioRoutePlan .talk), so the loudspeaker choice is the same as voice chat's.
// The Atteo gate the page uses is CallGate's rule (CallGate.swift has the app's copy, unit tested).

import AVFoundation
import SwiftUI
import WebKit

struct CallSheet: View {
    let board: Board
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            CallPage(board: board.id)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(board.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(String(localized: "Close", bundle: .l10n)) { dismiss() }.accessibilityIdentifier("call-close")
                    }
                }
        }
        .onAppear { AudioRoutePlan.plan(.talk, loudspeaker: AudioOut.shared.loudspeaker).apply() }
        .onDisappear { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }
}

struct CallPage: UIViewRepresentable {
    let board: String

    /// The page: the server's own stylesheets and call script, mounted on this board.
    static func html(board: String) -> String {
        let b = board.filter { $0.isLetter || $0.isNumber || $0 == "_" }
        return """
        <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/call.css"></head>
        <body><div id="call-root" data-board="\(b)"></div><script src="/call.js"></script></body></html>
        """
    }

    /// Adds the app's token to this page's own requests to the call and voice routes, and to nothing else.
    static func tokenScript(_ token: String) -> String {
        let tok = String(data: try! JSONSerialization.data(withJSONObject: [token], options: []), encoding: .utf8)!
        return """
        (()=>{const T=\(tok)[0],f=window.fetch.bind(window),ok=u=>/^\\/api\\/(boards\\/[^/]+\\/call(\\/|$)|app\\/voice\\/)/.test(new URL(u,location.href).pathname)&&new URL(u,location.href).origin===location.origin;
        window.fetch=(u,o)=>{o=Object.assign({},o||{});const url=typeof u==='string'?u:u.url;if(ok(url)){const h=new Headers(o.headers||{});h.set('authorization','Bearer '+T);o.headers=h}return f(u,o)}})();
        """
    }

    func makeCoordinator() -> Guard { Guard(origin: API.shared.base) }

    func makeUIView(context: Context) -> WKWebView {
        let c = WKWebViewConfiguration()
        c.websiteDataStore = .nonPersistent()
        c.allowsInlineMediaPlayback = true
        c.mediaTypesRequiringUserActionForPlayback = []
        let content = WKUserContentController()
        if let token = API.shared.token {
            content.addUserScript(WKUserScript(source: Self.tokenScript(token), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        c.userContentController = content
        let w = WKWebView(frame: .zero, configuration: c)
        w.navigationDelegate = context.coordinator
        w.uiDelegate = context.coordinator
        w.allowsLinkPreview = false
        w.isOpaque = false
        w.backgroundColor = .clear
        w.loadHTMLString(Self.html(board: board), baseURL: API.shared.base)
        return w
    }

    func updateUIView(_ w: WKWebView, context: Context) {}

    static func dismantleUIView(_ w: WKWebView, coordinator: Guard) {
        // Leaving: the page says so (pagehide); a page that can't is out after 30 s without a ping.
        w.evaluateJavaScript("dispatchEvent(new Event('pagehide'))")
        w.stopLoading()
        w.navigationDelegate = nil
        w.uiDelegate = nil
    }

    /// Only the server's own page; the microphone for it (the call), nothing for anyone else.
    final class Guard: NSObject, WKNavigationDelegate, WKUIDelegate {
        let origin: URL
        init(origin: URL) { self.origin = origin }

        private func ours(_ host: String?) -> Bool { host == origin.host }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            let first = action.navigationType == .other && action.targetFrame?.isMainFrame == true && ours(action.request.url?.host) && webView.url == nil
            decisionHandler(first || action.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
            decisionHandler(type == .microphone && origin.host == self.origin.host ? .grant : .deny)
        }
    }
}
