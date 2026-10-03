// A board's files, read-only: every file posted on a board is a versioned document. The list (newest first), and a
// clean reader: Markdown set as text (headings, lists, checklists, code), anything else as it is, in monospace; older
// versions one tap away.

import SwiftUI

struct FilesList: View {
    @EnvironmentObject var state: AppState
    let board: String
    @State private var docs: [DocMeta]?

    var body: some View {
        List {
            ForEach(docs ?? []) { d in
                NavigationLink { DocViewer(board: board, name: d.name) } label: { FileRow(doc: d) }
                    .accessibilityIdentifier("file-\(d.name)")
            }
            .listRowBackground(Theme.card)
        }
        .listSectionSpacing(.compact)
        .scrollContentBackground(.hidden)
        .background(Theme.bg)
        .navigationTitle("Files")
        .navigationBarTitleDisplayMode(.inline)
        .overlay {
            if docs == nil { ProgressView() }
            else if docs?.isEmpty == true { ContentUnavailableView("No files yet", systemImage: "doc", description: Text("Files and docs agents share here show up with every version.")) }
        }
        .task { let d = await state.docs(board); withAnimation(.smooth) { docs = d.sorted { $0.updatedAt > $1.updatedAt } } }
        .refreshable { docs = await state.docs(board).sorted { $0.updatedAt > $1.updatedAt } }
    }
}

private struct FileRow: View {
    let doc: DocMeta
    var body: some View {
        HStack(spacing: Space.m) {
            RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.raised).frame(width: 34, height: 34)
                .overlay(Image(systemName: icon(doc.name, mime: doc.mime)).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.muted))
            VStack(alignment: .leading, spacing: Space.xxs) {
                Text(doc.name).font(Typo.rowTitleRead).foregroundStyle(Theme.text).lineLimit(1)
                Text("v\(doc.version) · \(doc.via == "agent" ? "\(doc.updatedBy)'s agent" : doc.updatedBy) · \(doc.updatedAt.ago)")
                    .font(Typo.micro).foregroundStyle(Theme.faint).lineLimit(1)
            }
        }
        .padding(.vertical, Space.xxs)
    }
}

func icon(_ name: String, mime: String? = nil) -> String {
    if mime?.hasPrefix("image/") == true { return "photo" }
    let ext = (name as NSString).pathExtension.lowercased()
    switch ext {
    case "", "md", "markdown", "txt": return "doc.text"
    case "log": return "text.alignleft"
    case "json", "yaml", "yml", "toml": return "curlybraces"
    case "png", "jpg", "jpeg", "gif", "webp": return "photo"
    default: return "chevron.left.forwardslash.chevron.right"
    }
}

/// One file: its latest version, or any older one from the picker at the top.
struct DocViewer: View {
    @EnvironmentObject var state: AppState
    let board: String
    let name: String
    @State private var doc: Doc?
    @State private var versions: [DocVersion] = []
    @State private var failed = false

    private var prose: Bool { let e = (name as NSString).pathExtension.lowercased(); return e.isEmpty || ["md", "markdown", "txt"].contains(e) }

    var body: some View {
        ScrollView {
            if let doc {
                VStack(alignment: .leading, spacing: Space.m) {
                    let by = doc.via == "agent" ? "\(doc.updatedBy)'s agent" : doc.updatedBy
                    HStack(spacing: Space.s) {
                        if doc.version < doc.latest { Pill(text: "Older version", color: Theme.warn) }
                        Text("v\(doc.version) of \(doc.latest) · \(by) · \(doc.updatedAt.ago)").font(Typo.micro).foregroundStyle(Theme.faint)
                    }
                    if let s = versions.first(where: { $0.version == doc.version })?.summary, !s.isEmpty {
                        Text(s).font(Typo.meta).foregroundStyle(Theme.muted)
                    }
                    if prose {
                        MarkdownText(source: doc.content)
                    } else {
                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(doc.content).font(.system(.footnote, design: .monospaced)).foregroundStyle(Theme.text).textSelection(.enabled)
                                .padding(Space.m)
                        }
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                    }
                }
                .padding(Space.l)
                .frame(maxWidth: .infinity, alignment: .leading)
                .id(doc.version)
                .transition(.opacity)
            } else if failed {
                ContentUnavailableView("Couldn't open this file", systemImage: "doc", description: Text("Pull to try again."))
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 80)
            }
        }
        .background(Theme.bg)
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if versions.count > 1, let doc {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        ForEach(versions.sorted { $0.version > $1.version }) { v in
                            Button { Task { await load(v.version) } } label: {
                                Label("v\(v.version)\(v.version == doc.latest ? " · latest" : "") · \(v.author)", systemImage: v.version == doc.version ? "checkmark" : "clock")
                                if let s = v.summary, !s.isEmpty { Text(s) }
                            }
                        }
                    } label: {
                        HStack(spacing: 3) { Text("v\(doc.version)").monospacedDigit(); Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)) }
                            .font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.text)
                            .padding(.horizontal, 10).frame(height: 28).background(Theme.raised, in: Capsule())
                    }
                    .accessibilityIdentifier("doc-version")
                }
            }
        }
        .task {
            async let d: Void = load(nil)
            async let h = state.docHistory(board, name)
            _ = await d
            versions = await h
        }
        .refreshable { await load(doc?.version == doc?.latest ? nil : doc?.version) }
    }

    private func load(_ version: Int?) async {
        if let d = await state.doc(board, name, version: version) { withAnimation(.smooth) { doc = d }; failed = false } else if doc == nil { failed = true }
    }
}

