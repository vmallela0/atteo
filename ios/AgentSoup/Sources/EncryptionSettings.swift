// Settings → Encryption (E2E 1c): the same as `atteo keys` and the web's encryption bar. This phone's fingerprint; your
// devices, with Approve after you compare a new one's fingerprint; devices to check on your boards, trusted only when
// you type the fingerprint their owner reads you; and the device that approved this phone, until you say it matches.

import SwiftUI

/// The row in Settings that opens it.
struct EncryptionRow: View {
    @ObservedObject private var trust = TrustCenter.shared
    var body: some View {
        Section {
            NavigationLink { EncryptionSettings() } label: {
                HStack {
                    Text("Encryption")
                    Spacer()
                    if trust.approvedBy != nil || trust.signMismatch || !trust.checks.isEmpty { Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.warn) }
                }
            }
            .accessibilityIdentifier("settings-encryption")
        } footer: { Text("This phone's fingerprint, your devices, and who it hands the keys of encrypted boards to.") }
        .listRowBackground(Theme.card)
    }
}

struct EncryptionSettings: View {
    @ObservedObject private var trust = TrustCenter.shared
    @State private var asking: TrustCenter.Mine?
    @State private var typed: [String: String] = [:]
    @State private var note: String?
    @State private var busy = false

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text("This iPhone's fingerprint").font(Typo.meta).foregroundStyle(Theme.muted)
                    Text(verbatim: BoardCrypto.shared.fingerprint).font(Typo.mono(.body)).foregroundStyle(Theme.text).textSelection(.enabled)
                        .accessibilityIdentifier("encryption-fingerprint")
                    if let kid = trust.kid { Text(verbatim: String(localized: "Key \(kid)", bundle: .l10n)).font(Typo.mono(.footnote)).foregroundStyle(Theme.faint) }
                }
            } footer: { Text("Read it to someone checking it's you, or compare it with what your other device shows when it approves this one.") }
            .listRowBackground(Theme.card)

            if let a = trust.approvedBy {
                Section {
                    Text(verbatim: String(localized: "🔑 Approved by \(a.label) (key \(a.kid)), fingerprint \(a.fingerprint): does it match what that device shows? This phone took its pins. If it doesn't match, that wasn't your device: tell your boards' members.", bundle: .l10n))
                        .font(Typo.meta).foregroundStyle(Theme.text).accessibilityIdentifier("encryption-approved-by")
                    Button("It matches") { trust.itMatches() }.accessibilityIdentifier("encryption-approved-ok")
                }
                .listRowBackground(Theme.card)
            }

            if trust.signMismatch {
                Section {
                    Text("⚠ The server shows this phone with a signing key that isn't this phone's. Devices \"signed\" with it aren't from you: don't trust them, and tell your boards' members.")
                        .font(Typo.meta).foregroundStyle(Theme.danger)
                }
                .listRowBackground(Theme.card)
            }

            Section {
                ForEach(trust.devices) { d in
                    HStack(alignment: .top, spacing: Space.m) {
                        VStack(alignment: .leading, spacing: Space.xxs) {
                            Text(verbatim: d.label ?? String(localized: "Unnamed", bundle: .l10n)).font(Typo.rowTitleRead).foregroundStyle(Theme.text)
                            Text(verbatim: d.fingerprint).font(Typo.mono(.footnote)).foregroundStyle(Theme.muted)
                            Text(verbatim: d.id).font(Typo.micro).foregroundStyle(Theme.faint)
                        }
                        Spacer()
                        if d.id == trust.kid {
                            Text("This iPhone").font(Typo.micro).foregroundStyle(Theme.faint)
                        } else if trust.isApprovedHere(d) {
                            Text("Approved here").font(Typo.micro).foregroundStyle(Theme.ok)
                        } else {
                            Button("Approve") { asking = d }.buttonStyle(.borderless).disabled(busy)
                                .accessibilityIdentifier("encryption-approve-\(d.id)")
                        }
                    }
                }
            } header: { SectionHeader("Your devices") } footer: {
                Text("Approve a new device of yours only if it shows the same fingerprint. It's signed into your device list and gets the keys of your encrypted boards.")
            }
            .listRowBackground(Theme.card)

            let checks = trust.checks.values.flatMap { $0 }
            if !checks.isEmpty {
                Section {
                    ForEach(checks) { c in check(c) }
                } header: { SectionHeader("Devices to check") }
                .listRowBackground(Theme.card)
            }
            if !trust.waiting.isEmpty {
                Section {
                    Text("This phone doesn't hold the key of \(trust.waiting.count) of your encrypted boards yet, so it trusts no one there yet (members show as unverified). It trusts them once it has the key, or takes your other device's trust when you approve this phone there.")
                        .font(Typo.meta).foregroundStyle(Theme.muted)
                }
                .listRowBackground(Theme.card)
            }
            if let note { Section { Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.muted) }.listRowBackground(Theme.card) }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .navigationTitle("Encryption")
        .task { await trust.refresh() }
        .refreshable { await BoardCrypto.shared.syncAll(); await trust.refresh() }
        .alert(item: $asking) { d in
            Alert(title: Text("Approve \(d.label ?? String(localized: "this device", bundle: .l10n))?"),
                  message: Text(verbatim: String(localized: "Only if that device shows this fingerprint:\n\(d.fingerprint)\nIt gets the keys of your encrypted boards.", bundle: .l10n)),
                  primaryButton: .default(Text("Approve")) { approve(d) }, secondaryButton: .cancel())
        }
    }

    private func check(_ c: TrustCenter.Check) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text(verbatim: String(localized: "⚠ None of \(c.device.user)'s devices this phone trusted is listed any more, and the server shows a new one (\(c.device.label ?? "unnamed"), key \(c.device.kid), fingerprint \(c.fingerprint)) that none of them signed. It could be the server's own, so it gets no key from here. Trust it only if \(c.device.user) reads you the same fingerprint from their device (not on the board).", bundle: .l10n))
                .font(Typo.meta).foregroundStyle(Theme.text)
            HStack {
                TextField("Their fingerprint", text: Binding(get: { typed[c.id] ?? "" }, set: { typed[c.id] = $0 }))
                    .font(Typo.mono(.footnote)).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("encryption-fp-\(c.device.kid)")
                Button("Trust") {
                    let t = typed[c.id] ?? ""
                    busy = true
                    Task {
                        let ok = (try? await trust.trust(c, typed: t)) ?? false
                        note = ok ? String(localized: "Trusted: that device can read the board now.", bundle: .l10n) : String(localized: "That fingerprint isn't the one this device shows: don't trust it.", bundle: .l10n)
                        if ok { Haptics.play(.completed) } else { Haptics.play(.warning) }
                        busy = false
                    }
                }
                .buttonStyle(.borderless)
                .disabled(busy || !DeviceTrust.sameFingerprint(typed[c.id] ?? "", c.fingerprint))
                .accessibilityIdentifier("encryption-trust-\(c.device.kid)")
            }
        }
    }

    private func approve(_ d: TrustCenter.Mine) {
        busy = true
        Task {
            do {
                try await trust.approve(d)
                note = String(localized: "Approved: that device gets the keys of your encrypted boards.", bundle: .l10n)
                Haptics.play(.completed)
            } catch { note = error.localizedDescription }
            busy = false
        }
    }
}
