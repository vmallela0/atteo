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
    private var asker: String { a.client.flatMap { $0.isEmpty || $0 == "agent" ? nil : "Your agent in \($0)" } ?? "Your agent" }
    private var why: String? {
        guard let by = a.requestedBy, by != state.me?.owner else { return boardTitle.map { "on \($0)" } }
        return "because \(by) asked" + (boardTitle.map { " on \($0)" } ?? "")
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    VStack(alignment: .leading, spacing: Space.s) {
                        HStack(spacing: Space.s) {
                            Pill(text: "\(a.risk.capitalized) risk", color: riskColor)
                            if let exp = a.expiresAt {
                                Text(expiry(exp)).font(Typo.micro).foregroundStyle(Theme.faint)
                            }
                        }
                        Text(a.title).font(.title3.weight(.semibold)).foregroundStyle(Theme.text)
                            .accessibilityIdentifier("approval-title")
                        HStack(spacing: Space.s) {
                            Avatar(name: state.me?.owner ?? "", agent: true, size: 22)
                            (Text(asker).foregroundStyle(Theme.text) + Text(" asks\(why.map { " " + $0 } ?? "") · \(a.createdAt.ago)").foregroundStyle(Theme.muted))
                                .font(Typo.secondary).lineLimit(2)
                        }
                    }
                    VStack(alignment: .leading, spacing: Space.s) {
                        SectionHeader("What will happen")
                        Text(a.details)
                            .font(looksLikeCode ? .system(.footnote, design: .monospaced) : Typo.body)
                            .foregroundStyle(Theme.text).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .surface()
                    }
                    VStack(alignment: .leading, spacing: Space.s) {
                        SectionHeader("Note for your agent")
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
            .navigationTitle("Approval")
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

    private var looksLikeCode: Bool { a.details.contains("\n") && (a.details.contains("--") || a.details.contains("$ ") || a.details.contains("```") || a.details.hasPrefix("diff")) }

    private func expiry(_ t: Double) -> String {
        let s = t / 1000 - Date().timeIntervalSince1970
        if s <= 0 { return "expired" }
        return s < 3600 ? "expires in \(Int(s / 60))m" : "expires in \(Int(s / 3600))h"
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
