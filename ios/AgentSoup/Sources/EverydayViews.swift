// Everyday's pieces inside a chat (ios/qa/design/everyday, `compare`): a result card in place of a change card (the same
// entry; Developer mode still draws the commits). The Chat · To-dos · Files row is the board's tab strip (BoardTabs.swift).

import SwiftUI

/// A change in Everyday: what it is in a line, whether it's done, and a link to see it. No branch, commits or files.
struct ResultCard: View {
    let e: Entry
    @Environment(\.openURL) private var openURL

    /// Done (shipped, merged, checks passing), waiting (checks running), or needs a fix (checks failing).
    private enum Status { case done, waiting, failing }

    var body: some View {
        let v = ChangeView(e)
        let status = Self.status(v)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                mark(status).onFirstLine(6)
                Text(v.title).font(Typo.body.weight(.semibold)).foregroundStyle(Theme.text).lineLimit(2)
                    .accessibilityIdentifier("result-title")
            }
            Text(line(v, status)).font(Typo.secondary).foregroundStyle(Theme.muted).lineLimit(2)
            if let u = v.card?.link {
                Button { openURL(u) } label: {
                    Text(v.card?.prUrl != nil && status != .done ? "Preview" : "Open")
                        .font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.text)
                        .padding(.horizontal, Space.m).frame(height: 30)
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(Theme.line))
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressStyle())
                .padding(.top, 2)
                .accessibilityIdentifier("result-open")
            }
        }
        .padding(.horizontal, Space.m).padding(.vertical, Space.m - 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).stroke(Theme.line, lineWidth: 0.5))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("result-card")
    }

    private static func status(_ v: ChangeView) -> Status {
        let ci = (v.card?.ci ?? "").lowercased()
        if ci.contains("fail") { return .failing }
        if ci.contains("pending") || ci.contains("running") { return .waiting }
        return .done
    }

    /// One plain line: the words that came with it, else what kind of result it is.
    private func line(_ v: ChangeView, _ s: Status) -> String {
        switch s {
        case .failing: return String(localized: "Something needs fixing before it's ready.", bundle: .l10n)
        case .waiting: return String(localized: "Almost ready: still checking it.", bundle: .l10n)
        case .done:
            if let note = v.note?.split(separator: "\n").first.map(String.init), !note.isEmpty { return note }
            return v.title.localizedCaseInsensitiveContains("ship") ? String(localized: "It's live.", bundle: .l10n) : String(localized: "Ready.", bundle: .l10n)
        }
    }

    @ViewBuilder private func mark(_ s: Status) -> some View {
        switch s {
        case .done:
            Image(systemName: "checkmark").font(.system(size: 9, weight: .black)).foregroundStyle(Theme.onText)
                .frame(width: 18, height: 18).background(Theme.ok, in: Circle())
                .accessibilityLabel("Done")
        case .waiting:
            Circle().fill(Theme.warn).frame(width: 8, height: 8).frame(width: 18, height: 18).accessibilityLabel("Waiting")
        case .failing:
            Circle().fill(Theme.danger).frame(width: 8, height: 8).frame(width: 18, height: 18).accessibilityLabel("Needs a fix")
        }
    }
}
