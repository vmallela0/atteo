// Report a bug (jxn #3336; the app's side, #3337): a row near the top of Settings, and a shake anywhere. Either one
// opens a sheet that asks for a note; pictures are yours to add (jxn #4116): the paper clip (Photos) or Paste in the
// note, up to four, shown as removable thumbnails like the message box's. Nothing is captured for you: reports land
// on a board agents read, and a picture gets past every filter that keeps People only and Just mine messages from
// agents (#3356). The report goes to POST /api/bugs (#3341), which posts it to the developers' bug board; the app adds
// its version, the phone, iOS and the open board's id (never its messages).

import PhotosUI
import SwiftUI
import UIKit

/// The chat on screen, for the report's context (set by BoardView as it appears and leaves).
@MainActor
enum BugContext {
    static var board: String?
}

/// A picture as the server takes it: a PNG or a JPEG, at most 2 MB.
@MainActor
enum BugScreenshot {
    /// A JPEG under the server's 2 MB cap (with room to spare): lower quality first, then smaller, until it fits.
    static func jpeg(_ image: UIImage, limit: Int = 1_900_000) -> Data? {
        var img = image
        for _ in 0..<6 {
            for q in [0.7, 0.5, 0.35] as [CGFloat] {
                if let d = img.jpegData(compressionQuality: q), d.count <= limit { return d }
            }
            let size = CGSize(width: img.size.width * 0.75, height: img.size.height * 0.75)
            let fmt = UIGraphicsImageRendererFormat.default()
            fmt.scale = img.scale
            img = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
        }
        return nil
    }

    /// One attached picture as a file part: a PNG or JPEG that already fits goes as it is; anything else (a GIF, or
    /// too big) is re-encoded as a JPEG under the cap. Nil if it isn't a picture at all.
    static func part(_ a: Attachment, limit: Int = 1_900_000) -> (data: Data, mime: String)? {
        if a.mime == "image/jpeg" || a.mime == "image/png", a.data.count <= limit { return (a.data, a.mime) }
        guard a.isImage, let img = UIImage(data: a.data), let d = jpeg(img, limit: limit) else { return nil }
        return (d, "image/jpeg")
    }

    /// The report's pictures as file parts. The server takes up to 4 and all of them together under 2 MB (#4117,
    /// src/bugs.ts), so each gets an even share of 1.9 MB and is made smaller only if it's over its share.
    static func parts(_ pictures: [Attachment], total: Int = 1_900_000) -> [(data: Data, mime: String)] {
        let some = Array(pictures.filter(\.isImage).prefix(4))
        guard !some.isEmpty else { return [] }
        let share = total / some.count
        return some.compactMap { part($0, limit: share) }
    }
}

/// The report's facts the developers need, without the person typing them.
enum BugReportContext {
    static var appVersion: String {
        let i = Bundle.main.infoDictionary
        return "\(i?["CFBundleShortVersionString"] as? String ?? "?") (\(i?["CFBundleVersion"] as? String ?? "?"))"
    }

