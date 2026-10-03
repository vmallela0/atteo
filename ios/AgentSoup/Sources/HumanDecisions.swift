// Human decisions (#627). A decision a person posts is for the people on the board to make (src/decisions.ts): every
// person but its author agrees or objects (one changeable vote each, an objection with an optional note); it's decided
// once they all agree, or when its author closes it (Decided or Dropped, with an optional note). Agents only give
// input. Under the decision: a pill with where it stands ("Human decision · waiting on jxn", "Decided", "Dropped"), the
// voters' pictures with ✓ / ✕, Agree / Object for voters and Close for its author. It follows the board's socket
// ({type:"decision", seq, human_decision}) live.

import SwiftUI

/// A human decision's state, as the server keeps it.
struct HumanDecision: Codable, Hashable {
    struct Vote: Codable, Hashable { let user: String; let vote: String; var note: String? = nil; var ts: Double? = nil } // agree | object
    let state: String // open | decided | dropped
    var author: String? = nil
    var votes: [Vote] = []
    var voters: [String] = []
    var waitingOn: [String] = []
    var closedBy: String? = nil
    var note: String? = nil
    var line: Int? = nil

    var open: Bool { state == "open" }
    func vote(of user: String?) -> Vote? { votes.first { $0.user == user } }

    /// "Human decision · waiting on jxn, you", "… waiting on you to close it", "Decided by you", "Dropped".
    func pill(me: String?) -> String {
        let name = { (u: String) in u == me ? "you" : u }
        switch state {
        case "open":
            if !waitingOn.isEmpty { return "Human decision · waiting on " + waitingOn.map(name).joined(separator: ", ") }
            return "Human decision · waiting on \(author.map(name) ?? "its author") to close it"
        case "decided": return "Decided " + (closedBy.map { "by \(name($0))" } ?? "by the people")
        default: return "Dropped"
        }
    }
}

struct DecisionResponse: Decodable { let humanDecision: HumanDecision }

extension AppState {
    /// The decisions in a page of entries (each entry's own, and the board's map), kept per board.
    func adoptDecisions(_ board: String, entries: [Entry], map: [String: HumanDecision]?) {
        var next = decisions[board] ?? [:]
        for e in entries { if let hd = e.humanDecision { next[e.seq] = hd } }
        for (k, v) in map ?? [:] { if let n = Int(k) { next[n] = v } }
        if next != decisions[board] { withAnimation(.smooth) { decisions[board] = next } }
    }

    /// Agree or object (with an optional note why). Shows at once; the server's answer settles it.
    func vote(_ seq: Int, in b: Board, agree: Bool, note: String? = nil) async {
        guard let me = me?.owner, let old = decisions[b.id]?[seq] else { return }
        var mine = old
        mine.votes = old.votes.filter { $0.user != me } + [HumanDecision.Vote(user: me, vote: agree ? "agree" : "object", note: agree ? nil : note)]
        if agree { mine.waitingOn.removeAll { $0 == me } } else if old.open, !mine.waitingOn.contains(me) { mine.waitingOn.append(me) }
        Haptic.tap()
        withAnimation(.smooth) { decisions[b.id, default: [:]][seq] = mine }
        var body: [String: Any] = ["vote": agree ? "agree" : "object"]
        if let note, !note.isEmpty { body["note"] = note }
        do {
            let d = try await API.shared.send("/api/boards/\(b.id)/entries/\(seq)/vote", body: body, retries: false)
            let hd = try JSONDecoder.soup.decode(DecisionResponse.self, from: d).humanDecision
            withAnimation(.smooth) { decisions[b.id, default: [:]][seq] = hd }
            if agree { Haptic.done() }
        } catch {
            withAnimation(.smooth) { decisions[b.id, default: [:]][seq] = old }
            Haptic.warn()
            report(error)
        }
    }

    /// Its author closes it: decided or dropped, with an optional note for everyone.
    func closeDecision(_ seq: Int, in b: Board, decided: Bool, note: String?) async {
        var body: [String: Any] = ["outcome": decided ? "decided" : "dropped"]
        if let note, !note.isEmpty { body["note"] = note }
        do {
            let d = try await API.shared.send("/api/boards/\(b.id)/entries/\(seq)/close", body: body, retries: false)
            let hd = try JSONDecoder.soup.decode(DecisionResponse.self, from: d).humanDecision
            withAnimation(.smooth) { decisions[b.id, default: [:]][seq] = hd }
            if decided { Haptic.done() } else { Haptic.warn() }
        } catch { Haptic.warn(); report(error) }
    }
}

/// What you can do on a human decision here (nil: not you, or not now).
struct DecisionActions {
    var agree: (() -> Void)? = nil
    var object: (() -> Void)? = nil // asks why (optional), then objects
    var close: (() -> Void)? = nil // its author: Decided or Dropped

    /// The web's rules: a voter agrees while it's open and objects until its author closes it (an objection reopens
    /// one everyone had agreed to); its author closes it once. Nothing on an archived board.
    @MainActor static func make(_ hd: HumanDecision?, seq: Int, board: Board, state: AppState, ask: @escaping (DecisionPrompt) -> Void) -> DecisionActions {
        guard let hd, board.archived != true, let me = state.me?.owner else { return DecisionActions() }
        var a = DecisionActions()
        if hd.voters.contains(me) && hd.closedBy == nil {
            if hd.open { a.agree = { Task { await state.vote(seq, in: board, agree: true) } } }
            a.object = { ask(DecisionPrompt(seq: seq, kind: .object)) }
        }
        if hd.author == me && hd.closedBy == nil { a.close = { ask(DecisionPrompt(seq: seq, kind: .close)) } }
        return a
    }
}

