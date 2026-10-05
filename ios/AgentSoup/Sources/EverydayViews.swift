// Everyday's pieces inside a chat (ios/qa/design/everyday, `chat` and `compare`): the Chat · To-dos · Files row under
// the title, and a result card in place of a change card (the same entry; Developer mode still draws the commits).

import SwiftUI

/// Under a chat's title in Everyday: Chat (where you are), To-dos with how many are open, and Files. To-dos and Files
/// open the chat's work sheet on that half.
struct EverydayChatTabs: View {
    let tasks: [WorkTask]
    let open: (WorkPane) -> Void

    var body: some View {
        let openCount = tasks.filter { $0.status != "done" && $0.status != "stopped" && $0.parent == nil }.count
        HStack(spacing: Space.xl) {
            VStack(spacing: 6) {
                Text("Chat").font(Typo.secondary.weight(.semibold)).foregroundStyle(Theme.text)
                Capsule().fill(Theme.text).frame(height: 2)
            }
            .fixedSize()
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits([.isSelected, .isButton])
            .accessibilityIdentifier("tab-chat")
            tab("To-dos", count: openCount, id: "tab-todos") { open(.tasks) }
            tab("Files", count: 0, id: "tab-files") { open(.files) }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.l).padding(.top, Space.xs)
        .background(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 0.5) }
        .background(Theme.bg)
    }

    private func tab(_ title: LocalizedStringKey, count: Int, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 6) {
                HStack(spacing: 6) {
                    Text(title).font(Typo.secondary).foregroundStyle(Theme.muted)
                    if count > 0 { Text("\(count)").font(Typo.meta).foregroundStyle(Theme.faint).monospacedDigit() }
                }
                Capsule().fill(.clear).frame(height: 2)
            }
            .fixedSize()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier(id)
    }
}

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
                        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).stroke(Theme.line))
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
