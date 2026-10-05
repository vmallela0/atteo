// A board's files: every file posted on a board is a versioned document. The list (newest first, searchable, a type
// icon, size, version, who changed it last and when), and a clean reader: Markdown set as text (headings, lists,
// checklists, quotes, tables, code in monospace that scrolls sideways), code and data as they are (line numbers;
// CSV as a table); older versions one tap away. Pictures and other stored files open in Quick Look. Everything shares.

import SwiftUI

// MARK: - The list

/// What kind of file, by its type or extension: an icon and a quiet tint.
enum FileKind {
    case doc, code, data, table, image, log, pdf, other

    init(name: String, mime: String?) {
        let ext = (name as NSString).pathExtension.lowercased()
        if mime?.hasPrefix("image/") == true || ["png", "jpg", "jpeg", "gif", "webp", "heic"].contains(ext) { self = .image; return }
        if mime == "application/pdf" || ext == "pdf" { self = .pdf; return }
        switch ext {
        case "", "md", "markdown", "txt", "rtf": self = .doc
        case "log", "out": self = .log
        case "json", "yaml", "yml", "toml", "xml", "plist", "env", "ini": self = .data
        case "csv", "tsv": self = .table
        default: self = mime == nil ? .code : .other
        }
    }

    var icon: String {
        switch self {
        case .doc: return "doc.text"
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .data: return "curlybraces"
        case .table: return "tablecells"
        case .image: return "photo"
        case .log: return "text.alignleft"
        case .pdf: return "doc.richtext"
        case .other: return "doc"
        }
    }

    var tint: Color {
        switch self {
        case .doc: return Theme.kindDoc
        case .code: return Theme.kindCode
        case .data: return Theme.warn
        case .table: return Theme.ok
        case .image: return Theme.kindImage
        case .log: return Theme.muted
        case .pdf: return Theme.danger
        case .other: return Theme.muted
        }
    }

    /// Read here as text (Markdown, code, data); anything else (pictures, PDFs, other binaries) opens in Quick Look.
    var readable: Bool { self != .image && self != .pdf && self != .other }
}

func icon(_ name: String, mime: String? = nil) -> String { FileKind(name: name, mime: mime).icon }

extension DocMeta {
    var kind: FileKind { FileKind(name: name, mime: mime) }
    /// "theo's agent", "maya".
    var by: String { via == "agent" ? String(localized: "\(updatedBy)'s agent", bundle: .l10n) : updatedBy }
    /// A stored file (picture, PDF, binary) rather than a text document.
    var stored: Bool { mime != nil || !kind.readable }
}

/// The files of the boards you've opened, so switching back to Files shows them at once (then refreshes).
@MainActor
final class FileIndex: ObservableObject {
    static let shared = FileIndex()
    @Published var docs: [String: [DocMeta]] = [:]
    func load(_ board: String) async {
        let d = await AppState.shared.docs(board)
        if d != docs[board] { withAnimation(.smooth) { docs[board] = d } }
    }
}

enum FileSort: String, CaseIterable, Identifiable {
    case recent = "Recently updated", name = "Name", size = "Size"
    var id: String { rawValue }
    /// Its name in the app's language.
    var label: String {
        switch self {
        case .recent: return String(localized: "Recently updated", bundle: .l10n)
        case .name: return String(localized: "Name", bundle: .l10n)
        case .size: return String(localized: "Size", bundle: .l10n)
        }
    }
}

/// A board's files as their own screen (Board info → Files).
struct FilesList: View {
    let board: String
    var body: some View {
        FilesPane(board: board)
            .background(Theme.bg)
            .navigationTitle("Files")
            .navigationBarTitleDisplayMode(.inline)
    }
}

