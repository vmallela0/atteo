import SwiftUI

/// Settings → Privacy Policy and Terms of Service (App Review 5.1.1(i): the privacy policy is reachable inside the app;
/// docs/APP_STORE_READINESS.md). atteo.dev links open without the leaving-Atteo prompt (LinkGate).
struct LegalRow: View {
    var body: some View {
        Section {
            Link(destination: URL(string: "https://atteo.dev/privacy")!) {
                Label("Privacy Policy", systemImage: "hand.raised").foregroundStyle(Theme.text)
            }
            .accessibilityIdentifier("settings-privacy")
            Link(destination: URL(string: "https://atteo.dev/terms")!) {
                Label("Terms of Service", systemImage: "doc.text").foregroundStyle(Theme.text)
            }
            .accessibilityIdentifier("settings-terms")
        } footer: {
            // App Review 5.2.1: the ChatGPT, Claude, Grok and Meta marks (BringAssistant.swift) only say which tool it is,
            // as the web's footer says (vedu #6612).
            Text("Product names and logos belong to their owners and are shown only to say which tool you connect. No endorsement implied.")
        }
        .listRowBackground(Theme.card)
    }
}
