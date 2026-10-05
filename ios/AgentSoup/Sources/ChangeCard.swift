// A change entry ("Shipped to production (v12): 3 commits", or an agent's "here's what I changed") as a card, the way
// the web shows it (src/html.ts changeCardHtml): what shipped and where, commits · files with +adds −dels, the
// commits as one-liners, the files with +/− bars, and the diff behind "Show diff". Built from the entry's structured
// card (src/card.ts); a message carrying the card's text form (formatCard: "Change: …", "Commits:", "Files:",
// "----- diff -----") is read back into the same card, so the raw text never shows.

import SwiftUI

/// A change card as the server stores it (src/card.ts ChangeCard).
struct ChangeCardData: Codable, Hashable {
    struct Commit: Codable, Hashable { let sha: String; let title: String }
    struct File: Codable, Hashable { let path: String; let added: Int; let removed: Int }
    var repo: String? = nil
    var branch: String
    var base: String? = nil
    var prUrl: String? = nil
    var ci: String? = nil
    var commits: [Commit] = []
    var files: [File] = []

    var added: Int { files.reduce(0) { $0 + $1.added } }
    var removed: Int { files.reduce(0) { $0 + $1.removed } }

    /// Where tapping the card goes (vedu #1097): its pull request; else on GitHub, the one commit, or the compare view
    /// over all of them (commits are newest first, as `git log` lists them: from the oldest's parent to the newest).
    var link: URL? {
        if let pr = prUrl, let u = URL(string: pr), u.scheme == "https" { return u }
        guard let repo, repo.range(of: #"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil else { return nil }
        let shas = commits.map(\.sha).filter { $0.range(of: "^[0-9a-fA-F]{4,40}$", options: .regularExpression) != nil }
        guard let newest = shas.first, let oldest = shas.last else { return nil }
        return URL(string: "https://github.com/\(repo)/" + (shas.count == 1 ? "commit/\(newest)" : "compare/\(oldest)~1...\(newest)"))
    }
}

/// What a change entry shows: a headline, the card, and its diff when the text carried one.
struct ChangeView {
    let title: String // "Shipped to production"
    let chip: String? // "v12" or "feat/x → main"
    let card: ChangeCardData?
    let diff: String?
    let note: String? // what's left of the words, if anything

    /// From an entry: its card if it has one, else its text read as formatCard's layout.
    init(_ e: Entry) {
        let parsed = Self.parse(e.text)
        let card = e.card ?? parsed.card
        // "Shipped to production (v12): 3 commits": the headline, and the version for the chip.
        let head = parsed.head.isEmpty ? (e.title ?? "Change") : parsed.head
        let version = head.firstMatch(of: /\(([^)]{1,40})\)/).map { String($0.1) }
        var title = e.title?.trimmingCharacters(in: .whitespaces).nilIfEmpty
            ?? head.replacing(/\s*\([^)]*\)/, with: "").replacing(/:\s*\d+\s+commits?\s*$/, with: "").trimmingCharacters(in: .whitespaces)
        if title.isEmpty { title = String(localized: "change-card.untitled", defaultValue: "Change", bundle: .l10n, comment: "A change card with no title (a code change, the noun)") }
        self.title = title
        if let version { chip = version } else if let c = card { chip = c.base.map { "\(c.branch) → \($0)" } ?? c.branch } else { chip = nil }
        self.card = card
        diff = parsed.diff
        let rest = parsed.rest.trimmingCharacters(in: .whitespacesAndNewlines)
        note = rest.isEmpty || rest == head ? nil : rest
    }

    /// formatCard's text: "Change: …" / "Repo: …" / "PR: …" / "Commits:" + "  sha title" / "Files:" + "  +a −d  path" /
    /// "----- diff -----" … "----- end -----". Lines before "Change:" are the headline and any words.
    static func parse(_ text: String) -> (head: String, rest: String, card: ChangeCardData?, diff: String?) {
        var body = text
        var diff: String?
        if let r = body.range(of: "----- diff -----") {
            var d = String(body[r.upperBound...])
            if let end = d.range(of: "----- end -----", options: .backwards) { d = String(d[..<end.lowerBound]) }
            diff = d.trimmingCharacters(in: .newlines)
            body = String(body[..<r.lowerBound])
        }
        let lines = body.components(separatedBy: "\n")
        var head = "", words: [String] = []
        var card: ChangeCardData?
        var section = ""
        for raw in lines {
            let l = raw.trimmingCharacters(in: .whitespaces)
            if l.hasPrefix("Change:") {
                // "feat/x → main · 3 commits · 5 files +120 −30 · CI passing"
                let parts = l.dropFirst(7).components(separatedBy: " · ").map { $0.trimmingCharacters(in: .whitespaces) }
                let br = (parts.first ?? "").components(separatedBy: " → ")
                card = ChangeCardData(branch: br.first ?? "", base: br.count > 1 ? br[1] : nil)
                if let ci = parts.first(where: { $0.hasPrefix("CI ") }) { card?.ci = String(ci.dropFirst(3)) }
                section = ""
            } else if l.hasPrefix("Repo:"), card != nil { card?.repo = l.dropFirst(5).trimmingCharacters(in: .whitespaces) }
            else if l.hasPrefix("PR:"), card != nil { card?.prUrl = l.dropFirst(3).trimmingCharacters(in: .whitespaces) }
            else if l == "Commits:" || l == "Files:" { section = l }
            else if section == "Commits:", raw.hasPrefix("  "), let m = l.firstMatch(of: /^([0-9a-f]{4,40})\s+(.*)$/) {
                card?.commits.append(.init(sha: String(m.1), title: String(m.2)))
            } else if section == "Files:", raw.hasPrefix("  "), let m = l.firstMatch(of: /^\+(\d+)\s+[−-](\d+)\s+(.+)$/) {
                card?.files.append(.init(path: String(m.3), added: Int(m.1) ?? 0, removed: Int(m.2) ?? 0))
            } else if card == nil {
                if head.isEmpty && !l.isEmpty { head = l } else { words.append(raw) }
            }
        }
        return (head, words.joined(separator: "\n"), card, diff)
    }
}