/// How the files are ordered: recently updated (the default), name, size.
struct FileSortMenu: View {
    @Binding var sort: FileSort
    var body: some View {
        Menu {
            Picker("Sort by", selection: $sort.animation(.smooth)) {
                ForEach(FileSort.allCases) { s in Text(s.label).tag(s) }
            }
        } label: {
            Image(systemName: "arrow.up.arrow.down").font(.system(size: 13, weight: .semibold)).foregroundStyle(sort == .recent ? Theme.muted : Theme.accent)
                .frame(width: 34, height: 34).background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .accessibilityLabel("Sort")
        .accessibilityValue(sort.label)
        .accessibilityIdentifier("files-sort")
    }
}

/// A board's files: search, sort (recently updated first), one dense row each. Text opens in the reader; pictures
/// and other stored files in Quick Look; an .html file also has Preview (HTMLPreview.swift). Long-press to share or copy the name. Embeddable in any navigation stack.
struct FilesPane: View {
    @EnvironmentObject var state: AppState
    @ObservedObject private var index = FileIndex.shared
    let board: String
    @State private var sort: FileSort = .recent
    @State private var query = ""
    @State private var reading: DocMeta?
    @State private var preview: URL?
    @State private var opening: String?
    @State private var sharing: SharedFile?
    @State private var running: HTMLPreviewTarget? // an .html file, previewed (HTMLPreview.swift)
    @FocusState private var searching: Bool

    private var docs: [DocMeta]? { index.docs[board] }

    private var shown: [DocMeta] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let hits = (docs ?? []).filter { q.isEmpty || $0.name.lowercased().contains(q) || $0.by.lowercased().contains(q) }
        switch sort {
        case .recent: return hits.sorted { $0.updatedAt > $1.updatedAt }
        case .name: return hits.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        case .size: return hits.sorted { $0.size > $1.size }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
        header
        List {
            ForEach(shown) { d in
                let html = HTMLPreview.available(board: board, name: d.name, stored: d.stored)
                HStack(spacing: Space.s) {
                    Button { open(d) } label: { FileRow(doc: d, loading: opening == d.name) }
                        .buttonStyle(RowPressStyle())
                        .accessibilityIdentifier("file-\(d.name)")
                    if html { PreviewButton { running = HTMLPreviewTarget(board: board, name: d.name, version: d.version) } }
                }
                    .listRowInsets(EdgeInsets(top: 0, leading: Space.l, bottom: 0, trailing: Space.l))
                    .listRowBackground(Theme.bg)
                    .listRowSeparatorTint(Theme.line)
                    .alignmentGuide(.listRowSeparatorLeading) { _ in 46 }
                    .contextMenu {
                        Button(d.stored ? "Preview" : "Open", systemImage: d.stored ? "eye" : "doc.text") { open(d) }
                        if html { Button("Preview", systemImage: "eye") { running = HTMLPreviewTarget(board: board, name: d.name, version: d.version) } }
                        Button("Share…", systemImage: "square.and.arrow.up") { share(d) }
                        Button("Copy name", systemImage: "doc.on.doc") { UIPasteboard.general.string = d.name }
                    }
                    .swipeActions(edge: .trailing) {
                        Button { share(d) } label: { Label("Share", systemImage: "square.and.arrow.up") }.tint(Theme.raised)
                    }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.immediately)
        .background(Theme.bg)
        .environment(\.defaultMinListRowHeight, 0)
        .overlay {
            if docs == nil {
                ProgressView()
            } else if docs?.isEmpty == true {
                EmptyNote(icon: "doc.on.doc", title: "No files yet", line: "Docs and files shared here show up with every version.")
            } else if shown.isEmpty {
                EmptyNote(icon: "magnifyingglass", title: "No matches", line: "Nothing called “\(query)”.", action: ("Clear search", { query = "" }))
            }
        }
        }
        .background(Theme.bg)
        .navigationDestination(item: $reading) { d in DocViewer(board: board, name: d.name) }
        .quickLookPreview($preview)
        .htmlPreview($running)
        .sheet(item: $sharing) { s in ShareSheet(items: [s.url]).presentationDetents([.medium, .large]).ignoresSafeArea() }
        .task { await index.load(board) }
        // Live: a file shared or a doc written posts an artifact line to the board (the chat's socket brings it in);
        // only those reload the list, not every message.
        .onChange(of: state.entries[board]?.last(where: { $0.type == "artifact" && $0.pending != true })?.seq) { _, _ in Task { await index.load(board) } }
        .refreshable { await index.load(board) }
    }