/// Under a person's decision: where it stands, who's agreed (✓) or objected (✕), and your buttons.
struct HumanDecisionCard: View {
    let hd: HumanDecision
    let me: String?
    var trailing = false
    var actions = DecisionActions()

    private var tint: Color { hd.state == "decided" ? Theme.ok : hd.state == "dropped" ? Theme.faint : Theme.warn }

    var body: some View {
        let mine = hd.vote(of: me)
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(spacing: Space.s) {
                HStack(spacing: 6) {
                    Circle().fill(tint).frame(width: 6, height: 6)
                    Text(hd.pill(me: me)).font(Typo.micro.weight(.semibold)).foregroundStyle(hd.state == "dropped" ? Theme.muted : tint).lineLimit(2)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("decision-pill")
                Spacer(minLength: 0)
            }
            if !hd.voters.isEmpty {
                HStack(spacing: Space.xs) {
                    ForEach(hd.voters, id: \.self) { u in voter(u) }
                }
            }
            ForEach(hd.votes.filter { $0.vote == "object" && !($0.note ?? "").isEmpty }, id: \.user) { v in
                (Text(v.user == me ? "You" : v.user).fontWeight(.semibold) + Text(" object: " + (v.note ?? "")))
                    .font(Typo.micro).foregroundStyle(Theme.muted).lineLimit(3)
            }
            if let n = hd.note, !n.isEmpty {
                (Text((hd.closedBy ?? hd.author ?? "") == me ? "You" : (hd.closedBy ?? hd.author ?? "")).fontWeight(.semibold) + Text(": " + n))
                    .font(Typo.micro).foregroundStyle(Theme.muted).lineLimit(3)
            }
            if actions.agree != nil || actions.object != nil || actions.close != nil {
                HStack(spacing: Space.s) {
                    if let agree = actions.agree {
                        DecisionButton(title: "Agree", icon: "checkmark", on: mine?.vote == "agree", color: Theme.ok, action: agree)
                            .accessibilityIdentifier("decision-agree")
                    }
                    if let object = actions.object {
                        DecisionButton(title: "Object", icon: "xmark", on: mine?.vote == "object", color: Theme.danger, action: object)
                            .accessibilityIdentifier("decision-object")
                    }
                    if let close = actions.close {
                        DecisionButton(title: "Close", icon: "flag.checkered", on: false, color: Theme.text, action: close)
                            .accessibilityIdentifier("decision-close")
                    }
                }
            }
        }
        .padding(.horizontal, Space.m).padding(.vertical, 10)
        .frame(maxWidth: 300, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
        .animation(.smooth, value: hd)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("human-decision")
    }

    /// A voter's picture with ✓ (agreed) or ✕ (objected); faded while they haven't voted.
    private func voter(_ u: String) -> some View {
        let v = hd.vote(of: u)
        return Avatar(name: u, size: 22)
            .opacity(v == nil ? 0.45 : 1)
            .overlay(alignment: .bottomTrailing) {
                if let v {
                    Image(systemName: v.vote == "agree" ? "checkmark" : "xmark").font(.system(size: 7, weight: .heavy)).foregroundStyle(.white)
                        .frame(width: 12, height: 12).background(v.vote == "agree" ? Theme.ok : Theme.danger, in: Circle())
                        .background(Circle().stroke(Theme.card, lineWidth: 3))
                        .offset(x: 3, y: 3)
                }
            }
            .accessibilityElement()
            .accessibilityLabel(u == me ? "You" : u)
            .accessibilityValue(v.map { $0.vote == "agree" ? "agreed" : "objected" } ?? "hasn't voted")
            .accessibilityIdentifier("voter-\(u)")
    }
}

/// A small capsule button on a decision; filled when it's your vote.
private struct DecisionButton: View {
    let title: String
    let icon: String
    let on: Bool
    let color: Color
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Label(title, systemImage: icon).font(Typo.micro.weight(.semibold))
                .foregroundStyle(on ? Theme.onText : color)
                .padding(.horizontal, 10).frame(minHeight: 28)
                .background(on ? color : color.opacity(0.12), in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// Asking for a decision's note: why you object, or the author's closing words. Hosts the alerts on a chat or thread.
struct DecisionPrompt: Identifiable, Equatable {
    enum Kind { case object, close }
    let seq: Int
    let kind: Kind
    var id: String { "\(seq)-\(kind)" }
}

extension View {
    /// "Object" (why? optional) and "Close" (Decided / Dropped, a note optional) for the decision `prompt` names.
    func decisionPrompts(_ prompt: Binding<DecisionPrompt?>, note: Binding<String>, board: Board, state: AppState) -> some View {
        let objecting = Binding(get: { prompt.wrappedValue?.kind == .object }, set: { if !$0 { prompt.wrappedValue = nil } })
        let closing = Binding(get: { prompt.wrappedValue?.kind == .close }, set: { if !$0 { prompt.wrappedValue = nil } })
        let seq = prompt.wrappedValue?.seq
        return self
            .alert("Object to this decision?", isPresented: objecting) {
                TextField("Why? (optional)", text: note)
                Button("Cancel", role: .cancel) {}
                Button("Object") { if let seq { let n = note.wrappedValue; Task { await state.vote(seq, in: board, agree: false, note: n) } } }
            } message: { Text("Everyone here sees your objection and your note.") }
            .alert("Close this decision", isPresented: closing) {
                TextField("A note for everyone (optional)", text: note)
                Button("Decided") { if let seq { let n = note.wrappedValue; Task { await state.closeDecision(seq, in: board, decided: true, note: n) } } }
                Button("Dropped", role: .destructive) { if let seq { let n = note.wrappedValue; Task { await state.closeDecision(seq, in: board, decided: false, note: n) } } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Decided tells agents they can act on it; Dropped, that they shouldn't.") }
    }
}
