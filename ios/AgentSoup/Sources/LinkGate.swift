import SwiftUI

/// Links in messages that leave Atteo ask first (jxn #4173): "Open this link?" with the whole address, so a
/// "github.com" that's really somewhere else is plain before you go. Atteo's own links open as before.
enum LinkGate {
    /// Hosts that are Atteo itself: atteo.dev (and its subdomains) and the server the app talks to.
    static func isAtteo(_ url: URL, serverHost: String? = API.shared.base.host) -> Bool {
        guard let host = url.host?.lowercased(), let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "https", host == "atteo.dev" || host.hasSuffix(".atteo.dev") || host == "agent-board.vedu-mallela.workers.dev" { return true }
        // The server this build talks to (a local one in debug runs), over the scheme it uses.
        if let s = serverHost?.lowercased(), host == s, scheme == API.shared.base.scheme?.lowercased() { return true }
        return false
    }

    /// Ask before opening: anything that leaves the app (web, mail, phone, other apps' schemes), but never
    /// the app's own links ("atteo-entry://", "atteo-person://", …, handled before this) or Atteo's site.
    static func needsConfirm(_ url: URL, serverHost: String? = API.shared.base.host) -> Bool {
        if url.scheme?.lowercased().hasPrefix("atteo-") == true { return false }
        return !isAtteo(url, serverHost: serverHost)
    }

    /// The address as shown: everything before the host (scheme, any "user@"), the host, and the rest, so the host
    /// the link really goes to stands apart (a "https://atteo.dev@evil.com" shows evil.com as the host).
    static func parts(_ url: URL) -> (lead: String, host: String, rest: String) {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false), let s = c.string, let r = c.rangeOfHost, !s[r].isEmpty else {
            return ("", "", url.absoluteString)
        }
        return (String(s[..<r.lowerBound]), String(s[r]), String(s[r.upperBound...]))
    }
}

/// The "Open this link?" sheet: the full address in monospace with its host in bold, Cancel / Open.
struct LeavingSheet: View {
    let url: URL
    let close: () -> Void
    let open: () -> Void

    var body: some View {
        let p = LinkGate.parts(url)
        VStack(alignment: .leading, spacing: Space.m) {
            Text("Open this link?").font(Typo.headline(20))
            // The mono face has no bold, so the host stands apart by ink against the faint scheme and path.
            (Text(p.lead).foregroundStyle(Theme.faint) + Text(p.host).foregroundStyle(Theme.text).underline() + Text(p.rest).foregroundStyle(Theme.faint))
                .font(Typo.mono(.subheadline))
                .textSelection(.enabled)
                .lineLimit(4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .surface()
                .accessibilityIdentifier("leaving-address")
            Text("It opens outside Atteo.").font(Typo.meta).foregroundStyle(Theme.muted)
            HStack(spacing: Space.s) {
                Button { close() } label: {
                    Text("Cancel").frame(maxWidth: .infinity).frame(height: 48)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                        .foregroundStyle(Theme.text)
                }
                .buttonStyle(PressStyle())
                .accessibilityIdentifier("leaving-cancel")
                Button { close(); open() } label: {
                    Text("Open").fontWeight(.semibold).frame(maxWidth: .infinity).frame(height: 48)
                        .background(Theme.primary, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                        .foregroundStyle(Theme.onPrimary)
                }
                .buttonStyle(PressStyle())
                .accessibilityIdentifier("leaving-open")
            }
        }
        .padding(Space.l)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.bg)
    }
}

extension LinkGate {
    /// Asks "Open this link?" over whatever is on screen (a chat, a sheet, a doc), and opens `url` with the system
    /// only if you say Open. Presented from the top view controller so it works under sheets too.
    @MainActor static func ask(_ url: URL) {
        guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first?.rootViewController else { return }
        var top = root
        while let p = top.presentedViewController { top = p }
        weak var host: UIViewController?
        let sheet = LeavingSheet(url: url, close: { host?.dismiss(animated: true) }, open: { UIApplication.shared.open(url) })
        let h = UIHostingController(rootView: sheet)
        host = h
        if let s = h.sheetPresentationController {
            s.detents = [.custom(identifier: .init("leaving")) { _ in 300 }]
            s.prefersGrabberVisible = true
        }
        top.present(h, animated: true)
    }

    /// The app-wide link handler: Atteo's own links and system settings open as before; anything leaving the app asks.
    static let action = OpenURLAction { url in
        if url.scheme == "app-settings" { return .systemAction } // the app's own "Open Settings" buttons
        guard needsConfirm(url) else { return .systemAction }
        Task { @MainActor in ask(url) }
        return .handled
    }
}
