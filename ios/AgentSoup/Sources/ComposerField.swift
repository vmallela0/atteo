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

    final class Box: UITextView {
        var onImages: (([UIImage]) -> Void)?
        let placeholderLabel = UILabel()

        override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
            // A picture on the clipboard (checking doesn't read it): offer Paste even with no text there.
            if action == #selector(paste(_:)), onImages != nil, UIPasteboard.general.hasImages { return true }
            return super.canPerformAction(action, withSender: sender)
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
        v.font = .preferredFont(forTextStyle: .callout)
        v.adjustsFontForContentSizeCategory = true
        v.textColor = UIColor(Theme.text)
        v.tintColor = UIColor(Theme.accent)
        v.textContainerInset = Self.insets(for: v.font)
        v.textContainer.lineFragmentPadding = 0
        v.isScrollEnabled = true // always (see the note at the top)
        v.alwaysBounceVertical = false
        v.keyboardAppearance = .default // follows light / dark
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        v.accessibilityIdentifier = "composer"
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
        v.placeholderLabel.text = placeholder
        v.accessibilityLabel = placeholder
        if v.text != text {
            // Put in from outside (a mention picked, a send): the caret goes to the end.
            v.text = text
            v.selectedRange = NSRange(location: (text as NSString).length, length: 0)
            v.invalidateIntrinsicContentSize()
            DispatchQueue.main.async { v.showCaret() }
        }
        v.placeholderLabel.isHidden = !text.isEmpty
        if focused && !v.isFirstResponder { DispatchQueue.main.async { if v.window != nil { v.becomeFirstResponder() } } }
        if !focused && v.isFirstResponder { DispatchQueue.main.async { v.resignFirstResponder() } }
    }

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
        func textViewDidChange(_ v: UITextView) {
            parent.text = v.text
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
