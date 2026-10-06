// Pasted rich text shown as text (vedu #5225): files a Mac pasted as RTF/RTFD, named like "rich text with attachments
// -RTFD- data" (-2, -3…), show as one quoted "Pasted text" block, a line per file, instead of file chips (like the
// web). The words come from the file's RTF as plain text (ShareCore.plainText: never HTML); each line keeps a button
// that opens the original. A file with no RTF in it (an encrypted board's) shows its name.

import SwiftUI

enum PastedText {
    /// A file that's pasted rich text, by its pasteboard-type name, an .rtf/.rtfd name, or an RTF type.
    static func isRich(name: String?, mime: String?) -> Bool {
        let n = (name ?? "").trimmingCharacters(in: .whitespaces)
        if n.range(of: "-RTFD?-\\s*data(?:[-\\s]\\d+)?$", options: [.regularExpression, .caseInsensitive]) != nil { return true }
        if n.range(of: "\\.rtfd?$", options: [.regularExpression, .caseInsensitive]) != nil { return true }
        let m = (mime ?? "").split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
        return ["text/rtf", "application/rtf", "com.apple.flat-rtfd", "com.apple.rtfd", "com.apple.rtf", "public.rtf"].contains(m)
    }

    /// The words in a rich-text file's bytes (RTF, or a flat RTFD around it); nil when there's no RTF in them.
    static func text(from data: Data) -> String? {
        guard let at = data.range(of: Data("{\\rtf".utf8)) else { return nil } // only ever read as RTF, never sniffed
        if data.starts(with: Data("rtfd".utf8)), let t = ShareCore.plainText(rich: data, type: "com.apple.flat-rtfd") { return t }
        return ShareCore.plainText(rich: Data(data[at.lowerBound...]), type: "public.rtf") // the RTF (a flat RTFD's stream on its own)
    }

    /// Words already read, so scrolling back doesn't parse again.
    private static let cache = NSCache<NSString, NSString>()

    /// A file's words: from memory, else its bytes (this phone's copy while it sends, else MediaStore) read off the main thread.
    static func load(_ f: FileRef, board: String) async -> String? {
        let key = "\(board)/\(f.name)/\(f.version ?? 0)/\(f.local ?? "")" as NSString
        if let t = cache.object(forKey: key) { return t as String }
        let data: Data?
        if let local = f.local { data = try? Data(contentsOf: URL(fileURLWithPath: local)) } else { data = try? await MediaStore.shared.data(board: board, name: f.name, version: f.version) }
        guard let data, let t = await Task.detached(operation: { text(from: data) }).value else { return nil }
        if f.version != nil { cache.setObject(t as NSString, forKey: key) }
        return t
    }
}

/// One quote with a "Pasted text" label: a line per file, its words at message size, a button to open the original.
struct PastedTextQuote: View {
    let e: Entry
    let board: String
    let files: [FileRef]

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text("Pasted text", bundle: .l10n).font(Typo.micro).foregroundStyle(Theme.faint)
                .accessibilityIdentifier("pasted-label")
            ForEach(Array(files.enumerated()), id: \.offset) { i, f in
                if i > 0 { Rectangle().fill(Theme.line).frame(height: 1).padding(.vertical, Space.xxs) }
                PastedLine(e: e, board: board, file: f)
            }
        }
        .padding(.leading, Space.m).padding(.trailing, Space.s).padding(.vertical, Space.s)
        .frame(maxWidth: 520, alignment: .leading)
        .background(Theme.card, in: UnevenRoundedRectangle(cornerRadii: .init(topLeading: 2, bottomLeading: 2, bottomTrailing: 8, topTrailing: 8), style: .continuous))
        .overlay(alignment: .leading) { RoundedRectangle(cornerRadius: 1.5, style: .continuous).fill(Theme.faint.opacity(0.7)).frame(width: 3) } // like a reply's quote
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pasted-text")
    }
}

private struct PastedLine: View {
    let e: Entry
    let board: String
    let file: FileRef
    @State private var text: String?
    @State private var failed = false
    @State private var opening = false
    @State private var preview: URL?

    var body: some View {
        HStack(alignment: .top, spacing: Space.s) {
            Group {
                if let text {
                    Text(verbatim: text).font(Typo.body).foregroundStyle(Theme.text).textSelection(.enabled)
                        .accessibilityIdentifier("pasted-line")
                } else if failed {
                    Text(verbatim: file.name).font(Typo.meta.monospaced()).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                        .accessibilityIdentifier("pasted-name")
                } else {
                    Text(verbatim: "…").font(Typo.body).foregroundStyle(Theme.faint)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: open) {
                Group {
                    if opening { ProgressView().controlSize(.mini) } else { Image(systemName: "doc").font(.system(size: 13, weight: .regular)) }
                }
                .foregroundStyle(Theme.faint).frame(width: 28, height: 24).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(e.pending == true)
            .accessibilityLabel(Text("Open the original", bundle: .l10n))
            .accessibilityIdentifier("pasted-original")
        }
        .task(id: "\(file.name)/\(file.version ?? 0)/\(file.local ?? "")") {
            text = await PastedText.load(file, board: board)
            failed = text == nil
        }
        .quickLookPreview($preview)
    }

    private func open() {
        guard !opening else { return }
        opening = true
        Task {
            defer { opening = false }
            do { preview = try await MediaStore.shared.file(for: file.entry(of: e), board: board) } catch { Haptics.play(.failed); AppState.shared.report(error) }
        }
    }
}
