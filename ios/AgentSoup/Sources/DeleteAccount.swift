import SwiftUI

/// Settings → Delete account (App Review 5.1.1(v): an account made in the app can be deleted in the app; jxn #4329).
/// The handle is typed back, then a code emailed to them confirms it's really them now (the server wants a sign-in
/// from the last few minutes, jxn's agent #4389: verifying the code makes a fresh app token). Then DELETE /api/me:
/// messages on shared boards stay as "Deleted user", everything else of the person's goes, and this phone signs out.
struct DeleteAccountRow: View {
    @State private var open = false

    var body: some View {
        Section {
            Button(role: .destructive) { open = true } label: {
                Label("Delete account", systemImage: "person.crop.circle.badge.xmark")
                    .foregroundStyle(Theme.danger)
            }
            .accessibilityIdentifier("settings-delete-account")
            // On the row itself: a .sheet on a List Section (not a real view) never presents.
            .sheet(isPresented: $open) { DeleteAccountView().presentationDetents([.medium, .large]).presentationBackground(Theme.bg) }
        }
        .listRowBackground(Theme.card)
    }
}

/// A deleted account's messages carry a tombstone author, "deleted-" plus 10 hex (src/accountDelete.ts): shown as
/// "Deleted user".
func isDeletedAuthor(_ author: String) -> Bool {
    author.hasPrefix("deleted-") && author.count == 18 && author.dropFirst(8).allSatisfy(\.isHexDigit)
}

/// Whether what was typed confirms `handle` (case-insensitive, an "@" in front allowed).
func deleteConfirmMatches(_ typed: String, handle: String) -> Bool {
    var t = typed.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.hasPrefix("@") { t.removeFirst() }
    return !handle.isEmpty && t.lowercased() == handle.lowercased()
}

private struct MeEmail: Decodable { let email: String? }

struct DeleteAccountView: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var typed = ""
    @State private var email: String?
    @State private var code = ""
    @State private var working = false
    @State private var failure: String?

    private var handle: String { state.me?.owner ?? "" }
    private var handleOK: Bool { deleteConfirmMatches(typed, handle: handle) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Your profile, agents, sign-ins and private boards are deleted for good. What you wrote on boards you share stays there, shown as “Deleted user”. Your handle can't be used again.")
                        .font(Typo.body).foregroundStyle(Theme.text)
                }
                .listRowBackground(Theme.card)
                Section {
                    TextField(handle, text: $typed)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(email != nil)
                        .accessibilityLabel("Type your handle to confirm")
                        .accessibilityIdentifier("delete-confirm")
                } header: { SectionHeader("Type your handle to confirm") }
                .listRowBackground(Theme.card)
                if let email {
                    Section {
                        TextField("123456", text: $code)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .accessibilityLabel("Code from your email")
                            .accessibilityIdentifier("delete-code")
                    } header: { SectionHeader("Code from your email") } footer: {
                        Text("We sent a code to \(email) to make sure it's you.")
                    }
                    .listRowBackground(Theme.card)
                }
                Section {
                    Button(role: .destructive) { Task { await next() } } label: {
                        if working { ProgressView() } else {
                            Text(email == nil ? "Email me a code" : "Delete my account")
                                .foregroundStyle(canGo ? Theme.danger : Theme.muted)
                        }
                    }
                    .disabled(!canGo)
                    .accessibilityIdentifier("delete-go")
                } footer: {
                    if let failure { Text(failure).foregroundStyle(Theme.danger) }
                }
                .listRowBackground(Theme.card)
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Delete account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() }.toolbarText() } }
        }
    }

    private var canGo: Bool { !working && handleOK && (email == nil || code.filter(\.isNumber).count == 6) }

    private func next() async {
        working = true
        failure = nil
        defer { working = false }
        do {
            if email == nil {
                // Step 1: a code to the account's email.
                guard let e = try await API.shared.get("/api/me", as: MeEmail.self).email, !e.isEmpty else {
                    failure = String(localized: "Could not delete your account", bundle: .l10n)
                    return
                }
                try await EmailSignIn.start(email: e)
                email = e
                return
            }
            // Step 2: the code makes a fresh sign-in, then the account goes.
            guard case .signedIn = try await EmailSignIn.verify(email: email!, code: code.filter(\.isNumber)) else {
                failure = String(localized: "Could not delete your account", bundle: .l10n)
                return
            }
            try await API.shared.send("/api/me", method: "DELETE", body: ["confirm": typed], retries: false)
            dismiss()
            state.signOut()
        } catch {
            failure = (error as? LocalizedError)?.errorDescription ?? String(localized: "Could not delete your account", bundle: .l10n)
        }
    }
}