    private var header: some View {
        HStack(spacing: Space.s) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.faint)
                TextField("Search files", text: $query)
                    .font(Typo.secondary)
                    .focused($searching)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .accessibilityIdentifier("files-search")
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 14)).foregroundStyle(Theme.faint) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 10).frame(height: 34)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            // In the content, not the navigation bar: the bar stays Tasks | Files … Done.
            FileSortMenu(sort: $sort)
        }
        .padding(.horizontal, Space.l).padding(.top, Space.s).padding(.bottom, Space.xs)
        .background(Theme.bg)
    }

    private func open(_ d: DocMeta) {
        searching = false
        guard d.stored else { reading = d; return }
        guard opening == nil else { return }
        opening = d.name
        Task {
            defer { opening = nil }
            do { preview = try await FileExport.url(board: board, doc: d) } catch { Haptics.play(.failed); state.report(error) }
        }
    }

    private func share(_ d: DocMeta) {
        Task {
            do { sharing = SharedFile(url: try await FileExport.url(board: board, doc: d)) } catch { Haptics.play(.failed); state.report(error) }
        }
    }
}

/// One file: a tinted type icon, its name, who changed it last and when; its size and version on the right.
struct FileRow: View {
    @EnvironmentObject var state: AppState
    let doc: DocMeta
    var loading = false
    @Environment(\.chatDensity) private var density
    var body: some View {
        HStack(spacing: Space.m) {
            FileKindIcon(kind: doc.kind)
            VStack(alignment: .leading, spacing: 3) {
                Text(doc.name).font(Typo.secondary.weight(.medium)).foregroundStyle(Theme.text).lineLimit(1).truncationMode(.middle)
                HStack(spacing: 5) {
                    Avatar(name: doc.updatedBy, agent: doc.via == "agent", size: 14)
                    Text("\(state.displayName(for: doc.updatedBy, agent: doc.via == "agent")) · \(doc.updatedAt.ago)").font(Typo.micro).foregroundStyle(Theme.muted).lineLimit(1)
                }
            }
            Spacer(minLength: Space.s)
            if loading {
                ProgressView().controlSize(.small)
            } else {
                VStack(alignment: .trailing, spacing: 3) {
                    Text(doc.size.bytes).font(Typo.micro).monospacedDigit().foregroundStyle(Theme.faint)
                    Text("v\(doc.version)").font(Typo.micro.weight(.medium)).monospacedDigit().foregroundStyle(doc.version > 1 ? Theme.muted : Theme.faint)
                }
            }
        }
        .frame(minHeight: density == .compact ? 44 : 56)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

struct FileKindIcon: View {
    let kind: FileKind
    var size: CGFloat = 34
    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.27, style: .continuous).fill(kind.tint.opacity(0.14))
            .frame(width: size, height: size)
            .overlay(Image(systemName: kind.icon).font(.system(size: size * 0.4, weight: .semibold)).foregroundStyle(kind.tint))
    }
}

// MARK: - Files on this phone (Quick Look, Share)

struct SharedFile: Identifiable { let url: URL; var id: String { url.path } }

enum FileExport {
    /// A board file on disk under its own name (Quick Look and Share show it): stored bytes as they are, a
    /// document's text as a file. Kept per version, so a version is fetched once.
    @MainActor
    static func url(board: String, doc: DocMeta, version: Int? = nil) async throws -> URL {
        let v = version ?? doc.version
        let u = MediaStore.shared.url(board: board, name: doc.name, version: v)
        if FileManager.default.fileExists(atPath: u.path) { return u }
        if doc.stored {
            _ = try await MediaStore.shared.data(board: board, name: doc.name, version: v)
            return u
        }
        guard let d = await AppState.shared.doc(board, doc.name, version: v) else { throw APIError.server(String(localized: "Couldn't open \(doc.name).", bundle: .l10n)) }
        return try write(d.content, to: u)
    }

    /// A document's text, written where Share can pick it up.
    static func url(board: String, doc: Doc) throws -> URL {
        let u = MediaStore.shared.url(board: board, name: doc.name, version: doc.version)
        if FileManager.default.fileExists(atPath: u.path) { return u }
        return try write(doc.content, to: u)
    }

    private static func write(_ text: String, to u: URL) throws -> URL {
        try FileManager.default.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: u, options: .atomic)
        return u
    }
}

/// The system share sheet (AirDrop, Mail, Files, Copy…).
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

// MARK: - The reader

/// One file: its latest version, or any older one from the picker at the top. Share sends the version you're reading.
struct DocViewer: View {
    @EnvironmentObject var state: AppState
    let board: String
    let name: String
    @State private var doc: Doc?
    @State private var versions: [DocVersion] = []
    @State private var failed = false
    @State private var file: URL?
    @State private var image: UIImage?
    @State private var preview: URL?

