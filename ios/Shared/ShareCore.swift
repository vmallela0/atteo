// Atteo in the share sheet (vedu #4110): what the Share Extension sends, and to where. Pure and compiled into both the
// app (so AtteoTests can test it) and the extension (ShareExtension/). The requests are the app's own: one file is the
// raw body of POST /api/boards/:id/upload with its details in the query, several are one multipart message, and words
// alone are a note (POST /api/boards/:id/entries), each with an Idempotency-Key.

import Foundation
import UIKit

/// Something shared into Atteo, after the extension has read it: bytes that already fit, or words (a link is words).
enum SharedPayload: Equatable {
    case file(name: String, mime: String, data: Data, width: Int?, height: Int?)
    case text(String)
}

/// A board or chat you can send to (GET /api/me/boards, only what the extension needs).
struct ShareBoard: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    var kind: String? = nil
    var lastActivity: Double = 0
    var encrypted: Bool? = nil
    var archived: Bool? = nil
}

enum ShareError: LocalizedError, Equatable {
    case nothing, tooLarge(String), tooMany(Int)
    var errorDescription: String? {
        switch self {
        case .nothing: return "Nothing to send."
        case .tooLarge(let n): return "\(n) is too large (max 1.5 MB)."
        case .tooMany(let n): return "At most \(ShareCore.maxFiles) files at once (got \(n))."
        }
    }
}

enum ShareCore {
    /// The server's limits (src/board.ts MAX_IMAGE, MAX_FILES_PER_MESSAGE).
    static let maxFile = 1_500_000
    static let maxFiles = 10

    /// The server's JSON is snake_case (last_activity), as the app reads it (JSONDecoder.soup).
    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    /// Where you can send: not end-to-end encrypted (the extension doesn't hold the board keys), not archived; most
    /// recently active first.
    static func pickable(_ boards: [ShareBoard]) -> [ShareBoard] {
        boards.filter { $0.encrypted != true && $0.archived != true }.sorted { $0.lastActivity > $1.lastActivity }
    }

    /// A chat with one person ("maya ↔ priya") is called by the other person; a board by its title.
    static func displayName(_ b: ShareBoard, me: String?) -> String {
        guard b.kind == "direct" else { return b.title }
        return b.title.components(separatedBy: "↔").map { $0.trimmingCharacters(in: .whitespaces) }.first { $0 != me && !$0.isEmpty } ?? b.title
    }