private extension String { var nilIfEmpty: String? { isEmpty ? nil : self } }

/// The change as one rounded card: dense, quiet, in the app's colors.
struct ChangeCardView: View {
    let e: Entry
    let board: String
    @State private var showDiff = false
    @State private var diff: String?
    @State private var loading = false
    @State private var allLines = false
    @State private var allCommits = false
    @State private var allFiles = false
    @Environment(\.openURL) private var openURL

    private static let added = Color(light: UIColor(red: 0.13, green: 0.55, blue: 0.27, alpha: 1), dark: UIColor(red: 0.36, green: 0.78, blue: 0.47, alpha: 1))
    private static let removed = Color(light: UIColor(red: 0.78, green: 0.22, blue: 0.20, alpha: 1), dark: UIColor(red: 0.95, green: 0.42, blue: 0.40, alpha: 1))

    var body: some View {
        let v = ChangeView(e)
        VStack(alignment: .leading, spacing: 10) {
            header(v)
            if let c = v.card { stats(c); commits(c); files(c) }
            if let note = v.note { Text(note.md).font(Typo.secondary).foregroundStyle(Theme.muted).lineLimit(4) }
            diffSection(v)
        }
        .padding(Space.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        // Tap: the PR, or the commit(s) on GitHub (its own buttons, Show diff and "N more", still do their thing).
        .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .onTapGesture { if let u = v.card?.link { openURL(u) } }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("change-card")
        .accessibilityValue(v.card?.link?.absoluteString ?? "")
        .accessibilityHint(v.card?.link == nil ? Text(verbatim: "") : Text("Opens it on GitHub"))
    }

    private func header(_ v: ChangeView) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            Image(systemName: v.title.localizedCaseInsensitiveContains("ship") ? "shippingbox.fill" : "arrow.triangle.branch")
                .font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.accent)
            Text(v.title).font(Typo.secondary.weight(.semibold)).foregroundStyle(Theme.text).lineLimit(2)
                .accessibilityIdentifier("change-title")
            if let chip = v.chip {
                Text(chip).font(Typo.mono(.caption).weight(.medium)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Theme.raised, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                    .layoutPriority(-1)
            }
            Spacer(minLength: 0)
            if let ci = v.card?.ci, ci != "none" {
                Circle().fill(ci == "passing" ? Theme.ok : ci == "failing" ? Theme.danger : Theme.warn).frame(width: 7, height: 7)
                    .accessibilityLabel(ci == "passing" ? Text("CI passing") : ci == "failing" ? Text("CI failing") : Text("CI \(ci)"))
            }
            if let pr = v.card?.prUrl, let url = URL(string: pr) {
                Link(destination: url) { Image(systemName: "arrow.up.right.square").font(.system(size: 14)).foregroundStyle(Theme.muted) }
                    .accessibilityLabel("Open the pull request")
            }
        }
    }

    /// "3 commits · 5 files  +120 −30".
    private func stats(_ c: ChangeCardData) -> some View {
        HStack(spacing: 6) {
            Text([c.commits.isEmpty ? nil : String(localized: "\(c.commits.count) commits", bundle: .l10n), c.files.isEmpty ? nil : String(localized: "\(c.files.count) files", bundle: .l10n)].compactMap { $0 }.joined(separator: " · "))
                .foregroundStyle(Theme.muted)
            if !c.files.isEmpty {
                Text(verbatim: "+\(c.added)").foregroundStyle(Self.added)
                Text(verbatim: "−\(c.removed)").foregroundStyle(Self.removed)
            }
        }
        .font(Typo.micro.weight(.medium)).monospacedDigit()
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("change-stats")
    }

    @ViewBuilder private func commits(_ c: ChangeCardData) -> some View {
        if !c.commits.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                ForEach(Array((allCommits ? c.commits : Array(c.commits.prefix(4))).enumerated()), id: \.offset) { _, x in
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        Text(String(x.sha.prefix(7))).font(Typo.mono(.caption)).foregroundStyle(Theme.faint)
                        Text(x.title).font(Typo.meta).foregroundStyle(Theme.text.opacity(0.9)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    }
                }
                if c.commits.count > 4 { more(allCommits ? "Fewer commits" : "\(c.commits.count - 4) more commits") { allCommits.toggle() } }
            }
        }
    }

    @ViewBuilder private func files(_ c: ChangeCardData) -> some View {
        if !c.files.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array((allFiles ? c.files : Array(c.files.prefix(6))).enumerated()), id: \.offset) { _, f in
                    HStack(spacing: Space.s) {
                        Text(f.path).font(Typo.mono(.caption2)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.head)
                        Spacer(minLength: Space.xs)
                        HStack(spacing: 3) {
                            Text(verbatim: "+\(f.added)").foregroundStyle(Self.added)
                            Text(verbatim: "−\(f.removed)").foregroundStyle(Self.removed)
                        }
                        .font(Typo.mono(.caption2)).fixedSize()
                        bar(f.added, f.removed)
                    }
                }
                if c.files.count > 6 { more(allFiles ? "Fewer files" : "\(c.files.count - 6) more files") { allFiles.toggle() } }
            }
            .padding(.top, 2)
        }
    }

    /// GitHub's five squares: the share of added vs removed (a small change leaves some grey).
    private func bar(_ added: Int, _ removed: Int) -> some View {
        let total = added + removed, lit = min(5, total)
        let a = total > 0 ? Int((Double(lit * added) / Double(total)).rounded()) : 0
        let d = lit - a
        return HStack(spacing: 1.5) {
            ForEach(0..<5, id: \.self) { i in
                RoundedRectangle(cornerRadius: Radius.card).fill(i < a ? Self.added : i < a + d ? Self.removed : Theme.raised).frame(width: 6, height: 6)
            }
        }
        .accessibilityHidden(true)
    }

    private func more(_ label: LocalizedStringKey, _ action: @escaping () -> Void) -> some View {
        Button { withAnimation(.snappy) { action() } } label: { Text(label).font(Typo.micro.weight(.semibold)).foregroundStyle(Theme.muted) }
            .buttonStyle(.plain)
    }

    /// The diff: folded behind "Show diff"; open, small monospace lines on green / red, hunks dimmed, scrolling sideways
    /// inside the card, the first 40 lines until "Show all".
    @ViewBuilder private func diffSection(_ v: ChangeView) -> some View {
        let hasDiff = v.diff != nil || e.card != nil
        if hasDiff {
            VStack(alignment: .leading, spacing: Space.s) {
                Button {
                    if diff == nil { diff = v.diff }
                    withAnimation(.snappy) { showDiff.toggle() }
                    if showDiff && diff == nil { Task { await loadDiff() } }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: showDiff ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .bold))
                        (showDiff ? Text("Hide diff") : Text("Show diff")).font(Typo.micro.weight(.semibold))
                        if loading { ProgressView().controlSize(.mini).tint(Theme.faint) }
                    }
                    .foregroundStyle(Theme.muted).frame(minHeight: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("change-diff-toggle")
                if showDiff, let d = diff {
                    let lines = d.components(separatedBy: "\n")
                    let shown = allLines ? lines : Array(lines.prefix(40))
                    ScrollView(.horizontal, showsIndicators: false) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(shown.enumerated()), id: \.offset) { _, l in diffLine(l) }
                        }
                        .padding(.vertical, Space.xs)
                    }
                    .background(Theme.bg.opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                    .accessibilityIdentifier("change-diff")
                    if lines.count > 40 { more(allLines ? "Show less" : "Show all \(lines.count) lines") { allLines.toggle() } }
                } else if showDiff && !loading {
                    Text("No diff with this change.").font(Typo.micro).foregroundStyle(Theme.faint)
                }
            }
        }
    }

    private func diffLine(_ l: String) -> some View {
        let isFile = l.hasPrefix("+++") || l.hasPrefix("---") || l.hasPrefix("diff ") || l.hasPrefix("index ")
        let add = l.hasPrefix("+") && !isFile, del = l.hasPrefix("-") && !isFile, hunk = l.hasPrefix("@@")
        return Text(l.isEmpty ? " " : l)
            .font(Typo.mono(size: 11))
            .foregroundStyle(hunk || isFile ? Theme.faint : add ? Self.added : del ? Self.removed : Theme.text.opacity(0.85))
            .fixedSize()
            .padding(.horizontal, Space.s).padding(.vertical, 0.5)
            .frame(maxWidth: .infinity, alignment: .leading) // every line as wide as the widest, so the colors line up
            .background(add ? Self.added.opacity(0.12) : del ? Self.removed.opacity(0.12) : .clear)
    }

    private func loadDiff() async {
        struct R: Decodable { let diff: String? }
        loading = true
        defer { loading = false }
        let r = try? await API.shared.get("/api/boards/\(board)/entries/\(e.seq)", as: R.self)
        diff = r?.diff ?? ""
        if diff?.isEmpty == true { diff = nil; showDiff = true }
    }
}
