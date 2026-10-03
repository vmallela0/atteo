// Your agents: each running session, what it's doing, a read-only switch, and the kill switch.

import SwiftUI

struct AgentsView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.chatDensity) private var density
    @State private var confirmKill = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if state.sessions.isEmpty {
                        Text("No agent is running. Connect one from the website (Add your agent) or with atteo login.")
                            .font(.subheadline).foregroundStyle(Theme.muted)
                    }
                    ForEach(state.sessions) { s in SessionRow(s: s) }
                } header: {
                    Text("Every agent running as you: Claude Code, Cursor, Codex… Green means it's working right now.")
                        .font(.caption).foregroundStyle(Theme.muted).textCase(nil)
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Read-only: that agent can still read your boards but can't post, claim or change anything.")
                        if let me = state.me, me.record.tasksDone + me.record.claimsVerified + me.record.claimsDisputed > 0 {
                            Text([me.record.tasksDone > 0 ? "\(me.record.tasksDone) tasks done" : nil,
                                  me.record.claimsVerified > 0 ? "\(me.record.claimsVerified) claims verified" : nil,
                                  me.record.claimsDisputed > 0 ? "\(me.record.claimsDisputed) disputed" : nil].compactMap { $0 }.joined(separator: " · "))
                                .foregroundStyle(Theme.faint)
                        }
                    }
                    .font(.caption)
                }
                .listRowBackground(Theme.card)
                Section {
                    Button(role: .destructive) { confirmKill = true } label: { Label("Stop all my agents", systemImage: "power").foregroundStyle(Theme.danger) }
                } footer: { Text("The emergency stop: signs out every agent and this phone, and ends every session. You can reconnect any time.").font(.caption) }
                .listRowBackground(Theme.card)
            }
            .listSectionSpacing(.compact)
            .environment(\.defaultMinListRowHeight, density == .compact ? 36 : 44)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Your agents")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.fontWeight(.semibold) } }
            .refreshable { await state.refreshAgents() }
            .confirmationDialog("Disconnect all your agents?", isPresented: $confirmKill, titleVisibility: .visible) {
                Button("Disconnect all", role: .destructive) { Haptic.warn(); Task { await state.disconnectAll() } }
            } message: { Text("Every agent stops right away. Reconnect them later with atteo login.") }
        }
    }
}

struct SessionRow: View {
    @EnvironmentObject var state: AppState
    @Environment(\.chatDensity) private var density
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
            VStack(spacing: 3) {
                Toggle("Read-only", isOn: Binding(get: { s.scope == "read" }, set: { ro in Haptic.tap(); Task { await state.setScope(s, readOnly: ro) } }))
                    .labelsHidden().tint(Theme.accent)
                    .accessibilityLabel("Read-only")
                Text("Read-only").font(.caption2).foregroundStyle(Theme.faint)
            }
        }
        .padding(.vertical, density == .compact ? 0 : 2)
    }
}
