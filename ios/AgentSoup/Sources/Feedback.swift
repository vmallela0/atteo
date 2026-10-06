import SwiftUI

/// Settings → Send feedback (vedu #4125): a few words for the Atteo team (an idea, a complaint, something you like),
/// to POST /api/feedback. Agents send theirs with the MCP `feedback` tool, so "feedback: …" to your agent works too.
struct FeedbackRow: View {
    @State private var open = false

    var body: some View {
        Section {
            Button { open = true } label: {
                Label("Send feedback", systemImage: "bubble.left")
                    .foregroundStyle(Theme.text)
            }
            .accessibilityIdentifier("settings-feedback")
            // On the row itself: a .sheet on a List Section (not a real view) never presents.
            .sheet(isPresented: $open) { FeedbackView().presentationDetents([.medium, .large]).presentationBackground(Theme.bg) }
        } footer: { Text("An idea, a complaint, something you like: it goes to the Atteo team.") }
        .listRowBackground(Theme.card)
    }
}

struct FeedbackView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var sending = false
    @State private var sent = false
    @State private var failure: String?
    @FocusState private var focused: Bool

    private var canSend: Bool { !sending && !sent && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    TextField("Your feedback", text: $text, axis: .vertical)
                        .lineLimit(4...10)
                        .focused($focused)
                        .padding(Space.m)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                        .accessibilityIdentifier("feedback-text")
                        .onChange(of: text) { _, v in if v.count > 2000 { text = String(v.prefix(2000)) } }
                    if sent {
                        Label("Sent. Thanks, the Atteo team will read it.", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(Theme.ok)
                            .accessibilityIdentifier("feedback-sent")
                    } else if let failure {
                        Label(failure, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.danger)
                            .accessibilityIdentifier("feedback-error")
                    }
                }
                .padding(Space.l)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            .navigationTitle("Send feedback")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button(sent ? "Done" : "Cancel") { dismiss() }.toolbarText() }
                ToolbarItem(placement: .confirmationAction) {
                    // Plain text in the bar's glass, like every sheet's Done (jxn #4074).
                    Button { Task { await send() } } label: { if sending { ProgressView() } else { Text("Send") } }
                        .toolbarText(primary: true)
                        .disabled(!canSend)
                        .accessibilityIdentifier("feedback-send")
                }
            }
            .onAppear { focused = true }
        }
    }

    private func send() async {
        focused = false
        sending = true
        failure = nil
        defer { sending = false }
        do {
            let body = try JSONSerialization.data(withJSONObject: ["text": text])
            let (status, data) = try await API.shared.post("/api/feedback", body: body, contentType: "application/json")
            if (200..<300).contains(status) {
                Haptics.play(.completed)
                sent = true
            } else if status == 404 || status == 501 {
                failure = String(localized: "Feedback isn't set up on this server yet.", bundle: .l10n)
            } else {
                let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
                failure = msg ?? String(localized: "Couldn't send it. Try again.", bundle: .l10n)
            }
        } catch {
            failure = error.localizedDescription
        }
    }
}
