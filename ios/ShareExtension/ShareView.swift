// The share sheet's Atteo page: what you're sending, a note, and where to (recent first, with search). The app's look
// (Theme.swift, board #2508): paper and ink, bone surfaces, Onest and Enriqueta; oxblood only on Send.

import SwiftUI

private enum Look {
    static func c(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) })
    }
    static func rgb(_ hex: UInt32) -> UIColor {
        UIColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
    }
    static let bg = c(0xFAFAF7, 0x0E0E0E)
    static let card = c(0xF2EFE8, 0x171716)
    static let line = c(0xE4E1D9, 0x2A2926)
    static let text = c(0x161614, 0xEDEBE5)
    static let muted = c(0x5A5853, 0xAFADA6)
    static let primary = c(0x6A1B24, 0x9D333C) // oxblood: Send only
    static func onest(_ size: CGFloat, _ face: String = "Onest-Regular", _ style: Font.TextStyle = .body) -> Font { .custom(face, size: size, relativeTo: style) }
    static let title = Font.custom("Enriqueta-SemiBold", size: 17, relativeTo: .headline)
}

struct ShareView: View {
    @ObservedObject var model: ShareModel
    @FocusState private var noteFocused: Bool

    var body: some View {
        NavigationStack {
            content
                .background(Look.bg)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) { Text("Send to Atteo").font(Look.title).foregroundStyle(Look.text) }
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { model.cancel() }.font(Look.onest(17)).tint(Look.text)
                    }
                    if model.phase != .signedOut {
                        ToolbarItem(placement: .confirmationAction) {
                            Button { model.send() } label: {
                                if model.phase == .sending { ProgressView() } else { Text("Send") }
                            }
                            .font(Look.onest(17, "Onest-SemiBold"))
                            .tint(Look.primary)
                            .disabled(!model.canSend)
                            .accessibilityIdentifier("share-send")
                        }
                    }
                }
        }
        .tint(Look.text)
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .signedOut:
            VStack(spacing: 10) {
                Image(systemName: "person.crop.circle.badge.questionmark").font(.system(size: 40)).foregroundStyle(Look.muted)
                Text("Open Atteo to sign in").font(Look.onest(17, "Onest-SemiBold")).foregroundStyle(Look.text)
                Text("Then share again: it sends as you.").font(Look.onest(15)).foregroundStyle(Look.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("share-signed-out")
        case .sent:
            VStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 40)).foregroundStyle(Look.text)
                Text("Sent").font(Look.onest(17, "Onest-SemiBold")).foregroundStyle(Look.text)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("share-sent")
        default:
            form
        }
    }

    private var form: some View {
        List {
            Section {
                preview
                TextField("Add a note", text: $model.note, axis: .vertical)
                    .font(Look.onest(17)).foregroundStyle(Look.text)
                    .lineLimit(1...5)
                    .focused($noteFocused)
                    .accessibilityIdentifier("share-note")
                if let p = model.problem { Text(p).font(Look.onest(13)).foregroundStyle(Look.muted) }
                if case .failed(let why) = model.phase {
                    HStack {
                        Text(why).font(Look.onest(13)).foregroundStyle(Look.text)
                        Spacer()
                        Button("Try again") { model.retry(); model.send() }.font(Look.onest(13, "Onest-SemiBold"))
                    }
                    .accessibilityIdentifier("share-error")
                }
            }
            .listRowBackground(Look.card)

            Section {
                ForEach(model.shown) { b in
                    Button { model.selected = b.id; noteFocused = false } label: {
                        HStack(spacing: 12) {
                            Image(systemName: b.kind == "direct" ? "person.fill" : "number")
                                .font(.system(size: 13, weight: .semibold)).foregroundStyle(Look.muted).frame(width: 20)
                            Text(ShareCore.displayName(b, me: model.me)).font(Look.onest(16, "Onest-Medium")).foregroundStyle(Look.text).lineLimit(1)
                            Spacer()
                            if model.selected == b.id { Image(systemName: "checkmark").font(.system(size: 15, weight: .semibold)).foregroundStyle(Look.text) }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(model.selected == b.id ? .isSelected : [])
                    .accessibilityIdentifier("share-board-\(b.id)")
                }
                if model.shown.isEmpty {
                    Text(model.boards.isEmpty ? "No chats yet." : "No chat matches.").font(Look.onest(15)).foregroundStyle(Look.muted)
                }
            } header: {
                Text("To").font(Look.onest(13, "Onest-SemiBold", .footnote)).foregroundStyle(Look.muted).textCase(nil)
            }
            .listRowBackground(Look.card)
        }
        .scrollContentBackground(.hidden)
        .searchable(text: $model.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search chats")
    }

    @ViewBuilder private var preview: some View {
        let files: [(String, String)] = model.payloads.compactMap { if case .file(let n, let m, _, _, _) = $0, !m.hasPrefix("image/") { return (n, m) } else { return nil } }
        let words: [String] = model.payloads.compactMap { if case .text(let t) = $0 { return t } else { return nil } }
        if !model.previews.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(model.previews.enumerated()), id: \.offset) { _, img in
                        Image(uiImage: img).resizable().scaledToFill().frame(width: 72, height: 72)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Look.line))
                    }
                }
            }
            .accessibilityIdentifier("share-pictures")
        }
        ForEach(Array(files.enumerated()), id: \.offset) { _, f in
            Label { Text(f.0).font(Look.onest(15)).foregroundStyle(Look.text).lineLimit(1) } icon: {
                Image(systemName: "doc").foregroundStyle(Look.muted)
            }
        }
        ForEach(Array(words.enumerated()), id: \.offset) { _, t in
            Text(t).font(Look.onest(15)).foregroundStyle(Look.muted).lineLimit(3)
        }
    }
}
