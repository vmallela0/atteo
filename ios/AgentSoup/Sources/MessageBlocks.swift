// A message's blocks (vedu #1246/#1253, jxn #1255), like the web's renderText: fenced code (a header with its language
// and Copy, monospace, sideways scroll, long ones folded), Markdown tables ("| a | b |" with a "|---|--:|" line under
// the header: alignment from the colons), ```chart (a JSON spec drawn with Swift Charts, its numbers under "Data"),
// ```mermaid (the code, labelled Diagram: no renderer here yet) and ```status (a /status snapshot, as a monospace card).
// Everything else stays exactly what it was: inline Markdown, links, "#123" chips and @mentions, one Text per stretch.
// Parsed once per text (cached), and a message with no fence or table never leaves the fast path.

import Charts
import SwiftUI

enum MessageBlock: Hashable {
    case text(String)
    case code(String, String?) // the code, its language
    case table(MarkdownTable)
    case chart(ChartSpec, String) // the spec, and its source (shown as code if it can't be drawn)
    case mermaid(String)
    case status(String)
}

enum MessageBlocks {
    /// Parsed blocks by text: the same message re-renders often (scrolling, receipts, typing), parsing it once is enough.
    private final class Box { let blocks: [MessageBlock]; init(_ b: [MessageBlock]) { blocks = b } }
    private static let cache: NSCache<NSString, Box> = { let c = NSCache<NSString, Box>(); c.countLimit = 600; return c }()

    /// Could it hold a block at all? (Most messages can't: they skip parsing and the cache.)
    static func mayHaveBlocks(_ s: String) -> Bool { s.contains("```") || s.contains("|") }

    static func cached(_ s: String) -> [MessageBlock] {
        guard mayHaveBlocks(s) else { return [.text(s)] }
        let key = s as NSString
        if let hit = cache.object(forKey: key) { return hit.blocks }
        let blocks = parse(s)
        cache.setObject(Box(blocks), forKey: key)
        return blocks
    }

    /// The text's blocks, in order. No fence or table in it: one `.text` holding it unchanged.
    static func parse(_ s: String) -> [MessageBlock] {
        guard mayHaveBlocks(s) else { return [.text(s)] }
        let lines = s.components(separatedBy: "\n")
        var out: [MessageBlock] = []
        var para: [String] = []
        func flush() {
            let t = para.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !t.trimmingCharacters(in: .whitespaces).isEmpty { out.append(.text(t)) }
            para = []
        }
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let t = line.trimmingCharacters(in: .whitespaces)
            // ```lang … ```: a block only once it's closed (an unclosed fence is just text, as on the web).
            if t.hasPrefix("```"), let end = lines[(i + 1)...].firstIndex(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix("```") }) {
                flush()
                let lang = t.dropFirst(3).trimmingCharacters(in: .whitespaces).lowercased()
                out.append(fenced(lines[(i + 1)..<end].joined(separator: "\n"), lang.isEmpty ? nil : lang))
                i = end + 1
                continue
            }
            // A table: a "| … |" header, its "|---|" line, then its rows.
            if MarkdownTable.isRow(t), i + 1 < lines.count, MarkdownTable.isSeparator(lines[i + 1]) {
                var j = i + 2
                while j < lines.count, MarkdownTable.isRow(lines[j].trimmingCharacters(in: .whitespaces)) { j += 1 }
                if let table = MarkdownTable.parse(Array(lines[i..<j])) {
                    flush()
                    out.append(.table(table))
                    i = j
                    continue
                }
            }
            // No "|---|" line (agents often skip it, vedu #5446): 2+ "| … |" lines with the same number of cells (2+) are
            // a table too, its first line the header.
            if MarkdownTable.isRow(t), !MarkdownTable.isSeparator(t) {
                let n = MarkdownTable.cells(t).count
                var j = i + 1
                while j < lines.count {
                    let u = lines[j].trimmingCharacters(in: .whitespaces)
                    guard MarkdownTable.isRow(u), !MarkdownTable.isSeparator(u), MarkdownTable.cells(u).count == n else { break }
                    j += 1
                }
                if n >= 2, j - i >= 2 {
                    flush()
                    out.append(.table(MarkdownTable(header: MarkdownTable.cells(t), rows: lines[(i + 1)..<j].map(MarkdownTable.cells), aligns: [])))
                    i = j
                    continue
                }
            }
            para.append(line)
            i += 1
        }
        flush()
        if out.allSatisfy({ if case .text = $0 { return true } else { return false } }) { return [.text(s)] }
        return out
    }

    /// A closed fence, by its language.
    static func fenced(_ code: String, _ lang: String?) -> MessageBlock {
        switch lang {
        case "chart": return ChartSpec.parse(code).map { .chart($0, code) } ?? .code(code, lang)
        case "mermaid": return .mermaid(code)
        case "status": return .status(code)
        default: return .code(code, lang)
        }
    }
}

