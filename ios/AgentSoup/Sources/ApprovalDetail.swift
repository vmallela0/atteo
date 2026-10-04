// An approval, in full: exactly what your agent wants to do (the command, the diff, the steps), who's asking and why,
// how risky it says it is, and a note back. Approve or decline at the bottom, like reviewing a pull request.

import SwiftUI

struct ApprovalDetail: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    let a: Approval
    @State private var note = ""
    @State private var busy: Bool?
    @FocusState private var noting: Bool

    private var riskColor: Color { a.risk == "high" ? Theme.danger : a.risk == "medium" ? Theme.warn : Theme.ok }
    private var boardTitle: String? { a.boardId.flatMap { id in state.boards.first { $0.id == id }?.displayName(me: state.me?.owner) } }
    /// "Your agent", or "Your agent in Claude Code" when it says which tool it runs in.
    private var asker: String { Vocab.everyday ? Vocab.yourAgent : a.client.flatMap { $0.isEmpty || $0 == "agent" ? nil : String(localized: "Your agent in \($0)", bundle: .l10n) } ?? String(localized: "Your agent", bundle: .l10n) }
    /// After the asker: " asks on Checkout bug · 5m", " asks because theo asked · 5m", …
    private var asks: String {
        let ago = a.createdAt.ago
        let by = a.requestedBy.flatMap { $0 == state.me?.owner ? nil : $0 }
        switch (by, boardTitle) {
        case let (by?, board?): return String(localized: " asks because \(by) asked on \(board) · \(ago)", bundle: .l10n)
        case let (by?, nil): return String(localized: " asks because \(by) asked · \(ago)", bundle: .l10n)
        case let (nil, board?): return String(localized: " asks on \(board) · \(ago)", bundle: .l10n)
        case (nil, nil): return String(localized: " asks · \(ago)", bundle: .l10n)
        }
    }
    private var riskLabel: String {
        switch a.risk {
        case "high": return String(localized: "High risk", bundle: .l10n)
        case "medium": return String(localized: "Medium risk", bundle: .l10n)
        case "low": return String(localized: "Low risk", bundle: .l10n)
        default: return String(localized: "\(a.risk.capitalized) risk", bundle: .l10n)
        }
    }
    /// A permission hook sends the exact action separately from its explanation. Keep it verbatim: this is what the
    /// person is approving, including whitespace in a shell command or file diff.
    private var command: String? {
        guard let command = a.command, !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return command
    }
    private var tool: String? {
        guard let tool = a.tool, !tool.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return tool
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    VStack(alignment: .leading, spacing: Space.s) {
                        HStack(spacing: Space.s) {
                            // Risk and the exact command are Developer mode's (Everyday.swift): Everyday says it plainly.
                            if !Vocab.everyday { Pill(text: riskLabel, color: riskColor) }
                            if let exp = a.expiresAt {
                                Text(expiry(exp)).font(Typo.micro).foregroundStyle(Theme.faint)
                            }
                        }
                        Text(a.title).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                            .accessibilityIdentifier("approval-title")
                        HStack(spacing: Space.s) {
                            Avatar(name: state.me?.owner ?? "", agent: true, size: 22)
                            (Text(asker).foregroundStyle(Theme.text) + Text(asks).foregroundStyle(Theme.muted))
                                .font(Typo.secondary).lineLimit(2)
                        }
                    }
                    VStack(alignment: .leading, spacing: Space.s) {
                        SectionHeader("What will happen")
                        if let command, !Vocab.everyday {
                            VStack(alignment: .leading, spacing: Space.xs) {
                                if let tool { Text(tool).font(Typo.micro).foregroundStyle(Theme.faint) }
                                Text(command)
                                    .font(.system(.footnote, design: .monospaced))
                                    .foregroundStyle(Theme.text).textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .surface()
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("approval-command")
                        }
                        if !a.details.isEmpty, a.details != command {
                            Text(a.details)
                                .font(looksLikeCode(a.details) ? .system(.footnote, design: .monospaced) : Typo.body)
                                .foregroundStyle(Theme.text).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .surface()
                                .accessibilityIdentifier("approval-details")
                        }
                    }
                    VStack(alignment: .leading, spacing: Space.s) {
                        SectionHeader(Vocab.pick(String(localized: "Note for your agent", bundle: .l10n), String(localized: "Note for your assistant", bundle: .l10n)))
                        TextField("Optional: conditions, or why not", text: $note, axis: .vertical)
                            .lineLimit(1...5).font(Typo.body).focused($noting)
                            .accessibilityIdentifier("approval-note")
                            .surface()
                    }
                }
                .padding(.horizontal, Space.l).padding(.top, Space.s).padding(.bottom, Space.l)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            .safeAreaInset(edge: .bottom) { buttons }
            .navigationTitle(Vocab.pick(String(localized: "Approval", bundle: .l10n), String(localized: "Needs your OK", bundle: .l10n)))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Close") { dismiss() }.toolbarText(primary: true) } }
        }
    }

    private var buttons: some View {
        HStack(spacing: Space.s) {
            Button { decide(false) } label: {
                HStack(spacing: Space.s) { if busy == false { ProgressView().tint(Theme.text) }; Text("Decline") }
                    .font(Typo.body.weight(.semibold)).frame(maxWidth: .infinity).frame(height: 50)
                    .background(Theme.raised, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous)).foregroundStyle(Theme.text)
            }
            .accessibilityIdentifier("approval-decline")
            Button { decide(true) } label: {
                HStack(spacing: Space.s) { if busy == true { ProgressView().tint(Theme.onText) }; Text("Approve") }
                    .font(Typo.body.weight(.semibold)).frame(maxWidth: .infinity).frame(height: 50)
                    .background(Theme.text, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous)).foregroundStyle(Theme.onText)
            }
            .accessibilityIdentifier("approval-approve")
        }
        .buttonStyle(PressStyle())
        .disabled(busy != nil)
        .padding(.horizontal, Space.l).padding(.top, Space.s).padding(.bottom, Space.s)
        .background(Theme.bg)
    }

    private func looksLikeCode(_ text: String) -> Bool {
        text.contains("\n") && (text.contains("--") || text.contains("$ ") || text.contains("```") || text.hasPrefix("diff"))
    }

    private func expiry(_ t: Double) -> String {
        let s = t / 1000 - Date().timeIntervalSince1970
        if s <= 0 { return String(localized: "expired", bundle: .l10n) }
        return s < 3600 ? String(localized: "expires in \(Int(s / 60))m", bundle: .l10n) : String(localized: "expires in \(Int(s / 3600))h", bundle: .l10n)
    }

    private func decide(_ approve: Bool) {
        noting = false
        busy = approve
        Task {
            if await state.decide(a, approve: approve, note: note.trimmingCharacters(in: .whitespacesAndNewlines)) { dismiss() }
            busy = nil
        }
    }
}
