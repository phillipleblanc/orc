import XCTest
@testable import OrcKit

final class SessionSidebarOrderTests: XCTestCase {
    private func session(_ handle: String, name: String? = nil) -> Session {
        Session(handle: handle, title: name ?? handle, worktreeId: "project", worktreePath: "/code/project",
                connected: true, writable: true, agentIdentity: "pi", incarnationId: handle)
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
        order.move(fromOffsets: [2], toOffset: 1, rows: order.rows(in: hierarchy))
        let collapsed = order.rows(in: hierarchy, collapsed: ["a", "b"])
        XCTAssertEqual(collapsed.map(\.id), ["a", "b", "c"])
        XCTAssertTrue(collapsed[0].hasChildren)
        order.move(fromOffsets: [0], toOffset: 3, rows: collapsed)
        XCTAssertEqual(order.rows(in: hierarchy).map(\.id), ["b", "b-one", "c", "a", "a-two", "a-one"])
        XCTAssertEqual(order.rows(in: hierarchy, collapsed: ["a"]).map(\.id), ["b", "b-one", "c", "a"])
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

    func testSavedOrderSurvivesRefreshHandleChangeAndMissingSessions() {
        let a = session("old-a", name: "Alpha")
        let b = session("old-b", name: "Beta")
        let c = session("c")
        var order = SessionSidebarOrder()
        order.move(fromOffsets: [1], toOffset: 0, rows: order.rows(in: SessionHierarchy(sessions: [a, b, c])))
        let saved = order
        XCTAssertTrue(order.rows(in: SessionHierarchy(sessions: [])).isEmpty)
        XCTAssertEqual(order.rows(in: SessionHierarchy(sessions: [c, a])).map(\.id), ["old-a", "c"])
        let reminted = session("new-b", name: "Beta")
        let new = session("new")
        XCTAssertEqual(order.rows(in: SessionHierarchy(sessions: [new, c, a, reminted])).map(\.id), ["new-b", "old-a", "c", "new"])
        XCTAssertEqual(order, saved)
        let regrouped = session("new-b", name: "Alpha-review")
        let rows = order.rows(in: SessionHierarchy(sessions: [c, a, regrouped]))
        XCTAssertEqual(rows.map(\.id), ["old-a", "new-b", "c"])
        XCTAssertEqual(rows[1].parentID, "old-a")
    }

    func testSearchKeepsSavedOrderAndRevealsMatchingChildren() {
        var order = SessionSidebarOrder()
        order.move(fromOffsets: [3], toOffset: 0, rows: order.rows(in: hierarchy))
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
        order.move(fromOffsets: [5], toOffset: 3, rows: order.rows(in: hierarchy))
        try SessionSidebarOrderStore.save(order, to: file)
        XCTAssertEqual(try SessionSidebarOrderStore.load(from: file), order)
        XCTAssertEqual(try SessionSidebarOrderStore.load(from: other), SessionSidebarOrder())
        let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
        try Data("invalid JSON".utf8).write(to: file)
        XCTAssertThrowsError(try SessionSidebarOrderStore.load(from: file))
    }

    func testSectionsGroupByProjectInTheOrderOfTheirFirstSession() {
        func session(_ name: String, project: String) -> Session {
            Session(handle: name, title: name, worktreeId: project, worktreePath: "/code/" + project,
                    connected: true, writable: true, agentIdentity: "pi", incarnationId: name)
        }
        let sessions = [session("a", project: "spice"), session("a-one", project: "spice"), session("b", project: "orc"),
                        session("c", project: "spice"), session("d", project: "folder")]
        let workspaces = [Workspace(id: "spice", path: "/code/spice", displayName: "spiceai-project", hostId: nil),
                          Workspace(id: "orc", path: "/code/orc", displayName: nil, hostId: nil)]
        var order = SessionSidebarOrder()
        var sections = order.sections(of: sessions, workspaces: workspaces)
        XCTAssertEqual(sections.map(\.project.name), ["spiceai-project", "orc", "folder"])
        XCTAssertEqual(sections.map(\.count), [3, 1, 1])
        XCTAssertEqual(sections[0].rows.map(\.id), ["a", "a-one", "c"])
        XCTAssertEqual(sections[0].rows[1].parentID, "a")
        // Moving a session within its section reorders that section only.
        order.move(fromOffsets: [2], toOffset: 0, rows: sections[0].rows)
        sections = order.sections(of: sessions, workspaces: workspaces)
        XCTAssertEqual(sections[0].rows.map(\.id), ["c", "a", "a-one"])
        XCTAssertEqual(sections.map(\.project.name), ["spiceai-project", "orc", "folder"])
        // A collapsed parent hides its children but the count includes them.
        let collapsed = order.sections(of: sessions, workspaces: workspaces, collapsed: ["a"])[0]
        XCTAssertEqual(collapsed.rows.map(\.id), ["c", "a"])
        XCTAssertEqual(collapsed.count, 3)
    }
}
