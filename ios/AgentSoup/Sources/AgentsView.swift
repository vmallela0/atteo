// Your agents: each running session, what it's doing, a read-only switch, and the kill switch.

import SwiftUI

struct AgentsView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var confirmKill = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if state.sessions.isEmpty {
                        Text("No agent is running. Connect one from the website (Add your agent) or with agent-soup login.")
                            .font(.subheadline).foregroundStyle(Theme.muted)
                    }
                    ForEach(state.sessions) { s in SessionRow(s: s) }
                } footer: {
                    if let me = state.me {
                        Text("Track record: \(me.record.claimsVerified) claims verified · \(me.record.tasksDone) tasks done\(me.record.claimsDisputed > 0 ? " · \(me.record.claimsDisputed) disputed" : "")")
                            .font(.caption).foregroundStyle(Theme.faint)
                    }
                }
                .listRowBackground(Theme.card)
                Section {
                    Button(role: .destructive) { confirmKill = true } label: { Label("Disconnect all agents", systemImage: "power").foregroundStyle(Theme.danger) }
                } footer: { Text("Stops every agent at once: revokes every sign-in (this phone's too) and ends every session.").font(.caption) }
                .listRowBackground(Theme.card)
            }
            .listSectionSpacing(.compact)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Your agents")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.fontWeight(.semibold) } }
            .refreshable { await state.refreshAgents() }
            .confirmationDialog("Disconnect all your agents?", isPresented: $confirmKill, titleVisibility: .visible) {
                Button("Disconnect all", role: .destructive) { Haptic.warn(); Task { await state.disconnectAll() } }
            } message: { Text("Every agent stops right away. Reconnect them later with agent-soup login.") }
        }
    }
}

struct SessionRow: View {
    @EnvironmentObject var state: AppState
    let s: AgentSession

    var body: some View {
        HStack(spacing: 12) {
            StateDot(state: s.state ?? (s.active == true ? "idle" : "gone"))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(s.name).font(Typo.rowTitle).foregroundStyle(Theme.text)
                    if let c = s.client { Text(c).font(.caption).foregroundStyle(Theme.faint) }
                }
                Text([s.status ?? stateLine(s.state, s.lastSeen), s.scope == "read" ? "read-only" : nil].compactMap { $0 }.joined(separator: " · "))
                    .font(Typo.secondary).foregroundStyle(s.state == "live" ? Theme.ok : Theme.muted).lineLimit(2)
            }
            Spacer(minLength: 8)
            Toggle("Read-only", isOn: Binding(get: { s.scope == "read" }, set: { ro in Haptic.tap(); Task { await state.setScope(s, readOnly: ro) } }))
                .labelsHidden().tint(Theme.accent)
                .accessibilityLabel("Read-only")
        }
        .padding(.vertical, 2)
    }
}
