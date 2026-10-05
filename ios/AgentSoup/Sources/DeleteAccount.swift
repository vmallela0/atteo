import SwiftUI

/// Settings → Delete account (App Review 5.1.1(v): an account made in the app can be deleted in the app; jxn #4329).
/// The handle is typed back, then DELETE /api/me: messages on shared boards stay as "Deleted user", everything else
/// of the person's goes, and this phone signs out.
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

struct DeleteAccountView: View {
    @EnvironmentObject private var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var typed = ""
    @State private var deleting = false
    @State private var failure: String?

    private var handle: String { state.me?.owner ?? "" }
    private var canDelete: Bool { !deleting && deleteConfirmMatches(typed, handle: handle) }

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
                        .accessibilityLabel("Type your handle to confirm")
                        .accessibilityIdentifier("delete-confirm")
                } header: { SectionHeader("Type your handle to confirm") } footer: {
                    if let failure { Text(failure).foregroundStyle(Theme.danger) }
                }
                .listRowBackground(Theme.card)
                Section {
                    Button(role: .destructive) { Task { await delete() } } label: {
                        if deleting { ProgressView() } else { Text("Delete my account").foregroundStyle(canDelete ? Theme.danger : Theme.muted) }
                    }
                    .disabled(!canDelete)
                    .accessibilityIdentifier("delete-go")
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

    private func delete() async {
        deleting = true
        failure = nil
        do {
            try await API.shared.send("/api/me", method: "DELETE", body: ["confirm": typed], retries: false)
            dismiss()
            state.signOut()
        } catch {
            failure = String(localized: "Could not delete your account", bundle: .l10n)
            deleting = false
        }
    }
}