    private var kind: FileKind { FileKind(name: name, mime: nil) }

    var body: some View {
        ScrollView {
            if let doc {
                VStack(alignment: .leading, spacing: 0) {
                    byline(doc)
                    Rectangle().fill(Theme.line).frame(height: 0.5).padding(.top, Space.m).padding(.bottom, Space.l)
                    content(doc)
                }
                .padding(.horizontal, Space.l).padding(.top, Space.s).padding(.bottom, Space.xl)
                .frame(maxWidth: .infinity, alignment: .leading)
                .id(doc.version)
                .transition(.opacity)
            } else if failed {
                EmptyNote(icon: "doc", title: "Couldn't open this file", line: "Pull to try again.").padding(.top, 80)
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
                                let who = v.via == "agent" ? String(localized: "\(v.author)'s agent", bundle: .l10n) : v.author
                                Label(v.version == doc.latest ? "v\(v.version) · latest · \(who)" : "v\(v.version) · \(who)", systemImage: v.version == doc.version ? "checkmark" : "clock")
                                Text([v.summary, v.ts.ago].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                            }
                        }
                    } label: {
                        HStack(spacing: 3) { Text("v\(doc.version)").monospacedDigit(); Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)) }
                            .font(Typo.meta.weight(.semibold)).foregroundStyle(doc.version < doc.latest ? Theme.warn : Theme.text)
                            .padding(.horizontal, 10).frame(height: 28)
                    }
                    .accessibilityIdentifier("doc-version")
                }
            }
            if let file {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: file) { ToolbarIcon("square.and.arrow.up") }
                        .accessibilityLabel("Share")
                        .accessibilityIdentifier("doc-share")
                }
            }
        }
        .quickLookPreview($preview)
        .task {
            async let d: Void = load(nil)
            async let h = state.docHistory(board, name)
            _ = await d
            versions = await h
        }
        .refreshable { await load(doc?.version == doc?.latest ? nil : doc?.version) }
    }

    private func byline(_ doc: Doc) -> some View {
        let by = state.displayName(for: doc.updatedBy, agent: doc.via == "agent")
        let summary = versions.first(where: { $0.version == doc.version })?.summary
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Avatar(name: doc.updatedBy, agent: doc.via == "agent", size: 18)
                Text(by).font(Typo.meta.weight(.medium)).foregroundStyle(Theme.text)
                Text("· \(doc.updatedAt.ago) · v\(doc.version) of \(doc.latest)").font(Typo.meta).foregroundStyle(Theme.faint).monospacedDigit()
                Spacer(minLength: 0)
                if doc.version < doc.latest { Pill(text: "Older version", color: Theme.warn) }
            }
            .lineLimit(1)
            if let summary, !summary.isEmpty, !summary.hasPrefix("Shared ") {
                Text(summary).font(Typo.meta).foregroundStyle(Theme.muted)
            }
        }
    }

    @ViewBuilder private func content(_ doc: Doc) -> some View {
        switch kind {
        case .doc where (name as NSString).pathExtension.lowercased() != "txt":
            MarkdownText(source: doc.content)
        case .doc:
            Text(doc.content).font(Typo.body).foregroundStyle(Theme.text).lineSpacing(4).textSelection(.enabled)
        case .table:
            TableBlock(rows: CSV.rows(doc.content, tab: (name as NSString).pathExtension.lowercased() == "tsv"), header: true)
        case .image, .pdf, .other:
            Button {
                Task { preview = try? await FileExport.url(board: board, doc: DocMeta(name: doc.name, version: doc.version, updatedBy: doc.updatedBy, updatedAt: doc.updatedAt, via: doc.via, size: 0, mime: "application/octet-stream")) }
            } label: {
                if let image {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                } else {
                    Label("Open in Quick Look", systemImage: "eye").font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.text)
                        .padding(.horizontal, 14).frame(height: 32).background(Theme.raised, in: Capsule())
                }
            }
            .buttonStyle(PressStyle())
            .task(id: doc.version) { if kind == .image { image = try? await MediaStore.shared.thumbnail(board: board, name: doc.name, version: doc.version) } }
        default:
            CodeBlock(code: doc.content, numbered: true)
        }
    }

    private func load(_ version: Int?) async {
        if let d = await state.doc(board, name, version: version) {
            withAnimation(.smooth) { doc = d }
            failed = false
            file = kind.readable ? try? FileExport.url(board: board, doc: d) : nil
        } else if doc == nil { failed = true }
    }
}

