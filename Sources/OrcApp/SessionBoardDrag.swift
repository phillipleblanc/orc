import AppKit
import SwiftUI
import OrcKit

struct BoardDropLocation: Equatable {
    let id: String
    let groupID: String?
    let anchor: String?
    let frame: CGRect
}

/// A drag edits a private layout until it is dropped. Pointer coordinates stay in the board's viewport.
struct SessionBoardDrag {
    enum Phase { case dragging, ending, settling }
    let id = UUID()
    let session: Session
    let size: CGSize
    let grabOffset: CGSize
    let sectionHeights: [String: CGFloat]
    private(set) var preview: SessionBoard
    var location: CGPoint
    var phase = Phase.dragging
    var landingFrame: CGRect?
    private var occupiedSlot: CGRect?

    init(session: Session, board: SessionBoard, frame: CGRect, start: CGPoint,
         sectionHeights: [String: CGFloat] = [:]) {
        self.session = session
        preview = board
        size = frame.size
        grabOffset = CGSize(width: start.x - frame.minX, height: start.y - frame.minY)
        location = start
        self.sectionHeights = sectionHeights
    }

    var key: String { session.notesKey }
    var cardFrame: CGRect {
        landingFrame ?? CGRect(x: location.x - grabOffset.width, y: location.y - grabOffset.height,
                               width: size.width, height: size.height)
    }

    @discardableResult mutating func reflow(at point: CGPoint, targets: [BoardDropLocation]) -> Bool {
        guard phase == .dragging else { return false }
        location = point
        let center = CGPoint(x: cardFrame.midX, y: cardFrame.midY)
        // Hold the occupied cell while its neighbors animate, even if their geometry is still in flight.
        if let occupiedSlot, occupiedSlot.insetBy(dx: -6, dy: -6).contains(center) { return false }
        occupiedSlot = nil
        if targets.contains(where: { $0.anchor == key && $0.frame.contains(center) }) { return false }
        let cards = targets.filter { $0.anchor != nil && $0.anchor != key }
        let target = cards.first { $0.frame.insetBy(dx: $0.frame.width * 0.18, dy: $0.frame.height * 0.12).contains(center) }
            ?? targets.first { $0.id.hasPrefix("group:") && $0.frame.contains(center) }
        guard let target else { return false }
        var anchor = target.anchor
        if let targetKey = target.anchor, preview.cards[key]?.groupID == target.groupID {
            let order = preview.order.filter { preview.cards[$0]?.groupID == target.groupID }
            if let from = order.firstIndex(of: key), let to = order.firstIndex(of: targetKey), from < to {
                anchor = order.dropFirst(to + 1).first
            }
        }
        let before = preview
        preview.move(key, to: target.groupID, before: anchor)
        guard before != preview else { return false }
        occupiedSlot = target.frame
        return true
    }

    /// Apply only the placement so refreshes and label edits made during the drag are preserved.
    func apply(to board: inout SessionBoard) {
        guard let card = preview.cards[key], let index = preview.order.firstIndex(of: key) else { return }
        let anchor = preview.order.dropFirst(index + 1).first {
            preview.cards[$0]?.groupID == card.groupID && board.cards[$0]?.groupID == card.groupID && board.cards[$0] != nil
        }
        board.move(key, to: card.groupID, before: anchor)
    }
}

@MainActor final class BoardScrollContext {
    weak var scrollView: NSScrollView?

    @discardableResult func scroll(pointer: CGPoint, viewport: CGRect) -> Bool {
        guard let scrollView, let document = scrollView.documentView,
              pointer.x >= viewport.minX, pointer.x <= viewport.maxX else { return false }
        let edge: CGFloat = 48
        let direction: CGFloat
        if pointer.y < viewport.minY + edge { direction = -min(1, (viewport.minY + edge - pointer.y) / edge) }
        else if pointer.y > viewport.maxY - edge { direction = min(1, (pointer.y - viewport.maxY + edge) / edge) }
        else { return false }
        let clip = scrollView.contentView
        var point = clip.bounds.origin
        let maximum = max(document.bounds.minY, document.bounds.maxY - clip.bounds.height)
        point.y = min(maximum, max(document.bounds.minY, point.y + direction * 12))
        guard abs(point.y - clip.bounds.minY) > 0.1 else { return false }
        clip.scroll(to: point)
        scrollView.reflectScrolledClipView(clip)
        return true
    }
}

struct BoardScrollProbe: NSViewRepresentable {
    let scroll: BoardScrollContext
    func makeNSView(context: Context) -> Probe { Probe(scroll: scroll) }
    func updateNSView(_ view: Probe, context: Context) {}
    final class Probe: NSView {
        let scroll: BoardScrollContext
        init(scroll: BoardScrollContext) { self.scroll = scroll; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                scroll.scrollView = enclosingScrollView
            }
        }
    }
}
