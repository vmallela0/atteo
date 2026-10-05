// The chat's header (vedu #4355): the board's picture, then its name over who's working here, left-aligned after the
// back button and as wide as the room up to the buttons on the right. It used to sit centred in the bar, so it got
// twice the smaller gap (80 points on most phones) and cut the name to "Atte…" with room to spare on its left.

import SwiftUI

struct ChatHeader: View {
    let board: Board
    let title: String
    /// "theo and maya's agents working", and the same in a few words for when that doesn't fit.
    let presence: String
    let presenceShort: String
    let live: Bool
    /// The widest the header may be: the room between the back button and the buttons on the right.
    let maxWidth: CGFloat
    let open: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: open) {
            HStack(spacing: Space.s) {
                BoardPicture(board: board, size: 28).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    Text(title)
                        .font(Typo.ui(.headline))
                        .foregroundStyle(Theme.text.fixed(scheme))
                        .lineLimit(1).truncationMode(.tail)
                    HStack(spacing: 4) {
                        if board.encrypted == true { Image(systemName: "lock.fill").font(.system(size: 9)).foregroundStyle(Theme.faint.fixed(scheme)) }
                        // A plain dot, no halo: the pulsing ring read as a smudge beside the words in dark mode.
                        if live { Circle().fill(Theme.ok.fixed(scheme)).frame(width: 6, height: 6).accessibilityHidden(true) }
                        ViewThatFits(in: .horizontal) {
                            Text(presence).lineLimit(1).fixedSize()
                            Text(presenceShort).lineLimit(1)
                        }
                    }
                    .font(Typo.micro)
                    .foregroundStyle((live ? Theme.ok : Theme.faint).fixed(scheme))
                }
            }
            // A set width: a bar item is offered only what it asks for, and a flexible one collapses to its narrowest.
            .frame(width: maxWidth, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("presence")
    }
}
