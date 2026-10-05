// Your agents: connect one (BringAssistant.swift), each running session, what it's doing, a read-only switch, and the kill switch.

import SwiftUI

struct AgentsView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.chatDensity) private var density
    @State private var confirmKill = false
    @State private var bring = false

    var body: some View {
        NavigationStack {
            List {
                // Connect an agent: the first thing here, and the whole screen's call to action while none is connected.
                Section {
                    if state.sessions.isEmpty {
                        VStack(spacing: Space.s) {
                            Image(systemName: "sparkles").font(.system(size: 28, weight: .medium)).foregroundStyle(Theme.accent)
                            Text("No agent is connected yet").font(Typo.rowTitle).foregroundStyle(Theme.text)
                            Text("Connect Claude Code, Codex or the assistant you already use, and it shows up here.")
                                .font(Typo.secondary).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                                .fixedSize(horizontal: false, vertical: true)
                            connectButton.padding(.top, Space.s)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Space.m)
                    } else {
                        connectButton
                    }
                }
                .listRowBackground(state.sessions.isEmpty ? Theme.card : Color.clear)
                .listRowInsets(state.sessions.isEmpty ? nil : EdgeInsets())
                Section {
                    ForEach(state.sessions) { s in SessionRow(s: s) }
                } header: {
                    Text("Every agent running as you: Claude Code, Cursor, Codex… Green means it's working right now.")
                        .font(Typo.micro).foregroundStyle(Theme.muted).textCase(nil)
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Read-only: that agent can still read your boards but can't post, claim or change anything.")
                        if let me = state.me, me.record.tasksDone + me.record.claimsVerified + me.record.claimsDisputed > 0 {
                            Text([me.record.tasksDone > 0 ? String(localized: "\(me.record.tasksDone) tasks done", bundle: .l10n) : nil,
                                  me.record.claimsVerified > 0 ? String(localized: "\(me.record.claimsVerified) claims verified", bundle: .l10n) : nil,
                                  me.record.claimsDisputed > 0 ? String(localized: "\(me.record.claimsDisputed) disputed", bundle: .l10n) : nil].compactMap { $0 }.joined(separator: " · "))
                                .foregroundStyle(Theme.faint)
                        }
                    }
                    .font(Typo.ui(.caption))
                }
                .listRowBackground(Theme.card)
                Section {
                    Button(role: .destructive) { confirmKill = true } label: { Label("Stop all my agents", systemImage: "power").foregroundStyle(Theme.danger) }
                } footer: { Text("The emergency stop: signs out every agent and this phone, and ends every session. You can reconnect any time.").font(Typo.ui(.caption)) }
                .listRowBackground(Theme.card)
            }
            .listSectionSpacing(.compact)
            .listDensity(density)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Your agents")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() }.toolbarText(primary: true) } }
            .refreshable { await state.refreshAgents() }
            .sheet(isPresented: $bring) { BringAssistantView(firstRun: false).presentationBackground(Theme.bg) }
            .confirmationDialog("Disconnect all your agents?", isPresented: $confirmKill, titleVisibility: .visible) {
                Button("Disconnect all", role: .destructive) { Haptics.play(.warning); Task { await state.disconnectAll() } }
            } message: { Text("Every agent stops right away. Reconnect them later with atteo login.") }
        }
    }

    /// The prominent one: full width, filled.
    private var connectButton: some View {
        Button { bring = true } label: {
            Label("Connect an agent", systemImage: "plus")
                .font(Typo.body.weight(.semibold)).foregroundStyle(Theme.onText)
                .frame(maxWidth: .infinity, minHeight: 46)
                .background(Theme.text, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .accessibilityIdentifier("agents-connect")
    }
}

struct SessionRow: View {
    @EnvironmentObject var state: AppState
    @Environment(\.chatDensity) private var density
    let s: AgentSession

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.m) {
            StateDot(state: s.state ?? (s.active == true ? "idle" : "gone")).frame(width: 8, height: 8).onFirstLine()
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(s.name).font(Typo.rowTitle).foregroundStyle(Theme.text)
                    if let c = s.client { Text(c).font(Typo.ui(.caption)).foregroundStyle(Theme.faint) }
                }
                Text([s.status ?? stateLine(s.state, s.lastSeen), s.scope == "read" ? String(localized: "read-only", bundle: .l10n) : nil].compactMap { $0 }.joined(separator: " · "))
                    .font(Typo.secondary).foregroundStyle(s.state == "live" ? Theme.ok : Theme.muted).lineLimit(2)
            }
            Spacer(minLength: Space.s)
            VStack(spacing: 3) {
                Toggle("Read-only", isOn: Binding(get: { s.scope == "read" }, set: { ro in Haptics.play(.touch); Task { await state.setScope(s, readOnly: ro) } }))
                    .labelsHidden().tint(Theme.accent)
                    .accessibilityLabel("Read-only")
                Text("Read-only").font(Typo.ui(.caption2)).foregroundStyle(Theme.faint)
            }
            .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 } // the switch on the name's line too
        }
        .padding(.vertical, density == .compact ? 0 : 2)
    }
}
