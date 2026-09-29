import XCTest
@testable import OrcKit

final class SessionSidebarOrderTests: XCTestCase {
    private func session(_ handle: String, name: String? = nil, pane: String? = nil) -> Session {
        var session = Session(handle: handle, title: name ?? handle, worktreeId: "project", worktreePath: "/code/project",
                              connected: true, writable: true, agentIdentity: "pi", incarnationId: handle)
        session.tabId = pane
        session.leafId = pane.map { _ in "leaf" }
        return session
    }

    private var hierarchy: SessionHierarchy {
        SessionHierarchy(sessions: [session("a"), session("a-one"), session("a-two"),
                                    session("b"), session("b-one"), session("c")])
    }

    func testDefaultOrderAndRootMovesInBothDirectionsKeepChildrenTogether() {
        var order = SessionSidebarOrder()
        XCTAssertEqual(order.rows(in: hierarchy).map(\.id), ["a", "a-one", "a-two", "b", "b-one", "c"])
        order.move(fromOffsets: [5], toOffset: 0, rows: order.rows(in: hierarchy))
        XCTAssertEqual(order.rows(in: hierarchy).map(\.id), ["c", "a", "a-one", "a-two", "b", "b-one"])
        order.move(fromOffsets: [1], toOffset: 6, rows: order.rows(in: hierarchy))
        XCTAssertEqual(order.rows(in: hierarchy).map(\.id), ["c", "b", "b-one", "a", "a-one", "a-two"])
        order.move(fromOffsets: [0], toOffset: 3, rows: order.rows(in: hierarchy))
        XCTAssertEqual(order.rows(in: hierarchy).map(\.id), ["b", "b-one", "c", "a", "a-one", "a-two"])
    }

    func testChildMovesStayWithinParentAndDoNotChangeRootOrder() {
        var order = SessionSidebarOrder()
        order.move(fromOffsets: [1], toOffset: 3, rows: order.rows(in: hierarchy))
        XCTAssertEqual(order.rows(in: hierarchy).map(\.id), ["a", "a-two", "a-one", "b", "b-one", "c"])
        order.move(fromOffsets: [2], toOffset: 1, rows: order.rows(in: hierarchy))
        XCTAssertEqual(order.rows(in: hierarchy).map(\.id), ["a", "a-one", "a-two", "b", "b-one", "c"])
        let before = order
        for destination in [0, 4, 5, 6] {
            order.move(fromOffsets: [1], toOffset: destination, rows: order.rows(in: hierarchy))
            XCTAssertEqual(order, before, "Moving a child must not change its parent")
        }
        order.move(fromOffsets: [5], toOffset: 2, rows: order.rows(in: hierarchy))
        XCTAssertEqual(order, before, "A root cannot split another parent's children")
    }

    func testCollapsedParentMovesWithHiddenChildrenAndPreservesTheirOrder() {
        var order = SessionSidebarOrder()
        order.move("a-two", by: -1, rows: order.rows(in: hierarchy))
        let collapsed = order.rows(in: hierarchy, collapsed: ["a", "b"])
        XCTAssertEqual(collapsed.map(\.id), ["a", "b", "c"])
        XCTAssertTrue(collapsed[0].hasChildren)
        order.move(fromOffsets: [0], toOffset: 3, rows: collapsed)
        XCTAssertEqual(order.rows(in: hierarchy).map(\.id), ["b", "b-one", "c", "a", "a-two", "a-one"])
        XCTAssertEqual(order.rows(in: hierarchy, collapsed: ["a"]).map(\.id), ["b", "b-one", "c", "a"])
    }

