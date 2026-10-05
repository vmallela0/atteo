// The chat's message box as a text view of its own, so it can take pictures as well as words: Paste (long-press, or
// ⌘V on a keyboard) with a picture on the clipboard attaches it like one picked from Photos; a picture with text on
// the clipboard attaches the picture and pastes the text. Otherwise it behaves like the multi-line field it replaces:
// grows to six lines (at most 30% of the screen), then scrolls inside itself with the caret always in view; a name
// put in for you (a mention) leaves the caret at the end.
//
// It's always a scrolling text view, sized by SwiftUI to its text up to the cap. (Switching scrolling on and off at
// the cap — what it used to do — reset the view's scroll position mid-layout: past the cap the caret sat above the
// first visible line and typing went out of sight, #833.)

import SwiftUI
import UIKit

struct ComposerField: UIViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let placeholder: String
    var maxLines: CGFloat = 6
    /// Pictures pasted in (nil: this box takes only text, and Paste behaves as usual).
    var pasteImages: (([UIImage]) -> Void)? = nil
    /// Who "@" can name here (lowercased), and you: a mention typed in sits in its blue box at once, as when sent.
    var members: Set<String> = []
    var me: String? = nil
    /// Agents named by their owners, lowercased name → owner ("jarvis" → "vedu"): "@Jarvis" is boxed too.
    var agentNames: [String: String] = [:]
    var displayName: (String) -> String = { $0 }
    var nameRevision: [String: String] = [:]
    var identifier = "composer"

    static let mentionHandle = NSAttributedString.Key("AtteoMentionHandle")

    /// Expand display runs back to addresses for drafts, sending, copying and mention matching.
    static func rawText(_ attributed: NSAttributedString) -> String {
        let result = NSMutableString(string: attributed.string)
        attributed.enumerateAttribute(mentionHandle, in: NSRange(location: 0, length: attributed.length), options: .reverse) { value, range, _ in
            if let handle = value as? String { result.replaceCharacters(in: range, with: handle) }
        }
        return result as String
    }

    final class Box: UITextView {
        var onImages: (([UIImage]) -> Void)?
        let placeholderLabel = UILabel()
        var members: Set<String> = []
        var me: String?
        var agentNames: [String: String] = [:]
        var displayName: (String) -> String = { $0 }
        var nameRevision: [String: String] = [:]
        var rawText: String { ComposerField.rawText(textStorage) }
        private(set) var isRestyling = false
        private var mentions: [(range: NSRange, mine: Bool, handle: String)] = []
        private var boxes: [UIView] = []
        private var boxesFor = "" // the text and width the boxes were placed for

        /// Colors the mentions in what's typed (and leaves what you type next plain). Not while composing
        /// (marked text from an input method): restyling then would break it.
        func restyle() {
            guard markedTextRange == nil, !isRestyling else { return }
            isRestyling = true
            defer { isRestyling = false }
            let font = Typo.composer
            let plain = rawText
            let found = ComposerField.mentions(in: plain, members: members, me: me, agentNames: agentNames).sorted { $0.range.location < $1.range.location }
            let base: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor(Theme.text)]
            let bold = Typo.composerMention(font)
            // Selection is in rendered characters; preserve its positions in the underlying draft across renames.
            let selected = selectedRange
            func rawOffset(_ offset: Int) -> Int {
                ComposerField.rawText(textStorage.attributedSubstring(from: NSRange(location: 0, length: min(offset, textStorage.length)))).utf16.count
            }
            let rawSelection = NSRange(location: rawOffset(selected.location), length: rawOffset(NSMaxRange(selected)) - rawOffset(selected.location))
            let styled = NSMutableAttributedString(string: plain, attributes: base)
            var rendered: [(range: NSRange, mine: Bool, handle: String)] = []
            var shift = 0
            for m in found {
                let address = String(m.handle.dropFirst())
                let owner = agentNames[address.lowercased()]
                let group = ["agents", "humans", "all"].contains(address.lowercased()) && !members.contains(address.lowercased())
                let label = group ? m.handle : displayName(owner.map { "\($0)'s agent" } ?? address)
                let range = NSRange(location: m.range.location + shift, length: label.utf16.count)
                styled.replaceCharacters(in: NSRange(location: range.location, length: m.range.length), with: NSAttributedString(string: label, attributes: [
                    .font: bold, .foregroundColor: UIColor(m.mine ? MentionColor.mineText : MentionColor.text), ComposerField.mentionHandle: m.handle,
                ]))
                rendered.append((range, m.mine, m.handle))
                shift += range.length - m.range.length
            }
            func renderedOffset(_ offset: Int) -> Int {
                var shift = 0
                for (raw, shown) in zip(found, rendered) {
                    if offset <= raw.range.location { break }
                    if offset < NSMaxRange(raw.range) { return shown.range.location }
                    shift += shown.range.length - raw.range.length
                }
                return offset + shift
            }
            textStorage.setAttributedString(styled)
            selectedRange = NSRange(location: renderedOffset(rawSelection.location), length: renderedOffset(NSMaxRange(rawSelection)) - renderedOffset(rawSelection.location))
            typingAttributes = base
            mentions = rendered
            boxesFor = ""
            setNeedsLayout()
        }

        /// A rounded box behind each mention (one per line it spans), in the text's own coordinates so they scroll
        /// with it; placed again only when the text or the width changes.
        private func placeBoxes() {
            let key = "\(text ?? "")|\(bounds.width)"
            guard key != boxesFor else { return }
            boxesFor = key
            boxes.forEach { $0.removeFromSuperview() }
            boxes = []
            for m in mentions {
                guard let start = position(from: beginningOfDocument, offset: m.range.location),
                      let end = position(from: start, offset: m.range.length), let r = textRange(from: start, to: end) else { continue }
                for sr in selectionRects(for: r) where sr.rect.width > 0 && sr.rect.origin.x.isFinite {
                    let v = UIView(frame: sr.rect.insetBy(dx: -3, dy: 0))
                    v.backgroundColor = UIColor(m.mine ? MentionColor.mineBox : MentionColor.box)
                    v.layer.cornerRadius = 5
                    v.layer.cornerCurve = .continuous
                    v.isUserInteractionEnabled = false
                    v.isAccessibilityElement = true
                    let name = (text as NSString).substring(with: m.range)
                    v.accessibilityLabel = String(localized: "mention, \(name)", bundle: .l10n)
                    v.accessibilityIdentifier = "composer-mention"
                    insertSubview(v, at: 0) // behind the text
                    boxes.append(v)
                }
            }
        }

        /// The mentions in the box now, each one unit (MentionTokens): fresh from the text, so they're right even
        /// mid-edit, before restyle has run.
        func tokenRanges() -> [NSRange] {
            var ranges: [NSRange] = []
            textStorage.enumerateAttribute(ComposerField.mentionHandle, in: NSRange(location: 0, length: textStorage.length)) { value, range, _ in
                if value != nil { ranges.append(range) }
            }
            return ranges
        }

        override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
            // A picture on the clipboard (checking doesn't read it): offer Paste even with no text there.
            if action == #selector(paste(_:)), onImages != nil, UIPasteboard.general.hasImages { return true }
            return super.canPerformAction(action, withSender: sender)
        }

        override func copy(_ sender: Any?) {
            guard selectedRange.length > 0 else { return }
            UIPasteboard.general.string = ComposerField.rawText(textStorage.attributedSubstring(from: selectedRange))
        }

        override func cut(_ sender: Any?) {
            copy(sender)
            if selectedRange.length > 0 { insertText("") }
        }

        override func paste(_ sender: Any?) {
            let pb = UIPasteboard.general
            guard let onImages, pb.hasImages, let images = pb.images, !images.isEmpty else { return super.paste(sender) }
            onImages(images)
            // A picture and words together (copied from a page, a note): the words go in the box too.
            if pb.hasStrings, let s = pb.string, !s.isEmpty { insertText(s) }
        }

        private var lastHeight: CGFloat = 0

        override func layoutSubviews() {
            super.layoutSubviews()
            placeholderLabel.frame = CGRect(x: textContainerInset.left + textContainer.lineFragmentPadding, y: textContainerInset.top,
                                            width: bounds.width - textContainerInset.left - textContainerInset.right, height: font?.lineHeight ?? 20)
            // The box changed height (it grew a line, or reached its cap): all of it fits → from the top; otherwise
            // keep the caret in view. (Scrolling yourself doesn't change the height, so it doesn't fight you.)
            if abs(bounds.height - lastHeight) > 0.5 {
                lastHeight = bounds.height
                if contentSize.height <= bounds.height + 0.5 { if contentOffset.y != 0 { contentOffset = .zero } } else { showCaret() }
            }
            placeBoxes()
        }

        /// Scrolls just enough that the caret (and a little room under it) is visible.
        func showCaret() {
            guard contentSize.height > bounds.height + 0.5, let end = selectedTextRange?.end else { return }
            let caret = caretRect(for: end)
            guard caret.origin.y.isFinite else { return }
            scrollRectToVisible(caret.insetBy(dx: 0, dy: -textContainerInset.bottom), animated: false)
        }
    }

    func makeUIView(context: Context) -> Box {
        let v = Box()
        v.delegate = context.coordinator
        v.backgroundColor = .clear
        v.font = Typo.composer
        v.adjustsFontForContentSizeCategory = true
        v.textColor = UIColor(Theme.text)
        v.tintColor = UIColor(Theme.accent)
        v.textContainerInset = Self.insets(for: v.font)
        v.textContainer.lineFragmentPadding = 0
        v.isScrollEnabled = true // always (see the note at the top)
        v.alwaysBounceVertical = false
        v.keyboardAppearance = .default // follows light / dark
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        v.accessibilityIdentifier = identifier
        v.placeholderLabel.font = v.font
        v.placeholderLabel.adjustsFontForContentSizeCategory = true
        v.placeholderLabel.textColor = UIColor(Theme.faint)
        v.placeholderLabel.isAccessibilityElement = false
        v.addSubview(v.placeholderLabel)
        return v
    }

    func updateUIView(_ v: Box, context: Context) {
        context.coordinator.parent = self
        v.onImages = pasteImages
        v.displayName = displayName
        if v.members != members || v.me != me || v.agentNames != agentNames || v.nameRevision != nameRevision {
            v.members = members; v.me = me; v.agentNames = agentNames; v.nameRevision = nameRevision; v.restyle()
        }
        v.placeholderLabel.text = placeholder
        v.accessibilityLabel = placeholder
        if v.rawText != text {
            // Put in from outside (a mention picked, a send): the caret goes to the end.
            v.attributedText = NSAttributedString(string: text, attributes: [.font: Typo.composer, .foregroundColor: UIColor(Theme.text)])
            v.selectedRange = NSRange(location: (text as NSString).length, length: 0)
            v.restyle()
            v.invalidateIntrinsicContentSize()
            DispatchQueue.main.async { v.showCaret() }
        }
        v.placeholderLabel.isHidden = !text.isEmpty
        if focused && !v.isFirstResponder { DispatchQueue.main.async { if v.window != nil { v.becomeFirstResponder() } } }
        if !focused && v.isFirstResponder { DispatchQueue.main.async { v.resignFirstResponder() } }
    }

    /// The mentions in a draft, as the web's composer highlights them: "@theo", "@theo's agent", "@theo/scout" for
    /// someone here, and "@agents" / "@humans". Yours (you, your agent) marked mine.
    static func mentions(in text: String, members: Set<String>, me: String?, agentNames: [String: String] = [:]) -> [(range: NSRange, mine: Bool, handle: String)] {
        guard text.contains("@") else { return [] }
        let ns = text as NSString
        var out: [(NSRange, Bool, String)] = agentNameMentions(in: text, names: agentNames, members: members).map { ($0.range, $0.owner == me?.lowercased(), ns.substring(with: $0.range)) }
        let taken = out.map(\.0)
        for m in draftRE.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let handle = ns.substring(with: m.range(at: 2)).lowercased()
            let suffix = m.range(at: 3).location == NSNotFound ? nil : ns.substring(with: m.range(at: 3))
            let at = m.range(at: 2).location - 1
            if taken.contains(where: { $0.location == at }) { continue } // already an agent's name
            if (handle == "agents" || handle == "humans" || handle == "all") && suffix == nil && !members.contains(handle) {
                out.append((NSRange(location: at, length: 1 + m.range(at: 2).length), false, "@" + handle))
                continue
            }
            let user = members.contains(handle) ? handle : handle.replacingOccurrences(of: "[.-]+$", with: "", options: .regularExpression)
            guard members.contains(user) else { continue }
            if suffix == nil || user != handle, user == me?.lowercased() { continue } // you can't mention yourself, only your agent (the web's rule)
            let length = 1 + (suffix != nil && user == handle ? m.range(at: 2).length + m.range(at: 3).length : (user as NSString).length)
            let r = NSRange(location: at, length: length)
            out.append((r, user == me?.lowercased(), ns.substring(with: r)))
        }
        return out
    }
    private static let draftRE = try! NSRegularExpression(
        pattern: "(^|[^A-Za-z0-9_.@/-])@([A-Za-z0-9][A-Za-z0-9_.-]{0,31})((?:'|’)s\\s+(?:agent|assistant)\\b|/[A-Za-z0-9][A-Za-z0-9_.-]{0,31})?",
        options: [.caseInsensitive])

    /// Top and bottom room so one line of text is exactly as tall as the buttons beside it (and centred on them).
    static func insets(for font: UIFont?) -> UIEdgeInsets {
        let line = font?.lineHeight ?? 20
        let pad = max(4, ((Composer.line - line) / 2).rounded(.down))
        return UIEdgeInsets(top: pad, left: 0, bottom: pad, right: 0)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView v: Box, context: Context) -> CGSize? {
        if v.textContainerInset != Self.insets(for: v.font) { v.textContainerInset = Self.insets(for: v.font) }
        let width = proposal.width ?? 280
        let fit = v.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let line = v.font?.lineHeight ?? 20
        let screen = v.window?.windowScene?.screen.bounds.height ?? 800
        let most = min(ceil(line * maxLines + v.textContainerInset.top + v.textContainerInset.bottom), (screen * 0.3).rounded(.down))
        return CGSize(width: width, height: max(Composer.line, min(fit.height, most)))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerField
        init(_ p: ComposerField) { parent = p }
        private var lastSelection: NSRange?
        private var adjusting = false // our own edit or selection change, not the person's

        /// A mention is one unit (jxn #2551, the web's chips): an edit that cuts into one takes all of it, so one
        /// Backspace at its end removes "@jxn's agent" whole. Done as the same edit over the grown range, so undo,
        /// the drafts and the send button follow as usual. Not while composing (marked text from an input method).
        func textView(_ v: UITextView, shouldChangeTextIn range: NSRange, replacementText t: String) -> Bool {
            guard !adjusting, v.markedTextRange == nil, let box = v as? Box else { return true }
            let tokens = box.tokenRanges()
            let grown = MentionTokens.expand(range, tokens: tokens)
            guard grown != range else { return true }
            // A replacement wholly inside a mention can only be the keyboard's (autocorrect fixing "jxn" in "@jxn"; the
            // caret never rests inside one): growing it would drop the "@", so the mention is left as it is.
            if !t.isEmpty, tokens.contains(where: { NSIntersectionRange($0, range).length == range.length && $0 != range }) { return false }
            adjusting = true
            defer { adjusting = false }
            v.selectedRange = grown
            if t.isEmpty { v.deleteBackward() } else { v.insertText(t) }
            lastSelection = v.selectedRange
            return false
        }

        /// The caret never rests inside a mention (it steps over it, or goes to the nearer edge), and a selection that
        /// cuts into one covers it.
        func textViewDidChangeSelection(_ v: UITextView) {
            defer { lastSelection = v.selectedRange; v.typingAttributes.removeValue(forKey: ComposerField.mentionHandle) }
            guard !adjusting, v.markedTextRange == nil, let box = v as? Box, !box.isRestyling else { return }
            let sel = v.selectedRange
            let snapped = MentionTokens.snap(sel, previous: lastSelection, tokens: box.tokenRanges())
            guard snapped != sel else { return }
            adjusting = true
            v.selectedRange = snapped
            adjusting = false
        }
        func textViewDidChange(_ v: UITextView) {
            guard (v as? Box)?.isRestyling != true else { return }
            (v as? Box)?.restyle()
            parent.text = (v as? Box)?.rawText ?? v.text
            (v as? Box)?.placeholderLabel.isHidden = !v.text.isEmpty
            v.invalidateIntrinsicContentSize()
            // Past its full height it scrolls inside itself: keep the caret (what you're typing) in view, once the
            // new layout is in.
            DispatchQueue.main.async { (v as? Box)?.showCaret() }
        }
        func textViewDidBeginEditing(_ v: UITextView) { if !parent.focused { parent.focused = true } }
        func textViewDidEndEditing(_ v: UITextView) { if parent.focused { parent.focused = false } }
    }
}