// MARK: - Tables

enum ColumnAlign: Hashable { case leading, center, trailing }

/// A Markdown table: its header, rows and each column's alignment (":--" left, "--:" right, ":-:" centre, nil: as the
/// cells suggest). Shared by the chat and Files (MarkdownText).
struct MarkdownTable: Hashable {
    var header: [String]
    var rows: [[String]]
    var aligns: [ColumnAlign?]

    /// "| a | b |" (the web's /^\s*\|.*\|\s*$/).
    static func isRow(_ trimmed: String) -> Bool { trimmed.count >= 2 && trimmed.hasPrefix("|") && trimmed.hasSuffix("|") }
    /// The "|---|:--:|" line under a header.
    static func isSeparator(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).range(of: #"^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$"#, options: .regularExpression) != nil
    }
    /// Reads as a number ("41", "1,200", "$5", "12%", "485 ms", "842 (n=100)"): its column lines up on the right.
    static func isNumeric(_ cell: String) -> Bool {
        Double(cell.replacingOccurrences(of: ",", with: "")) != nil
            || cell.range(of: #"^[-+−~≈<>]?[$€£¥]?\d[\d,.]*(\s?[%a-zA-Zµ]{0,3})?(\s*\([^)]*\))?$"#, options: .regularExpression) != nil
    }
    static func cells(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") { t.removeLast() }
        return t.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// Lines of a table (header, separator, rows), or nil when the second line isn't a separator.
    static func parse(_ lines: [String]) -> MarkdownTable? {
        guard lines.count >= 2, isSeparator(lines[1]) else { return nil }
        let aligns: [ColumnAlign?] = cells(lines[1]).map { c in
            c.hasPrefix(":") && c.hasSuffix(":") ? .center : c.hasSuffix(":") ? .trailing : c.hasPrefix(":") ? .leading : nil
        }
        return MarkdownTable(header: cells(lines[0]), rows: lines.dropFirst(2).map(cells), aligns: aligns)
    }
}

// MARK: - Charts

/// A ```chart spec, cleaned up like the web's parseChart (src/chart.ts): type bar (default) | line | area | pie, up to 8
/// series of up to 60 points, x labels padded with 1, 2, … where missing, anything that isn't a number counted as 0.
struct ChartSpec: Hashable {
    enum Kind: String { case bar, line, area, pie }
    struct Series: Hashable { let name: String; let values: [Double] }
    let kind: Kind
    let title: String?
    let x: [String]
    let series: [Series]
    let unit: String?

    static func parse(_ src: String) -> ChartSpec? {
        guard let data = src.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        let type = (o["type"] as? String)?.lowercased() ?? "bar"
        guard let kind = Kind(rawValue: type) else { return nil }
        func number(_ v: Any) -> Double {
            if let n = v as? NSNumber { let d = n.doubleValue; return d.isFinite ? d : 0 }
            if let s = v as? String, let d = Double(s.trimmingCharacters(in: .whitespaces)), d.isFinite { return d }
            return 0
        }
        let series = ((o["series"] as? [Any]) ?? []).prefix(8).enumerated().compactMap { i, s -> Series? in
            let r = s as? [String: Any] ?? [:]
            let values = ((r["values"] as? [Any]) ?? []).prefix(60).map(number)
            guard !values.isEmpty else { return nil }
            return Series(name: (r["name"] as? String).map { String($0.prefix(40)) } ?? String(localized: "Series \(i + 1)", bundle: .l10n), values: values)
        }
        guard !series.isEmpty else { return nil }
        let n = series.map(\.values.count).max() ?? 0
        var x = ((o["x"] as? [Any]) ?? []).prefix(60).map { v -> String in String(((v as? String) ?? "\(v)").prefix(24)) }
        while x.count < n { x.append(String(x.count + 1)) }
        return ChartSpec(kind: kind, title: (o["title"] as? String).map { String($0.prefix(120)) }, x: Array(x.prefix(n)),
                         series: series, unit: (o["unit"] as? String).map { String($0.prefix(12)) })
    }

    /// The numbers, as a table: a row per x, a column per series.
    var dataRows: [[String]] {
        let u = unit.map { " (\($0))" } ?? ""
        return [[""] + series.map { $0.name + u }] + x.indices.map { i in [x[i]] + series.map { i < $0.values.count ? Self.plain($0.values[i]) : "" } }
    }
    static func plain(_ v: Double) -> String { v == v.rounded() && abs(v) < 1e15 ? String(Int(v)) : String(format: "%g", v) }
}

/// The board's colours, in the web's order (accent, ok, warn, decision, danger, claim, task, muted).
enum ChartPalette {
    static let colors: [Color] = [
        Theme.accent, Theme.ok, Theme.warn, Theme.decision, Theme.danger, Theme.claim, Theme.task, Theme.muted,
    ]
    static func range(_ n: Int) -> [Color] { (0..<max(1, n)).map { colors[$0 % colors.count] } }
}

/// A chart in a message: its title, the drawing (Swift Charts), a legend when there's more than one series, and
/// "Data": the numbers as a table.
struct ChartBlock: View {
    let spec: ChartSpec
    @State private var showData = false

    private struct Point: Identifiable { let id: Int; let x: String; let series: String; let value: Double }
    private var points: [Point] {
        var out: [Point] = []
        for s in spec.series { for (i, v) in s.values.enumerated() where i < spec.x.count { out.append(Point(id: out.count, x: spec.x[i], series: s.name, value: v)) } }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            if let title = spec.title {
                (Text(title).foregroundColor(Theme.text) + Text(spec.unit.map { spec.kind == .pie ? "" : "  (\($0))" } ?? "").foregroundColor(Theme.faint))
                    .font(Typo.meta.weight(.semibold))
            }
            if spec.kind == .pie { pie } else { xy }
            Button { withAnimation(.snappy) { showData.toggle() } } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).rotationEffect(.degrees(showData ? 90 : 0))
                    Text("Data")
                }
                .font(Typo.ui(.caption2).weight(.semibold)).foregroundStyle(Theme.faint)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("chart-data")
            .accessibilityValue(showData ? "shown" : "hidden")
            if showData {
                TableBlock(rows: spec.dataRows, header: true, aligns: [.leading] + spec.series.map { _ in .trailing })
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("chart-table")
            }
        }
        .padding(Space.m)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chart")
        .accessibilityLabel(spec.title ?? String(localized: "Chart", bundle: .l10n))
    }

    private var names: [String] { spec.series.map(\.name) }

    @ViewBuilder private var xy: some View {
        Chart(points) { p in
            switch spec.kind {
            case .line:
                LineMark(x: .value("x", p.x), y: .value("value", p.value), series: .value("series", p.series))
                    .foregroundStyle(by: .value("series", p.series)).interpolationMethod(.monotone)
                    .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                PointMark(x: .value("x", p.x), y: .value("value", p.value)).foregroundStyle(by: .value("series", p.series)).symbolSize(18)
            case .area:
                AreaMark(x: .value("x", p.x), y: .value("value", p.value), series: .value("series", p.series), stacking: .unstacked)
                    .foregroundStyle(by: .value("series", p.series)).opacity(0.18).interpolationMethod(.monotone)
                LineMark(x: .value("x", p.x), y: .value("value", p.value), series: .value("series", p.series))
                    .foregroundStyle(by: .value("series", p.series)).interpolationMethod(.monotone)
                    .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
            default:
                BarMark(x: .value("x", p.x), y: .value("value", p.value))
                    .foregroundStyle(by: .value("series", p.series))
                    .position(by: .value("series", p.series))
                    .cornerRadius(3)
            }
        }
        .chartForegroundStyleScale(domain: names, range: ChartPalette.range(names.count))
        .chartLegend(names.count > 1 ? .visible : .hidden)
        .chartXAxis { AxisMarks { _ in AxisValueLabel().font(Typo.ui(.caption2)).foregroundStyle(Theme.muted) } }
        .chartYAxis {
            AxisMarks(position: .leading) { _ in
                AxisGridLine().foregroundStyle(Theme.line)
                AxisValueLabel().font(Typo.ui(.caption2)).foregroundStyle(Theme.muted)
            }
        }
        .frame(height: 180)
    }

    @ViewBuilder private var pie: some View {
        let values = spec.series[0].values.map { max(0, $0) }
        let total = max(values.reduce(0, +), .leastNonzeroMagnitude)
        let labels = Array(spec.x.prefix(values.count))
        HStack(alignment: .center, spacing: Space.l) {
            Chart(Array(values.enumerated()), id: \.offset) { i, v in
                SectorMark(angle: .value("value", v), innerRadius: .ratio(0.5), angularInset: 1.2)
                    .foregroundStyle(by: .value("x", labels[i]))
                    .cornerRadius(2)
            }
            .chartForegroundStyleScale(domain: labels, range: ChartPalette.range(labels.count))
            .chartLegend(.hidden)
            .frame(width: 140, height: 140)
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(labels.enumerated()), id: \.offset) { i, l in
                    HStack(spacing: 6) {
                        RoundedRectangle(cornerRadius: 3).fill(ChartPalette.colors[i % ChartPalette.colors.count]).frame(width: 10, height: 10)
                        Text(l).font(Typo.micro).foregroundStyle(Theme.text).lineLimit(1)
                        Text("\(Int((values[i] / total * 100).rounded()))%").font(Typo.micro).foregroundStyle(Theme.muted).monospacedDigit()
                    }
                }
            }
        }
    }
}

