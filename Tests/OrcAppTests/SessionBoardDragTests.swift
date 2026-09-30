import AppKit
import XCTest
import OrcKit
@testable import OrcApp

final class SessionBoardDragTests: XCTestCase {
    private func sessions(_ count: Int = 6) throws -> [Session] {
        try (0..<count).map {
            try decode(["handle": "term_\($0)", "title": "card-\($0)", "worktreeId": "fixture",
                        "worktreePath": "/tmp/board-drag-fixture", "connected": true, "writable": true])
        }
    }
    private func frame(_ index: Int) -> CGRect {
        CGRect(x: (index % 3) * 312, y: 100 + (index / 3) * 186, width: 300, height: 174)
    }
    private func center(_ frame: CGRect) -> CGPoint { CGPoint(x: frame.midX, y: frame.midY) }
    private func targets(_ keys: [String], group: String? = nil) -> [BoardDropLocation] {
        keys.enumerated().map { index, key in
            BoardDropLocation(id: "card:" + key, groupID: group, anchor: key, frame: frame(index))
        }
    }

    func testFloatingCardPreservesGrabOffsetAndPreviewDoesNotChangeSavedBoard() throws {
        let sessions = try sessions()
        var board = SessionBoard(); board.reconcile(sessions)
        let start = CGPoint(x: 23, y: 129)
        var drag = SessionBoardDrag(session: sessions[0], board: board, frame: frame(0), start: start)
        XCTAssertEqual(drag.cardFrame, frame(0))
        let destination = CGPoint(x: 420, y: 371)
        drag.reflow(at: destination, targets: [])
        XCTAssertEqual(drag.cardFrame.minX, destination.x - 23)
        XCTAssertEqual(drag.cardFrame.minY, destination.y - 29)
        XCTAssertEqual(drag.cardFrame.size, frame(0).size)
        let moveToSecond = CGPoint(x: frame(1).midX - 150 + 23, y: frame(1).midY - 87 + 29)
        XCTAssertTrue(drag.reflow(at: moveToSecond, targets: targets(board.order)))
        XCTAssertEqual(drag.preview.order, ["card-1", "card-0", "card-2", "card-3", "card-4", "card-5"])
        XCTAssertEqual(board.order, sessions.map(\.name), "Hovering and cancellation must not persist a placement")
    }

    func testForwardBackwardAndRowMovesStayStableWhileGeometryCatchesUp() throws {
        let sessions = try sessions()
        var board = SessionBoard(); board.reconcile(sessions)
        var drag = SessionBoardDrag(session: sessions[0], board: board, frame: frame(0), start: center(frame(0)))
        let originalTargets = targets(board.order)
        XCTAssertTrue(drag.reflow(at: center(frame(1)), targets: originalTargets))
        let moved = drag.preview
        for delta in [-2.0, 0, 2] {
            let point = CGPoint(x: frame(1).midX + delta, y: frame(1).midY)
            XCTAssertFalse(drag.reflow(at: point, targets: originalTargets))
            XCTAssertEqual(drag.preview, moved)
        }
        XCTAssertTrue(drag.reflow(at: center(frame(2)), targets: targets(drag.preview.order)))
        XCTAssertEqual(Array(drag.preview.order.prefix(3)), ["card-1", "card-2", "card-0"])
        XCTAssertTrue(drag.reflow(at: center(frame(4)), targets: targets(drag.preview.order)))
        XCTAssertEqual(drag.preview.order[4], "card-0")
        XCTAssertTrue(drag.reflow(at: center(frame(0)), targets: targets(drag.preview.order)))
        XCTAssertEqual(drag.preview.order, board.order)
        XCTAssertEqual(Set(drag.preview.order).count, sessions.count)
    }

    func testMovingBetweenGroupsAndIntoAnEmptyGroupKeepsTheSameDrag() throws {
        let sessions = try sessions(3)
        var board = SessionBoard(); board.reconcile(sessions)
        let active = try XCTUnwrap(board.addGroup("Active"))
        let review = try XCTUnwrap(board.addGroup("Review"))
        board.move("card-0", to: active)
        var drag = SessionBoardDrag(session: sessions[0], board: board, frame: frame(0), start: center(frame(0)))
        let identity = drag.id
        let empty = BoardDropLocation(id: "group:" + review, groupID: review, anchor: nil,
                                      frame: CGRect(x: 0, y: 400, width: 930, height: 90))
        XCTAssertTrue(drag.reflow(at: center(empty.frame), targets: [empty]))
        XCTAssertEqual(drag.preview.cards["card-0"]?.groupID, review)
        XCTAssertEqual(drag.id, identity)
        XCTAssertTrue(drag.reflow(at: center(frame(1)), targets: targets(["card-1", "card-2"])))
        XCTAssertNil(drag.preview.cards["card-0"]?.groupID)
        XCTAssertEqual(drag.preview.sessions(in: nil, from: sessions).map(\.name), ["card-1", "card-0", "card-2"])
        XCTAssertEqual(board.cards["card-0"]?.groupID, active)
        drag.phase = .ending
        XCTAssertFalse(drag.reflow(at: center(empty.frame), targets: [empty]))
        XCTAssertNil(drag.preview.cards["card-0"]?.groupID)
    }

    @MainActor func testDropCommitsOnlyPlacementAndPreservesChangesMadeDuringDrag() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orc-drag-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("board.json")
        let organization = SessionBoardModel(file: file)
        let sessions = try sessions()
        organization.update { $0.reconcile(sessions) }
        let persisted = try Data(contentsOf: file)
        var drag = SessionBoardDrag(session: sessions[0], board: organization.board, frame: frame(0), start: center(frame(0)))
        drag.reflow(at: center(frame(2)), targets: targets(organization.board.order))
        XCTAssertEqual(try Data(contentsOf: file), persisted)
        organization.update { $0.addLabel("Added during drag", to: "card-0") }
        organization.update { drag.apply(to: &$0) }
        let saved = try SessionBoardStore.load(from: file)
        XCTAssertEqual(Array(saved.order.prefix(3)), ["card-1", "card-2", "card-0"])
        XCTAssertEqual(saved.labels(for: "card-0").map(\.name), ["Added during drag"])
    }

    @MainActor func testEdgeScrollingIsBoundedAndStopsAwayFromTheEdge() {
        let scroll = NSScrollView(frame: CGRect(x: 0, y: 0, width: 900, height: 500))
        scroll.documentView = NSView(frame: CGRect(x: 0, y: 0, width: 900, height: 1500))
        let context = BoardScrollContext(); context.scrollView = scroll
        let viewport = CGRect(x: 0, y: 60, width: 900, height: 500)
        XCTAssertFalse(context.scroll(pointer: CGPoint(x: 450, y: 300), viewport: viewport))
        XCTAssertTrue(context.scroll(pointer: CGPoint(x: 450, y: 555), viewport: viewport))
        XCTAssertGreaterThan(scroll.contentView.bounds.minY, 0)
        for _ in 0..<200 { context.scroll(pointer: CGPoint(x: 450, y: 555), viewport: viewport) }
        XCTAssertLessThanOrEqual(scroll.contentView.bounds.maxY, 1500)
        XCTAssertFalse(context.scroll(pointer: CGPoint(x: 450, y: 555), viewport: viewport))
        XCTAssertFalse(context.scroll(pointer: CGPoint(x: 950, y: 555), viewport: viewport))
        XCTAssertTrue(context.scroll(pointer: CGPoint(x: 450, y: 65), viewport: viewport))
    }
}
