// Your agents: each running session, what it says it's doing, read-only or not, and the kill switch.

import SwiftUI

struct AgentsView: View {
    @EnvironmentObject var state: AppState
    @State private var confirmKill = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let me = state.me {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 10) {
                                Avatar(name: me.owner, agent: true, size: 40)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("\(me.owner)'s agent").font(.headline).foregroundStyle(Theme.text)
                                    Text(me.online ? "online" : "offline").font(.caption).foregroundStyle(me.online ? Theme.ok : Theme.faint)
                                }
                            }
                            if let s = me.summary { Text(s).font(.subheadline).foregroundStyle(Theme.muted) }
                            HStack(spacing: 8) {
                                Pill(text: "\(me.record.claimsVerified) verified", color: Theme.ok)
                                Pill(text: "\(me.record.tasksDone) tasks done", color: Theme.accent)
                                if me.record.claimsDisputed > 0 { Pill(text: "\(me.record.claimsDisputed) disputed", color: Theme.warn) }
                            }
                        }
                        .card()
                    }
                    Text("SESSIONS").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint).padding(.top, 6)
                    if state.sessions.isEmpty {
                        Text("No agent is running. Connect one from the website or with agent-soup login.").font(.subheadline).foregroundStyle(Theme.muted).card()
                    }
                    ForEach(state.sessions) { s in SessionRow(s: s) }
                    Button(role: .destructive) { confirmKill = true } label: {
                        Label("Disconnect all agents", systemImage: "power").frame(maxWidth: .infinity).padding(.vertical, 12)
                    }
                    .buttonStyle(.bordered).tint(Theme.danger).padding(.top, 18)
                    Text("Revokes every sign-in (this phone's too) and ends every session, right away.").font(.caption).foregroundStyle(Theme.faint)
                        .frame(maxWidth: .infinity)
                }
                .padding(16)
            }
            .background(Theme.bg)
            .navigationTitle("Agents")
            .refreshable { await state.refreshAgents() }
            .confirmationDialog("Disconnect all your agents?", isPresented: $confirmKill, titleVisibility: .visible) {
                Button("Disconnect all", role: .destructive) { Haptic.warn(); Task { await state.disconnectAll() } }
            } message: { Text("Every agent stops at once. You'll sign in again here, and reconnect your agents with agent-soup login.") }
        }
    }
}

struct SessionRow: View {
    @EnvironmentObject var state: AppState
    let s: AgentSession

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Circle().fill(s.active == true ? Theme.ok : Theme.faint).frame(width: 8, height: 8)
                Text(s.name).font(.body.weight(.semibold)).foregroundStyle(Theme.text)
                if let c = s.client { Text(c).font(.caption).foregroundStyle(Theme.faint) }
                Spacer()
                Text(s.lastSeen.ago).font(.caption).foregroundStyle(Theme.faint)
            }
            if let st = s.status { Text(st).font(.subheadline).foregroundStyle(Theme.muted) }
            Toggle(isOn: Binding(get: { s.scope == "read" }, set: { ro in Haptic.tap(); Task { await state.setScope(s, readOnly: ro) } })) {
                Text("Read-only").font(.subheadline).foregroundStyle(Theme.muted)
            }
            .tint(Theme.warn)
        }
        .card()
    }
}
