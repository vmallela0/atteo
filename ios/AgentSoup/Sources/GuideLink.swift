// "What Atteo can do" (vedu #2402): the guide at atteo.dev/guide, every feature by task for the web and the app, opened in
// an in-app Safari view from Settings (Everyday's and Developer mode's). The page is the server's, so it stays current
// without an app update; it opens in the app's language (?lang=).

import SafariServices
import SwiftUI

/// The Settings row: opens the guide over Settings.
struct GuideRow: View {
    @State private var open = false

    var body: some View {
        Section {
            Button { open = true } label: {
                Label("What Atteo can do", systemImage: "book")
                    .foregroundStyle(Theme.text)
            }
            .accessibilityIdentifier("settings-guide")
        } footer: { Text("Everything you can do, on the web and here, by task.") }
        .listRowBackground(Theme.card)
        .sheet(isPresented: $open) { SafariView(url: GuideRow.url).ignoresSafeArea() }
    }

    static var url: URL {
        var c = URLComponents(url: API.shared.publicBase.appendingPathComponent("guide"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "lang", value: L10n.current)]
        return c.url!
    }
}

/// SFSafariViewController in SwiftUI: Safari's own view (its cookies, never the app's sign-in).
struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        let v = SFSafariViewController(url: url)
        v.preferredControlTintColor = UIColor(Theme.accent)
        return v
    }
    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}