    /// The model identifier (iPhone17,1), or the simulator's.
    static var device: String {
        if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return sim + " (Simulator)" }
        var u = utsname()
        uname(&u)
        return withUnsafeBytes(of: &u.machine) { raw in String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self) }
    }

    /// The form's text parts, as POST /api/bugs reads them: note (≤2000), path, and context as JSON (the board's id only,
    /// never its messages).
    @MainActor static func fields(note: String) -> [(name: String, value: String)] {
        var context: [String: String] = ["app_version": appVersion, "device": device, "os": "iOS \(UIDevice.current.systemVersion)"]
        if let b = BugContext.board { context["board"] = b }
        let json = (try? JSONSerialization.data(withJSONObject: context, options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return [
            ("note", String(note.trimmingCharacters(in: .whitespacesAndNewlines).prefix(2000))),
            ("path", BugContext.board.map { "/b/\($0)" } ?? "app"),
            ("context", json),
        ]
    }

    /// The whole report as multipart/form-data: the fields, then each picture as a "screenshot" file part, in order
    /// (the server takes several since #4117).
    @MainActor static func form(note: String, pictures: [(data: Data, mime: String)]) -> Multipart {
        var m = Multipart()
        for f in fields(note: note) { m.field(f.name, f.value) }
        for (i, p) in pictures.enumerated() {
            let ext = p.mime == "image/png" ? "png" : "jpg"
            m.file("screenshot", filename: i == 0 ? "screenshot.\(ext)" : "screenshot-\(i + 1).\(ext)", mime: p.mime, data: p.data)
        }
        return m
    }
}

/// One report being written (the sheet's item).
struct BugReportDraft: Identifiable {
    let id = UUID()
}

/// The Settings row (both faces): opens the report over Settings.
struct ReportBugRow: View {
    @State private var draft: BugReportDraft?

    var body: some View {
        Section {
            Button {
                draft = BugReportDraft()
            } label: {
                Label("Report a bug", systemImage: "ladybug")
                    .foregroundStyle(Theme.text)
            }
            .accessibilityIdentifier("settings-report-bug")
            // On the row itself: a .sheet on a List Section (not a real view) never presents.
            .sheet(item: $draft) { _ in ReportBugView().presentationBackground(Theme.bg) }
        } footer: { Text("Tell the developers what went wrong. You can also shake your phone anywhere.") }
        .listRowBackground(Theme.card)
    }
}

/// The report: a note, pictures you add (removable), Send; the result shows inline.
struct ReportBugView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var noteFocused = false
    @State private var pictures: [Attachment] = []
    @State private var preparing = 0 // picked, still being made to fit
    @State private var picked: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var sending = false
    @State private var sent = false
    @State private var failure: String?
    private let maxPictures = 4

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: Space.l) {
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text("What happened?").font(Typo.section).foregroundStyle(Theme.muted)
                        noteBox
                    }
                    Text("Add a screenshot with the paper clip or Paste. It goes to the developers' board, so leave out private chats. We add the app version, your phone model, iOS and which chat you had open.")
                        .font(Typo.meta).foregroundStyle(Theme.muted)
                    if sent {
                        Label("Sent. Thanks, the developers have it.", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(Theme.ok)
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("bug-sent")
                    } else if let failure {
                        Label(failure, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.danger)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(Text(failure)) // the words, not the icon's "Warning"
                            .accessibilityIdentifier("bug-error")
                    }
                }
                .padding(Space.l)
                .animation(.spring(duration: 0.28, bounce: 0.1), value: pictures.map(\.id))
                .animation(.spring(duration: 0.28, bounce: 0.1), value: preparing)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.bg)
            .navigationTitle("Report a bug")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button(sent ? "Done" : "Cancel") { dismiss() }.toolbarText() }
                ToolbarItem(placement: .confirmationAction) { sendButton }
            }
            .photosPicker(isPresented: $showPhotos, selection: $picked, maxSelectionCount: max(1, maxPictures - pictures.count - preparing), selectionBehavior: .ordered, matching: .images)
            .onChange(of: picked) { _, items in
                guard !items.isEmpty else { return }
                picked = []
                for item in items {
                    add {
                        guard let d = try await item.loadTransferable(type: Data.self) else { throw AttachError.unreadable(String(localized: "That picture", bundle: .l10n)) }
                        return try await Attachments.picture(d, name: nil)
                    }
                }
            }
        }
    }

    /// The note in a box like the message box: the pictures above it, the paper clip at its leading edge.
    private var noteBox: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !pictures.isEmpty || preparing > 0 {
                AttachmentTray(items: pictures, preparing: preparing) { a in
                    withAnimation(.spring(duration: 0.28, bounce: 0.1)) { pictures.removeAll { $0.id == a.id } }
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            HStack(alignment: .bottom, spacing: 0) {
                attachButton
                // A text view of its own, so Paste takes pictures too (ComposerField.swift).
                ComposerField(text: $note, focused: $noteFocused,
                              placeholder: String(localized: "What you did, and what went wrong", bundle: .l10n),
                              maxLines: 8, pasteImages: pasted, identifier: "bug-note")
                    .padding(.horizontal, Composer.gap)
            }
        }
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .onChange(of: note) { _, v in if v.count > 2000 { note = String(v.prefix(2000)) } }
    }

    /// The paper clip at the note's leading edge (jxn #4116): straight to Photos, where screenshots are (Paste covers
    /// the clipboard). No Photos / Camera / Files choice as in the message box: in this sheet over the Settings drawer,
    /// neither a Menu nor a dialog anchored to the clip opened its picker.
    private var attachButton: some View {
        Button { noteFocused = false; showPhotos = true } label: {
            Image(systemName: "paperclip").font(.system(size: 15, weight: .semibold))
                .composerCircle(fill: Theme.raised)
                .foregroundStyle(Theme.muted)
        }
        .buttonStyle(PressStyle())
        .disabled(sent || pictures.count + preparing >= maxPictures)
        .accessibilityIdentifier("bug-attach")
        .accessibilityLabel("Add a picture")
    }

    /// Pictures pasted into the note: added like ones picked from Photos.
    private func pasted(_ images: [UIImage]) {
        guard !sent else { return }
        for img in images.prefix(max(0, maxPictures - pictures.count - preparing)) { add { try await Attachments.photo(img) } }
    }

    /// Prepares something picked (made to fit) and adds it to the report's pictures.
    private func add(_ make: @escaping () async throws -> Attachment) {
        preparing += 1
        Task {
            do {
                let a = try await make()
                if a.isImage { withAnimation(.spring(duration: 0.28, bounce: 0.1)) { pictures.append(a) } }
            } catch { Haptics.play(.failed); failure = error.localizedDescription }
            preparing -= 1
        }
    }

    /// Send sits in the bar's own glass like every sheet's Done (jxn #4074): a filled capsule inside it read as a pill in a pill.
    private var sendButton: some View {
        Button { Task { await send() } } label: {
            if sending { ProgressView() } else { Text("Send") }
        }
        .toolbarText(primary: true)
        .disabled(!canSend)
        .accessibilityIdentifier("bug-send")
    }

    /// The server wants words, so a report is never just a picture: the note is what makes it sendable.
    private var canSend: Bool {
        !sending && !sent && preparing == 0 && !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() async {
        noteFocused = false
        sending = true
        failure = nil
        defer { sending = false }
        var form = BugReportContext.form(note: note, pictures: BugScreenshot.parts(pictures))
        do {
            let (status, data) = try await API.shared.post("/api/bugs", body: form.finish(), contentType: form.contentType)
            if (200..<300).contains(status) {
                Haptics.play(.completed)
                sent = true
            } else if status == 404 || status == 501 {
                // The server doesn't take reports yet (no bug board set up, or an older server).
                failure = String(localized: "Bug reports aren't set up on this server yet.", bundle: .l10n)
            } else {
                let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
                failure = msg ?? String(localized: "Couldn't send the report. Try again.", bundle: .l10n)
            }
        } catch {
            failure = error.localizedDescription
        }
    }
}

extension Notification.Name {
    static let atteoShake = Notification.Name("atteoShake")
}

/// A shake anywhere posts .atteoShake (UIKit only tells the first responder's chain, so the window passes it on).
extension UIWindow {
    override open func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        if motion == .motionShake { NotificationCenter.default.post(name: .atteoShake, object: nil) }
        super.motionEnded(motion, with: event)
    }
}

/// On the app's root: a shake (while signed in) opens the report.
struct ShakeToReport: ViewModifier {
    let enabled: Bool
    @State private var draft: BugReportDraft?

    func body(content: Content) -> some View {
        content
            .onReceive(NotificationCenter.default.publisher(for: .atteoShake)) { _ in
                guard enabled, draft == nil else { return }
                draft = BugReportDraft()
            }
            .sheet(item: $draft) { _ in ReportBugView().presentationBackground(Theme.bg) }
    }
}
