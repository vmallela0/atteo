// Saving what's in a chat to this phone (jxn #2684, #2686: "on iPhone I have to save to Files first, I can't just
// save to images"). A picture goes straight into Photos (the add-only permission, asked the first time, never read
// access), any file goes to Files, and Share… opens the share sheet. The bytes are the message's own (MediaStore), so
// a GIF stays a GIF and a PNG keeps its transparency; on an encrypted board they're the copy this phone decrypted.

import Photos
import SwiftUI
import UIKit

@MainActor
enum SaveMedia {
    enum Outcome: Equatable { case saved, denied, failed }

    /// Adds pictures to Photos, asking for the add-only permission if it hasn't been asked yet.
    static func toPhotos(_ files: [URL]) async -> Outcome {
        guard !files.isEmpty else { return .failed }
        var status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        if status == .notDetermined { status = await PHPhotoLibrary.requestAuthorization(for: .addOnly) }
        guard status == .authorized || status == .limited else { return .denied }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                for file in files {
                    let options = PHAssetResourceCreationOptions()
                    options.originalFilename = file.lastPathComponent
                    PHAssetCreationRequest.forAsset().addResource(with: .photo, fileURL: file, options: options)
                }
            }
            return .saved
        } catch {
            return .failed
        }
    }

    /// Saves pictures to Photos and says how it went: a toast, or what to do when Photos access is off.
    static func savePictures(_ files: [URL]) async {
        switch await toPhotos(files) {
        case .saved:
            Haptics.play(.copied)
            AppState.shared.say(files.count == 1
                ? String(localized: "Saved to Photos", bundle: .l10n)
                : String(localized: "Saved \(files.count) pictures to Photos", bundle: .l10n))
        case .denied:
            Haptics.play(.failed)
            deniedAlert()
        case .failed:
            Haptics.play(.failed)
            AppState.shared.say(String(localized: "Couldn't save to Photos", bundle: .l10n))
        }
    }

    /// The share sheet for these files (it has Save to Files, AirDrop, Messages…).
    static func share(_ files: [URL]) {
        guard !files.isEmpty else { return }
        present(UIActivityViewController(activityItems: files, applicationActivities: nil))
    }

    /// Files' own "Save to…" picker: a copy goes wherever you choose.
    static func toFiles(_ files: [URL]) {
        guard !files.isEmpty else { return }
        present(UIDocumentPickerViewController(forExporting: files, asCopy: true))
    }

    /// The message's files on this phone (downloaded once, then kept): a single file, or each file of several.
    static func files(of e: Entry, board: String, images: Bool?) async -> [URL] {
        let refs: [Entry]
        if let all = e.attachments, all.count > 1 {
            refs = all.filter { images == nil || $0.isImage == images }.map { $0.entry(of: e) }
        } else {
            refs = [e]
        }
        var out: [URL] = []
        for r in refs {
            do { out.append(try await MediaStore.shared.file(for: r, board: board)) } catch { AppState.shared.report(error) }
        }
        return out
    }

    private static func deniedAlert() {
        let a = UIAlertController(
            title: String(localized: "Atteo can't add to Photos", bundle: .l10n),
            message: String(localized: "Turn on Photos for Atteo in Settings to save pictures.", bundle: .l10n),
            preferredStyle: .alert)
        a.addAction(UIAlertAction(title: String(localized: "Cancel", bundle: .l10n), style: .cancel))
        a.addAction(UIAlertAction(title: String(localized: "Open Settings", bundle: .l10n), style: .default) { _ in
            if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) }
        })
        present(a)
    }

    /// Presents over whatever is on screen now (a chat, a sheet, the full-screen picture viewer).
    private static func present(_ vc: UIViewController) {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first,
              var top = scene.keyWindow?.rootViewController ?? scene.windows.first?.rootViewController else { return }
        while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
        if let pop = vc.popoverPresentationController { // iPad: from the middle of the screen
            pop.sourceView = top.view
            pop.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 0, height: 0)
            pop.permittedArrowDirections = []
        }
        top.present(vc, animated: true)
    }
}

/// The long-press menu's save items for a message with a picture or a file (EntryRow's menu).
struct SaveMediaMenuItems: View {
    let e: Entry
    let board: String

    private var pictures: Int {
        if let all = e.attachments, all.count > 1 { return all.filter(\.isImage).count }
        return e.isImage ? 1 : 0
    }
    private var otherFiles: Int {
        if let all = e.attachments, all.count > 1 { return all.filter { !$0.isImage }.count }
        return e.artifactName != nil && !e.isImage ? 1 : 0
    }

    var body: some View {
        if pictures > 0 {
            Button(pictures == 1 ? String(localized: "Save to Photos", bundle: .l10n) : String(localized: "Save \(pictures) pictures to Photos", bundle: .l10n),
                   systemImage: "square.and.arrow.down") {
                Task { await SaveMedia.savePictures(await SaveMedia.files(of: e, board: board, images: true)) }
            }
            .accessibilityIdentifier("save-to-photos")
        }
        if otherFiles > 0 {
            Button("Save to Files", systemImage: "folder") {
                Task { SaveMedia.toFiles(await SaveMedia.files(of: e, board: board, images: false)) }
            }
            .accessibilityIdentifier("save-to-files")
        }
        if pictures + otherFiles > 0 {
            Button("Share…", systemImage: "square.and.arrow.up") {
                Task { SaveMedia.share(await SaveMedia.files(of: e, board: board, images: nil)) }
            }
            .accessibilityIdentifier("share-media")
        }
    }
}

/// The viewer's round "Save to Photos" button (white on dark, like its Share and ✕).
struct SaveToPhotosButton: View {
    let file: URL?
    @State private var saving = false

    var body: some View {
        Button {
            guard let file, !saving else { return }
            saving = true
            Task { await SaveMedia.savePictures([file]); saving = false }
        } label: {
            ZStack {
                if saving { ProgressView().tint(.white) } else {
                    Image(systemName: "square.and.arrow.down").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                }
            }
            .frame(width: 36, height: 36).background(Color.white.opacity(0.14), in: Circle())
            .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .disabled(file == nil)
        .opacity(file == nil ? 0.4 : 1)
        .accessibilityLabel("Save to Photos")
        .accessibilityIdentifier("viewer-save-photos")
    }
}
