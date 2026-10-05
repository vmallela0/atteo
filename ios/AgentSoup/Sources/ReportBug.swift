// Report a bug (jxn #3336; the app's side, #3337): a row near the top of Settings, and a shake anywhere. Either one takes a
// screenshot of what was on screen first (from Settings: the screen under it), then a sheet asks for a note and offers the
// screenshot as an opt-in (#3356: reports land on a board agents read, and a picture can show People only and Just mine
// messages, so it's off until you tick it and see it). The report goes to POST /api/bugs (#3341), which posts it to the
// developers' bug board; the app adds its version, the phone, iOS and the open board's id (never its messages).

import SwiftUI
import UIKit

/// The chat on screen, for the report's context (set by BoardView as it appears and leaves).
@MainActor
enum BugContext {
    static var board: String?
}

/// What the screen showed, as an image.
@MainActor
enum BugScreenshot {
    /// The key window as it is (`underSheets: false`, for a shake), or the screen under any sheets (from Settings, which
    /// is itself a sheet: the report is about what's behind it).
    static func capture(underSheets: Bool) -> UIImage? {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first else { return nil }
        let view: UIView = underSheets ? (window.rootViewController?.view ?? window) : window
        guard view.bounds.width > 0, view.bounds.height > 0 else { return nil }
        return UIGraphicsImageRenderer(bounds: view.bounds).image { _ in
            view.drawHierarchy(in: view.bounds, afterScreenUpdates: false)
        }
    }

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

    /// The whole report as multipart/form-data: the fields, then the screenshot as a JPEG file part (if included).
    @MainActor static func form(note: String, screenshot: Data?) -> Multipart {
        var m = Multipart()
        for f in fields(note: note) { m.field(f.name, f.value) }
        if let screenshot { m.file("screenshot", filename: "screenshot.jpg", mime: "image/jpeg", data: screenshot) }
        return m
    }
}

/// One report being written, with the screenshot taken as it opened (the sheet's item, so the picture travels with it).
struct BugReportDraft: Identifiable {
    let id = UUID()
    let screenshot: UIImage?
}

/// The Settings row (both faces): opens the report over Settings, with the screen under Settings as its screenshot.
struct ReportBugRow: View {
    @State private var draft: BugReportDraft?

    var body: some View {
        Section {
            Button {
                draft = BugReportDraft(screenshot: BugScreenshot.capture(underSheets: true))
            } label: {
                Label("Report a bug", systemImage: "ladybug")
                    .foregroundStyle(Theme.text)
            }
            .accessibilityIdentifier("settings-report-bug")
            // On the row itself: a .sheet on a List Section (not a real view) never presents.
            .sheet(item: $draft) { d in ReportBugView(screenshot: d.screenshot).presentationBackground(Theme.bg) }
        } footer: { Text("Tell the developers what went wrong. You can also shake your phone anywhere.") }
        .listRowBackground(Theme.card)
    }
}

/// The report: the screenshot (removable), a note, Send; the result shows inline.
struct ReportBugView: View {
    let screenshot: UIImage?
    @Environment(\.dismiss) private var dismiss
    @State private var includeShot = false // opt-in (#3356)
    @State private var note = ""
    @State private var sending = false
    @State private var sent = false
    @State private var failure: String?
    @FocusState private var noteFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.l) {
                    shotBlock
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text("What happened?").font(Typo.section).foregroundStyle(Theme.muted)
                        TextField("What you did, and what went wrong", text: $note, axis: .vertical)
                            .lineLimit(3...8)
                            .focused($noteFocused)
                            .padding(Space.m)
                            .background(Theme.card, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                            .accessibilityIdentifier("bug-note")
                            .onChange(of: note) { _, v in if v.count > 2000 { note = String(v.prefix(2000)) } }
                    }
                    Text("We add the app version, your phone model, iOS and which chat you had open.")
                        .font(Typo.meta).foregroundStyle(Theme.muted)
                    if sent {
                        Label("Sent. Thanks, the developers have it.", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(Theme.ok)
                            .accessibilityIdentifier("bug-sent")
                    } else if let failure {
                        Label(failure, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.danger)
                            .accessibilityIdentifier("bug-error")
                    }
                }
                .padding(Space.l)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.bg)
            .navigationTitle("Report a bug")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button(sent ? "Done" : "Cancel") { dismiss() }.toolbarText() }
                ToolbarItem(placement: .topBarTrailing) { sendButton }
            }
        }
    }

    /// Opt-in (#3356): reports land on a board agents read, and a picture gets past every filter that keeps People only
    /// and Just mine messages from agents. So it's off until you tick it, and you see exactly what would go.
    @ViewBuilder private var shotBlock: some View {
        if let screenshot {
            VStack(alignment: .leading, spacing: Space.s) {
                Toggle("Include screenshot", isOn: $includeShot.animation(.snappy))
                    .tint(Theme.accent)
                    .accessibilityIdentifier("bug-include-screenshot")
                if includeShot {
                    Text("It may show private messages.")
                        .font(Typo.meta).foregroundStyle(Theme.muted)
                    Image(uiImage: screenshot)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: 320)
                        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).stroke(Theme.line))
                        .frame(maxWidth: .infinity)
                        .accessibilityLabel("Screenshot")
                        .accessibilityIdentifier("bug-screenshot")
                }
            }
        }
    }

    private var sendButton: some View {
        Button { Task { await send() } } label: {
            Group {
                if sending { ProgressView().tint(Theme.onPrimary) } else { Text("Send").fontWeight(.semibold) }
            }
            .padding(.horizontal, Space.m)
            .padding(.vertical, Space.xs + 2)
            .foregroundStyle(Theme.onPrimary)
            .background(Theme.primary.opacity(canSend ? 1 : 0.4), in: Capsule())
        }
        .disabled(!canSend)
        .accessibilityIdentifier("bug-send")
    }

    /// The server wants words, so a report is never just a picture: the note is what makes it sendable.
    private var canSend: Bool {
        !sending && !sent && !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() async {
        noteFocused = false
        sending = true
        failure = nil
        defer { sending = false }
        let shot = includeShot ? screenshot.flatMap { BugScreenshot.jpeg($0) } : nil
        var form = BugReportContext.form(note: note, screenshot: shot)
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

/// On the app's root: a shake (while signed in) screenshots the screen as it is and opens the report.
struct ShakeToReport: ViewModifier {
    let enabled: Bool
    @State private var draft: BugReportDraft?

    func body(content: Content) -> some View {
        content
            .onReceive(NotificationCenter.default.publisher(for: .atteoShake)) { _ in
                guard enabled, draft == nil else { return }
                draft = BugReportDraft(screenshot: BugScreenshot.capture(underSheets: false))
            }
            .sheet(item: $draft) { d in ReportBugView(screenshot: d.screenshot).presentationBackground(Theme.bg) }
    }
}