    /// The search box: every word must appear in the name (any case).
    static func filter(_ boards: [ShareBoard], query: String, me: String?) -> [ShareBoard] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return boards }
        return boards.filter { b in
            let name = displayName(b, me: me).lowercased()
            return words.allSatisfy { name.contains($0) }
        }
    }

    /// The message's words: your note first, then any shared text or link, each on its own line.
    static func text(note: String, payloads: [SharedPayload]) -> String {
        let shared: [String] = payloads.compactMap { if case .text(let t) = $0 { return t } else { return nil } }
        return ([note] + shared).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: "\n")
    }

    /// Words with their formatting (a Messages bubble, Notes, a web page) come as these types beside or instead of plain
    /// text; their bytes are never a file to upload (vedu #5209/#5212: four "rich text with attachments -RTFD- data").
    static let richTextTypes = ["com.apple.flat-rtfd", "com.apple.rtfd", "public.rtf"]

    /// A rich-text UTI registered by the pasteboard/provider. File names are deliberately never passed here: names
    /// such as "public.key.txt" and "com.apple.notes.txt" are ordinary files, not pasteboard type identifiers.
    static func richTextType(matching hasType: (String) -> Bool) -> String? {
        richTextTypes.first(where: hasType)
    }

    /// Rich text as its plain words, line breaks kept and the pictures' placeholders dropped; nil if it isn't words.
    static func plainText(rich data: Data, type: String) -> String? {
        let docs: [NSAttributedString.DocumentType] = type == "public.rtf" ? [.rtf] : [.rtfd, .rtf]
        for doc in docs {
            guard let a = try? NSAttributedString(data: data, options: [.documentType: doc], documentAttributes: nil) else { continue }
            let t = a.string.replacingOccurrences(of: "\u{FFFC}", with: "").replacingOccurrences(of: "\r\n", with: "\n")
                .replacingOccurrences(of: "\u{2028}", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : t
        }
        return nil
    }

    /// The one request that posts all of it to `board`.
    static func request(board: String, payloads: [SharedPayload], note: String, base: URL, token: String,
                        idempotencyKey: String = UUID().uuidString) throws -> URLRequest {
        let files: [(name: String, mime: String, data: Data, w: Int?, h: Int?)] = payloads.compactMap {
            if case .file(let n, let m, let d, let w, let h) = $0 { return (n, m, d, w, h) } else { return nil }
        }
        let words = String(text(note: note, payloads: payloads).prefix(4000))
        if files.count > maxFiles { throw ShareError.tooMany(files.count) }
        if let big = files.first(where: { $0.data.count > maxFile }) { throw ShareError.tooLarge(big.name) }
        let boardPath = "api/boards/\(board.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? board)"
        var r: URLRequest
        switch files.count {
        case 0:
            guard !words.isEmpty else { throw ShareError.nothing }
            r = URLRequest(url: base.appendingPathComponent(boardPath + "/entries"))
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.httpBody = try JSONSerialization.data(withJSONObject: ["type": "note", "text": words], options: [.sortedKeys])
        case 1:
            let f = files[0]
            var q = [URLQueryItem(name: "name", value: f.name)]
            if let w = f.w, let h = f.h { q += [URLQueryItem(name: "w", value: String(w)), URLQueryItem(name: "h", value: String(h))] }
            if !words.isEmpty { q.append(URLQueryItem(name: "text", value: words)) }
            var c = URLComponents(url: base.appendingPathComponent(boardPath + "/upload"), resolvingAgainstBaseURL: false)!
            c.queryItems = q
            c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B") // a literal +, not a space
            r = URLRequest(url: c.url!)
            r.setValue(f.mime, forHTTPHeaderField: "content-type")
            r.httpBody = f.data
        default:
            var form = Form()
            if !words.isEmpty { form.field("text", words) }
            for f in files {
                form.file("file", filename: f.name, mime: f.mime, data: f.data)
                form.field("w", f.w.map(String.init) ?? "")
                form.field("h", f.h.map(String.init) ?? "")
                form.field("name", f.name)
            }
            r = URLRequest(url: base.appendingPathComponent(boardPath + "/upload"))
            r.setValue(form.contentType, forHTTPHeaderField: "content-type")
            r.httpBody = form.finish()
        }
        r.httpMethod = "POST"
        r.timeoutInterval = 120
        r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        r.setValue(idempotencyKey, forHTTPHeaderField: "idempotency-key")
        r.setValue("Atteo-iOS-Share", forHTTPHeaderField: "user-agent")
        return r
    }

    /// multipart/form-data, as the app's own uploads build it (API.swift's Multipart).
    struct Form {
        let boundary = "atteo-" + UUID().uuidString
        private(set) var body = Data()
        var contentType: String { "multipart/form-data; boundary=\(boundary)" }
        mutating func field(_ name: String, _ value: String) {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
        }
        mutating func file(_ name: String, filename: String, mime: String, data: Data) {
            let safe = filename.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "")
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(safe)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8))
            body.append(data)
            body.append(Data("\r\n".utf8))
        }
        mutating func finish() -> Data {
            body.append(Data("--\(boundary)--\r\n".utf8))
            return body
        }
    }

    /// The server's cleanFileName (Attachments.clean), so the name shown is the one it keeps.
    static func cleanName(_ raw: String) -> String {
        var n = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        n = n.replacingOccurrences(of: "[^A-Za-z0-9 ._\\-/]", with: "-", options: .regularExpression)
        n = n.replacingOccurrences(of: "\\.{2,}", with: ".", options: .regularExpression)
        n = n.replacingOccurrences(of: "/{2,}", with: "/", options: .regularExpression)
        n = n.replacingOccurrences(of: "^[^A-Za-z0-9]+", with: "", options: .regularExpression)
        n = String(n.prefix(80)).trimmingCharacters(in: .whitespaces)
        return n.isEmpty ? "file" : n
    }
}