// MARK: - Markdown, code and tables

/// Markdown, set as text: headings, paragraphs, bullet and numbered lists, checklists, quotes, rules, tables and code
/// blocks (inline styles, links and `code` inside each). Calm: the app's type scale, no outlines.
struct MarkdownText: View {
    let source: String
    var compact = false

    enum Block: Hashable {
        case heading(Int, String), paragraph(String), bullet(String, Int), number(String, String, Int), check(String, Bool), quote(String), code(String, String?), table(MarkdownTable), rule
    }

    static func blocks(_ s: String) -> [Block] {
        var out: [Block] = []
        var para: [String] = []
        var code: [String]? = nil
        var lang: String? = nil
        var table: [String] = []
        func flush() { if !para.isEmpty { out.append(.paragraph(para.joined(separator: " "))); para = [] } }
        // A table with its "|---|" line takes its alignment from it (MarkdownTable, shared with the chat); without
        // one, every "|" line is a row (files written loosely still read as tables).
        func flushTable() {
            guard !table.isEmpty else { return }
            if let t = MarkdownTable.parse(table) { out.append(.table(t)) } else {
                let rows = table.map(MarkdownTable.cells).filter { !$0.allSatisfy({ $0.range(of: #"^:?-{2,}:?$"#, options: .regularExpression) != nil }) }
                if let h = rows.first { out.append(.table(MarkdownTable(header: h, rows: Array(rows.dropFirst()), aligns: []))) }
            }
            table = []
        }
        for raw in s.components(separatedBy: "\n") {
            if code != nil {
                if raw.trimmingCharacters(in: .whitespaces).hasPrefix("```") { out.append(.code(code!.joined(separator: "\n"), lang)); code = nil } else { code!.append(raw) }
                continue
            }
            let line = raw.trimmingCharacters(in: .whitespaces)
            let indent = (raw.prefix { $0 == " " }.count) / 2
            if line.hasPrefix("|") {
                flush()
                table.append(line)
                continue
            }
            flushTable()
            if line.hasPrefix("```") {
                flush(); code = []
                let l = line.dropFirst(3).trimmingCharacters(in: .whitespaces)
                lang = l.isEmpty ? nil : l
                continue
            }
            if line.isEmpty { flush(); continue }
            if let m = line.firstMatch(of: #/^(#{1,6})\s+(.*)$/#) { flush(); out.append(.heading(m.1.count, String(m.2))); continue }
            if line == "---" || line == "***" || line == "___" { flush(); out.append(.rule); continue }
            if let m = line.firstMatch(of: #/^[-*+]\s+\[([ xX])\]\s*(.*)$/#) { flush(); out.append(.check(String(m.2), m.1 != " ")); continue }
            if let m = line.firstMatch(of: #/^[-*+]\s+(.*)$/#) { flush(); out.append(.bullet(String(m.1), indent)); continue }
            if let m = line.firstMatch(of: #/^(\d+)[.)]\s+(.*)$/#) { flush(); out.append(.number(String(m.1), String(m.2), indent)); continue }
            if let m = line.firstMatch(of: #/^>\s?(.*)$/#) { flush(); out.append(.quote(String(m.1))); continue }
            para.append(line)
        }
        if let code { out.append(.code(code.joined(separator: "\n"), lang)) }
        flushTable()
        flush()
        return out
    }

    private var bodyFont: Font { compact ? Typo.secondary : Typo.body }

    var body: some View {
        let blocks = Self.blocks(source)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { i, b in
                view(b).padding(.top, i == 0 ? 0 : gap(before: b, after: blocks[i - 1]))
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Room above a block: more before a heading, a little between list items, a paragraph's worth otherwise.
    private func gap(before b: Block, after prev: Block) -> CGFloat {
        let s: CGFloat = compact ? 0.75 : 1
        switch (b, prev) {
        case (.heading(let l, _), _): return (l <= 2 ? 22 : 16) * s
        case (_, .heading): return 8 * s
        case (.bullet, .bullet), (.number, .number), (.check, .check), (.bullet, .number), (.number, .bullet): return 5 * s
        default: return 12 * s
        }
    }

    @ViewBuilder private func view(_ b: Block) -> some View {
        switch b {
        case .heading(let level, let t):
            Text(t.md)
                .font(level == 1 ? .title2.weight(.bold) : level == 2 ? .title3.weight(.semibold) : level == 3 ? .headline : .subheadline.weight(.semibold))
                .foregroundStyle(level >= 4 ? Theme.muted : Theme.text)
                .tracking(level == 1 ? -0.3 : 0)
        case .paragraph(let t):
            Text(t.md).font(bodyFont).foregroundStyle(Theme.text).lineSpacing(4)
        case .bullet(let t, let indent):
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Circle().fill(indent > 0 ? Theme.faint.opacity(0) : Theme.muted).overlay(Circle().stroke(Theme.muted, lineWidth: 1))
                    .frame(width: 5, height: 5).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 4 }
                Text(t.md).font(bodyFont).foregroundStyle(Theme.text).lineSpacing(3)
            }
            .padding(.leading, CGFloat(indent) * 18 + 4)
        case .number(let n, let t, let indent):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(n).").font(bodyFont.monospacedDigit()).foregroundStyle(Theme.muted).frame(minWidth: 18, alignment: .trailing)
                Text(t.md).font(bodyFont).foregroundStyle(Theme.text).lineSpacing(3)
            }
            .padding(.leading, CGFloat(indent) * 18)
        case .check(let t, let done):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: done ? "checkmark.circle.fill" : "circle").font(.system(size: 14)).foregroundStyle(done ? Theme.ok : Theme.faint)
                Text(t.md).font(bodyFont).foregroundStyle(done ? Theme.faint : Theme.text).strikethrough(done, color: Theme.faint)
            }
        case .quote(let t):
            Text(t.md).font(bodyFont).foregroundStyle(Theme.muted).lineSpacing(3)
                .padding(.leading, 14)
                .overlay(alignment: .leading) { Capsule().fill(Theme.raised).frame(width: 3) }
        case .code(let t, let lang):
            FencedBlock(block: MessageBlocks.fenced(t, lang), maxLines: nil) // a chart draws, a diagram is labelled
        case .table(let t):
            TableBlock(table: t)
        case .rule:
            Rectangle().fill(Theme.line).frame(height: 0.5).padding(.vertical, Space.xs)
        }
    }
}

/// Code in monospace on a quiet fill: scrolls sideways (lines never wrap), optional line numbers, a language label
/// and a copy button.
struct CodeBlock: View {
    let code: String
    var language: String? = nil
    var numbered = false
    var label: LocalizedStringKey? = nil // instead of the language ("Diagram")
    var maxLines: Int? = nil // longer: folded to this many, with "Show all"
    @State private var copied = false
    @State private var expanded = false

    /// Courier Prime, the agent layer's face (design language v1).
    static let mono: Font = Typo.mono(size: 12.5)

    var body: some View {
        let code = self.code.replacingOccurrences(of: #"\n+$"#, with: "", options: .regularExpression)
        let lines = code.components(separatedBy: "\n")
        let folded = !expanded && maxLines.map { lines.count > $0 + 2 } == true
        let shown = folded ? lines.prefix(maxLines ?? lines.count).joined(separator: "\n") : code
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Space.s) {
                if let label {
                    (Text(label).foregroundColor(Theme.muted) + Text(language.map { "  \($0)" } ?? "").foregroundColor(Theme.faint))
                        .font(Typo.ui(.caption2).weight(.semibold))
                } else {
                    (language.map { Text(verbatim: $0) } ?? (numbered ? Text("\(lines.count) lines") : Text("code")))
                        .font(Typo.ui(.caption2).weight(.semibold)).foregroundStyle(Theme.faint).textCase(language == nil ? nil : .lowercase)
                }
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    Haptics.play(.copied)
                    withAnimation(.snappy) { copied = true }
                    Task { try? await Task.sleep(nanoseconds: 1_400_000_000); withAnimation(.snappy) { copied = false } }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(Typo.ui(.caption2).weight(.semibold)).foregroundStyle(copied ? Theme.ok : Theme.muted)
                        .labelStyle(.titleAndIcon)
                        .contentTransition(.opacity)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("code-copy")
            }
            .padding(.horizontal, Space.m).padding(.top, 8).padding(.bottom, 2)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: Space.m) {
                    if numbered {
                        Text((1...max(1, lines.count)).map(String.init).joined(separator: "\n"))
                            .foregroundStyle(Theme.faint.opacity(0.7)).multilineTextAlignment(.trailing)
                    }
                    Text(SyntaxHighlight.attributed(shown, language: colourBy(code))).foregroundStyle(Theme.text).textSelection(.enabled) // coloured by language (SyntaxHighlight.swift)
                }
                .font(Self.mono)
                .lineSpacing(3)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, Space.m).padding(.top, 4).padding(.bottom, Space.m)
            }
            .accessibilityIdentifier("code-block")
            .accessibilityValue(SyntaxHighlight.accessibilityValue(colourBy(code), code: shown))
            if folded || (expanded && maxLines != nil) {
                Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                    Label(expanded ? "Show less" : "Show all \(lines.count) lines", systemImage: expanded ? "chevron.up" : "chevron.down")
                        .labelStyle(.titleAndIcon).font(Typo.ui(.caption2).weight(.semibold)).foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, Space.m).padding(.top, -4).padding(.bottom, 10)
                .accessibilityIdentifier("code-expand")
            }
        }
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// A table (Markdown or CSV): a header row in semibold, hairlines between rows, sideways scroll when it's wide.
struct TableBlock: View {
    let rows: [[String]]
    var header = true
    var aligns: [ColumnAlign?] = [] // per column, from a Markdown table's "|:--|--:|" (nil / missing: as the cells suggest)

    init(rows: [[String]], header: Bool = true, aligns: [ColumnAlign?] = []) { self.rows = rows; self.header = header; self.aligns = aligns }
    init(table t: MarkdownTable) { self.init(rows: [t.header] + t.rows, header: true, aligns: t.aligns) }

    var body: some View {
        let width = rows.map(\.count).max() ?? 0
        let shown = Array(rows.prefix(300))
        // A column of numbers lines up on the right (like a spreadsheet).
        let body = header ? Array(shown.dropFirst()) : shown
        let numeric = (0..<width).map { c in
            let cells = body.compactMap { c < $0.count ? $0[c] : nil }.filter { !$0.isEmpty }
            return !cells.isEmpty && cells.allSatisfy { Double($0.replacingOccurrences(of: ",", with: "")) != nil }
        }
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 0) {
                ForEach(Array(shown.enumerated()), id: \.offset) { i, r in
                    GridRow {
                        ForEach(0..<width, id: \.self) { c in
                            let cell = c < r.count ? r[c] : ""
                            Text(cell.md)
                                .font(header && i == 0 ? Typo.meta.weight(.semibold) : Typo.meta)
                                .foregroundStyle(header && i == 0 ? Theme.text : Theme.muted)
                                .monospacedDigit()
                                .lineLimit(1)
                                .padding(.vertical, 8)
                                .gridColumnAlignment(align(c, numeric[c]))
                        }
                    }
                    if i < shown.count - 1 {
                        Rectangle().fill(header && i == 0 ? Theme.raised : Theme.line).frame(height: header && i == 0 ? 1 : 0.5).gridCellUnsizedAxes(.horizontal)
                    }
                }
            }
            .padding(.horizontal, Space.m).padding(.vertical, 2)
        }
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(alignment: .bottomTrailing) {
            if rows.count > shown.count { Text("first \(shown.count) of \(rows.count) rows").font(Typo.ui(.caption2)).foregroundStyle(Theme.faint).padding(6) }
        }
    }
}

extension TableBlock {
    fileprivate func align(_ c: Int, _ numeric: Bool) -> HorizontalAlignment {
        switch c < aligns.count ? aligns[c] : nil {
        case .leading?: return .leading
        case .center?: return .center
        case .trailing?: return .trailing
        case nil: return numeric ? .trailing : .leading
        }
    }
}

/// CSV / TSV rows (quoted fields, commas inside quotes).
enum CSV {
    static func rows(_ s: String, tab: Bool = false) -> [[String]] {
        let sep: Character = tab ? "\t" : ","
        var rows: [[String]] = []
        for line in s.split(whereSeparator: \.isNewline) where !line.trimmingCharacters(in: .whitespaces).isEmpty {
            var cells: [String] = [], cur = "", quoted = false
            for ch in line {
                if ch == "\"" { quoted.toggle() } else if ch == sep && !quoted { cells.append(cur); cur = "" } else { cur.append(ch) }
            }
            cells.append(cur)
            rows.append(cells.map { $0.trimmingCharacters(in: .whitespaces) })
        }
        return rows
    }
}
