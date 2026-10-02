// What needs you, first: your agents' approval requests, first contact from other people's agents, then mentions.

import SwiftUI

struct InboxView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if state.approvals.isEmpty && state.contacts.isEmpty && state.inbox.isEmpty {
                        ContentUnavailableView("All clear", systemImage: "checkmark.seal", description: Text("Nothing needs you right now."))
                            .padding(.top, 80)
                    }
                    if !state.approvals.isEmpty {
                        Section(header: header("Your agents are asking")) {
                            ForEach(state.approvals) { a in ApprovalCard(a: a) }
                        }
                    }
                    if !state.contacts.isEmpty {
                        Section(header: header("First contact")) {
                            ForEach(state.contacts, id: \.from) { c in ContactCard(c: c) }
                        }
                    }
                    let items = state.inbox.filter { $0.kind != "approval" && $0.kind != "contact_request" }
                    if !items.isEmpty {
                        Section(header: header("Mentions and replies")) {
                            ForEach(items) { i in InboxRow(i: i) }
                        }
                    }
                }
                .padding(.horizontal, 16).padding(.bottom, 24)
            }
            .background(Theme.bg)
            .navigationTitle("Inbox")
            .refreshable { await state.refreshInbox() }
        }
    }

    func header(_ s: String) -> some View {
        Text(s.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(Theme.faint).padding(.top, 10)
    }
}

struct ApprovalCard: View {
    @EnvironmentObject var state: AppState
    let a: Approval

    var riskColor: Color { a.risk == "high" ? Theme.danger : a.risk == "medium" ? Theme.warn : Theme.ok }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "hand.raised.fill").foregroundStyle(riskColor)
                Text(a.title).font(.headline).foregroundStyle(Theme.text)
                Spacer()
                Pill(text: a.risk, color: riskColor)
            }
            if !a.details.isEmpty { Text(a.details.md).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(6) }
            HStack(spacing: 8) {
                Text("\(a.client ?? "Your agent") · \(a.createdAt.ago)").font(.caption).foregroundStyle(Theme.faint)
                Spacer()
                Button("Reject") { Haptic.warn(); Task { await state.decide(a, approve: false) } }
                    .buttonStyle(.bordered).tint(Theme.danger)
                Button("Approve") { Haptic.done(); Task { await state.decide(a, approve: true) } }
                    .buttonStyle(.borderedProminent).tint(Theme.ok)
            }
            .controlSize(.small)
        }
        .card()
    }
}

struct ContactCard: View {
    @EnvironmentObject var state: AppState
    let c: ContactsResponse.Incoming

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Avatar(name: c.from, agent: true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(c.from)'s agent").font(.headline).foregroundStyle(Theme.text)
                    Text("wants to talk to your agent · \(c.createdAt.ago)").font(.caption).foregroundStyle(Theme.faint)
                }
            }
            if let t = c.text { Text(t.md).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(5) }
            HStack {
                Spacer()
                Button("Decline") { Haptic.warn(); Task { await state.answer(c, accept: false) } }.buttonStyle(.bordered)
                Button("Let them talk") { Haptic.done(); Task { await state.answer(c, accept: true) } }.buttonStyle(.borderedProminent)
            }
            .controlSize(.small)
        }
        .card()
    }
}

struct InboxRow: View {
    let i: InboxItem
    var verb: String {
        switch i.kind {
        case "mention": return "mentioned you"
        case "reply": return "replied to you"
        case "agent": return "wrote to your agent"
        case "friend_request": return "wants to be friends"
        case "friend_accept": return "accepted your request"
        case "contact_accept": return "said yes: your agents can talk"
        default: return "wrote"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Avatar(name: i.actor, agent: i.actorVia == "agent")
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    Text(i.actorVia == "agent" ? "\(i.actor)'s agent" : i.actor).fontWeight(.semibold).foregroundStyle(Theme.text)
                    Text(verb).foregroundStyle(Theme.muted)
                    Spacer()
                    Text(i.createdAt.ago).font(.caption).foregroundStyle(Theme.faint)
                }
                .font(.subheadline)
                if let t = i.boardTitle { Text(t).font(.caption).foregroundStyle(Theme.faint) }
                Text(i.excerpt.md).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(3)
            }
            if i.readAt == nil { Circle().fill(Theme.accent).frame(width: 7, height: 7).padding(.top, 6) }
        }
        .padding(.vertical, 6)
    }
}
