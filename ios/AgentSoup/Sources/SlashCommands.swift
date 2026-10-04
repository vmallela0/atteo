// Slash commands (#928–#930, like the web): everything a person types is a note, unless it starts with a command.
// Typing "/" in the message box shows a tiny row of chips; the command word is taken off the text when it's sent.
//   /task    a task: the first line is its title, the lines after it its checklist
//   /decide  a decision, which from a person is a human decision (Agree / Object, HumanDecisions.swift)
//   /ask     a question that stays open until someone answers it
// Agents' posts keep their own types (they post them through their tools).

import SwiftUI

enum SlashCommand: String, CaseIterable, Identifiable {
    case task, decide, ask
    var id: String { rawValue }
    var word: String { "/" + rawValue }
    /// The entry type it posts.
    var type: String { self == .task ? "task" : self == .decide ? "decision" : "question" }
    var hint: String {
        switch self {
        case .task: return String(localized: "Task, next lines a checklist", bundle: .l10n)
        case .decide: return String(localized: "Decision people agree on", bundle: .l10n)
        case .ask: return String(localized: "Question that stays open", bundle: .l10n)
        }
    }
    var icon: String { self == .task ? "checklist" : self == .decide ? "checkmark.seal" : "questionmark.circle" }

    /// What a board can take: an encrypted board's server can't read a task's title, so no /task there.
    static func available(on b: Board) -> [SlashCommand] { b.encrypted == true ? [.decide, .ask] : allCases }

    /// The command a draft starts with, and the text after it ("/task  Ship it" → (.task, "Ship it")).
    static func parse(_ draft: String, on b: Board) -> (SlashCommand, String)? {
        let t = draft.drop { $0 == " " }
        guard t.hasPrefix("/") else { return nil }
        for c in available(on: b) where t.lowercased().hasPrefix(c.word) {
            let rest = t.dropFirst(c.word.count)
            guard rest.isEmpty || rest.first!.isWhitespace else { continue }
            return (c, rest.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return nil
    }

    /// Commands that fit what's typed so far ("/", "/t", "/dec"), while the command word is still being typed.
    static func suggestions(_ draft: String, on b: Board) -> [SlashCommand] {
        guard draft.hasPrefix("/"), !draft.contains(where: \.isWhitespace) else { return [] }
        let q = draft.lowercased()
        return available(on: b).filter { $0.word.hasPrefix(q) }
    }

    /// The text to post: a task's lines after the title become "- [ ] …" checklist items.
    func body(_ text: String) -> String {
        guard self == .task else { return text }
        let lines = text.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let title = lines.first else { return text }
        let items = lines.dropFirst().filter { !$0.isEmpty }.map { l -> String in
            if l.hasPrefix("- [ ]") || l.lowercased().hasPrefix("- [x]") { return l }
            let bare = l.replacingOccurrences(of: "^([-*•]|\\d+[.)])\\s+", with: "", options: .regularExpression)
            return "- [ ] " + bare
        }
        return ([title] + items).joined(separator: "\n")
    }
}

/// The chips above the message box: every command that fits what's typed (tap one to start with it), or the one
/// the message will be sent as, lit.
struct SlashChips: View {
    let commands: [SlashCommand]
    var active: SlashCommand? = nil
    let pick: (SlashCommand) -> Void

    var body: some View {
        HStack(spacing: Space.xs) {
            ForEach(commands) { c in
                let on = c == active
                Button { pick(c) } label: {
                    HStack(spacing: 4) {
                        Image(systemName: c.icon).font(.system(size: 11, weight: .semibold))
                        Text(c.word).font(Typo.micro.weight(.semibold))
                        if commands.count == 1 || on { Text(c.hint).font(Typo.micro).foregroundStyle(on ? Theme.onText.opacity(0.8) : Theme.faint) }
                    }
                    .foregroundStyle(on ? Theme.onText : Theme.text)
                    .padding(.horizontal, 10).frame(minHeight: 28)
                    .background(on ? Theme.text : Theme.card, in: Capsule())
                    .contentShape(Capsule())
                }
                .buttonStyle(PressStyle())
                .accessibilityIdentifier("slash-\(c.rawValue)")
                .accessibilityLabel("\(c.word): \(c.hint)")
                .accessibilityAddTraits(on ? .isSelected : [])
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.l)
        .padding(.bottom, Space.xs)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}