/// Markdown, set as text: headings, paragraphs, bullet and numbered lists, checklists, quotes, rules and code blocks
/// (inline styles, links and `code` inside each). Calm: the app's type scale, no outlines.
struct MarkdownText: View {
    let source: String

    enum Block: Hashable {
        case heading(Int, String), paragraph(String), bullet(String, Int), number(String, String), check(String, Bool), quote(String), code(String), rule
    }

    static func blocks(_ s: String) -> [Block] {
        var out: [Block] = []
        var para: [String] = []
        var code: [String]? = nil
        func flush() { if !para.isEmpty { out.append(.paragraph(para.joined(separator: " "))); para = [] } }
        for raw in s.components(separatedBy: "\n") {
            if code != nil {
                if raw.trimmingCharacters(in: .whitespaces).hasPrefix("```") { out.append(.code(code!.joined(separator: "\n"))); code = nil } else { code!.append(raw) }
                continue
            }
            let line = raw.trimmingCharacters(in: .whitespaces)
            let indent = (raw.prefix { $0 == " " }.count) / 2
            if line.hasPrefix("```") { flush(); code = []; continue }
            if line.isEmpty { flush(); continue }
            if let m = line.firstMatch(of: #/^(#{1,6})\s+(.*)$/#) { flush(); out.append(.heading(m.1.count, String(m.2))); continue }
            if line == "---" || line == "***" || line == "___" { flush(); out.append(.rule); continue }
            if let m = line.firstMatch(of: #/^[-*+]\s+\[([ xX])\]\s*(.*)$/#) { flush(); out.append(.check(String(m.2), m.1 != " ")); continue }
            if let m = line.firstMatch(of: #/^[-*+]\s+(.*)$/#) { flush(); out.append(.bullet(String(m.1), indent)); continue }
            if let m = line.firstMatch(of: #/^(\d+)[.)]\s+(.*)$/#) { flush(); out.append(.number(String(m.1), String(m.2))); continue }
            if let m = line.firstMatch(of: #/^>\s?(.*)$/#) { flush(); out.append(.quote(String(m.1))); continue }
            para.append(line)
        }
        if let code { out.append(.code(code.joined(separator: "\n"))) }
        flush()
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            ForEach(Array(Self.blocks(source).enumerated()), id: \.offset) { _, b in
                switch b {
                case .heading(let level, let t):
                    Text(t.md).font(level == 1 ? .title2.weight(.bold) : level == 2 ? .headline : .subheadline.weight(.semibold))
                        .foregroundStyle(Theme.text).padding(.top, level <= 2 ? Space.s : Space.xs)
                case .paragraph(let t):
                    Text(t.md).font(Typo.body).foregroundStyle(Theme.text).lineSpacing(3)
                case .bullet(let t, let indent):
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        Circle().fill(Theme.faint).frame(width: 4, height: 4).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 4 }
                        Text(t.md).font(Typo.body).foregroundStyle(Theme.text)
                    }
                    .padding(.leading, CGFloat(indent) * Space.l + Space.xs)
                case .number(let n, let t):
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        Text("\(n).").font(Typo.body.monospacedDigit()).foregroundStyle(Theme.muted)
                        Text(t.md).font(Typo.body).foregroundStyle(Theme.text)
                    }
                case .check(let t, let done):
                    CheckLine(text: t, done: done)
                case .quote(let t):
                    Text(t.md).font(Typo.body).foregroundStyle(Theme.muted)
                        .padding(.leading, Space.m)
                        .overlay(alignment: .leading) { Capsule().fill(Theme.raised).frame(width: 3) }
                case .code(let t):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(t).font(.system(.footnote, design: .monospaced)).foregroundStyle(Theme.text).padding(Space.m)
                    }
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                case .rule:
                    Rectangle().fill(Theme.line).frame(height: 0.5).padding(.vertical, Space.xs)
                }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