// MARK: - A fence, drawn

/// A closed ``` block in a message or a file: a chart, a diagram's code, a status card or code.
struct FencedBlock: View {
    let block: MessageBlock
    var maxLines: Int? = 16

    var body: some View {
        switch block {
        case .chart(let spec, _): ChartBlock(spec: spec)
        case .mermaid(let code):
            CodeBlock(code: code, language: "mermaid", label: "Diagram", maxLines: maxLines)
                .accessibilityElement(children: .contain).accessibilityIdentifier("mermaid-block")
        case .status(let s): StatusCard(text: s)
        case .code(let code, let lang): CodeBlock(code: code, language: lang, maxLines: maxLines)
        case .table(let t): TableBlock(table: t).accessibilityElement(children: .contain).accessibilityIdentifier("md-table")
        case .text(let t): Text(t.md)
        }
    }
}

/// The web's /status card as a plain-text snapshot: a quiet header and the lines in monospace, kept as they are.
struct StatusCard: View {
    let text: String
    var body: some View {
        let t = text.replacingOccurrences(of: #"\n+$"#, with: "", options: .regularExpression)
        VStack(alignment: .leading, spacing: 6) {
            Label("Status", systemImage: "waveform.path.ecg").labelStyle(.titleAndIcon)
                .font(Typo.ui(.caption2).weight(.semibold)).foregroundStyle(Theme.faint)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(t).font(CodeBlock.mono).foregroundStyle(Theme.text).lineSpacing(3)
                    .fixedSize(horizontal: true, vertical: false).textSelection(.enabled)
            }
        }
        .padding(Space.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.line, lineWidth: 0.5) }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("status-card")
    }
}

// MARK: - A message's body

/// What a message says: one Text when it's just words (the way it always was), else its blocks in order, the words
/// between them rendered the same way (inline Markdown, links, mentions).
struct MessageBody: View {
    let text: String
    /// The words as Text with their mentions boxed, and the handles mentioned (String.mentioned).
    let render: (String) -> (text: Text, handles: [String])
    var ink: Double = 0.92
    var lineSpacing: CGFloat = 1.5

    var body: some View {
        let blocks = MessageBlocks.cached(text)
        if blocks.count == 1, case .text(let t) = blocks[0] {
            words(t)
        } else {
            VStack(alignment: .leading, spacing: Space.s) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                    if case .text(let t) = b { words(t) } else { FencedBlock(block: b) }
                }
            }
        }
    }

    private func words(_ t: String) -> some View {
        let m = render(t)
        return m.text.textRenderer(MentionBoxes()).font(Typo.body).foregroundStyle(Theme.text.opacity(ink)).lineSpacing(lineSpacing)
            .accessibilityValue(m.handles.isEmpty ? "" : String(localized: "Mentions \(m.handles.joined(separator: ", "))", bundle: .l10n))
    }
}