    func testMenuMovesAndBounds() {
        var order = SessionSidebarOrder()
        XCTAssertFalse(order.canMove("a", by: -1, rows: order.rows(in: hierarchy)))
        XCTAssertFalse(order.canMove("c", by: 1, rows: order.rows(in: hierarchy)))
        XCTAssertFalse(order.canMove("missing", by: 1, rows: order.rows(in: hierarchy)))
        order.move("a", by: 1, rows: order.rows(in: hierarchy))
        XCTAssertEqual(order.rows(in: hierarchy).map(\.id), ["b", "b-one", "a", "a-one", "a-two", "c"])
        order.move("a", by: -1, rows: order.rows(in: hierarchy))
        order.move("a-one", by: 1, rows: order.rows(in: hierarchy))
        XCTAssertEqual(order.rows(in: hierarchy).map(\.id), ["a", "a-two", "a-one", "b", "b-one", "c"])
        let before = order
        order.move("a", by: -1, rows: order.rows(in: hierarchy))
        order.move("a-one", by: 1, rows: order.rows(in: hierarchy))
        order.move("missing", by: 1, rows: order.rows(in: hierarchy))
        order.move("a", by: 2, rows: order.rows(in: hierarchy))
        XCTAssertEqual(order, before)
    }

    func testInvalidAndNoOpDropsDoNotCreateSavedOrder() {
        var order = SessionSidebarOrder()
        let rows = order.rows(in: hierarchy)
        for (source, destination): (IndexSet, Int) in [([], 0), ([0, 3], 6), ([6], 0), ([0], -1), ([0], 7),
                                                       ([0], 0), ([0], 3), ([1], 1), ([1], 2), ([5], 6)] {
            order.move(fromOffsets: source, toOffset: destination, rows: rows)
            XCTAssertEqual(order, SessionSidebarOrder())
        }
    }

    func testSavedOrderSurvivesRefreshRenameHandleChangeAndMissingPanes() {
        let a = session("old-a", name: "Alpha", pane: "stable-a")
        let b = session("old-b", name: "Beta", pane: "stable-b")
        let c = session("c")
        var order = SessionSidebarOrder()
        order.move(fromOffsets: [1], toOffset: 0, rows: order.rows(in: SessionHierarchy(sessions: [a, b, c])))
        let saved = order
        XCTAssertTrue(order.rows(in: SessionHierarchy(sessions: [])).isEmpty)
        XCTAssertEqual(order.rows(in: SessionHierarchy(sessions: [c, a])).map(\.id), ["old-a", "c"])
        let renamed = session("new-b", name: "Renamed", pane: "stable-b")
        let new = session("new")
        XCTAssertEqual(order.rows(in: SessionHierarchy(sessions: [new, c, a, renamed])).map(\.id), ["new-b", "old-a", "c", "new"])
        XCTAssertEqual(order, saved)
        let regrouped = session("new-b", name: "Alpha-review", pane: "stable-b")
        let rows = order.rows(in: SessionHierarchy(sessions: [c, a, regrouped]))
        XCTAssertEqual(rows.map(\.id), ["old-a", "new-b", "c"])
        XCTAssertEqual(rows[1].parentID, "old-a")
    }

    func testSearchKeepsSavedOrderAndRevealsMatchingChildren() {
        var order = SessionSidebarOrder()
        order.move("b", by: -1, rows: order.rows(in: hierarchy))
        XCTAssertEqual(order.rows(in: hierarchy, matching: "one", collapsed: ["a", "b"]).map(\.id), ["b", "b-one", "a", "a-one"])
        XCTAssertEqual(order.rows(in: hierarchy, matching: "a", collapsed: ["a"]).map(\.id), ["a", "a-one", "a-two"])
        XCTAssertTrue(order.rows(in: hierarchy, matching: "absent").isEmpty)
    }

    func testRoundTripPrivateProfileScopedStorageAndCorruptData() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("orc-sidebar-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = SessionSidebarOrderStore.file(config: directory, profile: directory.appendingPathComponent("one"))
        let other = SessionSidebarOrderStore.file(config: directory, profile: directory.appendingPathComponent("two"))
        XCTAssertNotEqual(file, other)
        XCTAssertEqual(try SessionSidebarOrderStore.load(from: file), SessionSidebarOrder())
        var order = SessionSidebarOrder()
        order.move("c", by: -1, rows: order.rows(in: hierarchy))
        try SessionSidebarOrderStore.save(order, to: file)
        XCTAssertEqual(try SessionSidebarOrderStore.load(from: file), order)
        XCTAssertEqual(try SessionSidebarOrderStore.load(from: other), SessionSidebarOrder())
        let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
        try Data("invalid JSON".utf8).write(to: file)
        XCTAssertThrowsError(try SessionSidebarOrderStore.load(from: file))
    }
}
