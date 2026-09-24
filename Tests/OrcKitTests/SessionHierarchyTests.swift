import XCTest
@testable import OrcKit

final class SessionHierarchyTests: XCTestCase {
    private func session(_ handle: String, _ name: String, project: String = "project") -> Session {
        Session(handle: handle, title: name, worktreeId: project, worktreePath: "/code/\(project)",
                connected: true, writable: true, agentIdentity: "codex", incarnationId: handle)
    }

    func testExistingOrcaNamesGroupWithoutMetadataAndKeepFullName() throws {
        let child = session("child", "orca-frontend-review")
        let other = session("other", "unrelated")
        let parent = session("parent", "orca-frontend")
        let hierarchy = SessionHierarchy(sessions: [child, other, parent])
        XCTAssertEqual(hierarchy.groups.map { $0.session.handle }, ["other", "parent"])
        XCTAssertEqual(hierarchy.groups[1].children.map(\.handle), ["child"])
        XCTAssertEqual(hierarchy.parent(of: child)?.handle, "parent")
        XCTAssertTrue(hierarchy.canCreateChild(of: parent))
        XCTAssertFalse(hierarchy.canCreateChild(of: child))
        XCTAssertEqual(hierarchy.displayName(for: child), "review")
        XCTAssertEqual(child.name, "orca-frontend-review")
        XCTAssertEqual(try SessionHierarchy.childName(parent: parent, suffix: " review "), child.name)
        XCTAssertEqual(child.attachCommand, "orc attach 'child'")
    }

    func testOneLevelNestingDoesNotMakeAChildAnotherParent() {
        let root = session("root", "orca")
        let child = session("child", "orca-frontend")
        let grandchildName = session("long", "orca-frontend-review")
        let hierarchy = SessionHierarchy(sessions: [grandchildName, child, root])
        XCTAssertEqual(hierarchy.groups.map { $0.session.handle }, ["root"])
        XCTAssertEqual(hierarchy.groups[0].children.map(\.handle), ["long", "child"])
        XCTAssertEqual(hierarchy.parent(of: grandchildName)?.handle, "root")
        XCTAssertEqual(hierarchy.displayName(for: grandchildName), "frontend-review")
    }

    func testRenamingRegroupsAndSearchFindsChildWithParent() {
        let parent = session("parent", "orca-frontend")
        let child = session("child", "review")
        XCTAssertEqual(SessionHierarchy(sessions: [parent, child]).groups.count, 2)
        let renamed = session("child", "orca-frontend-review")
        let hierarchy = SessionHierarchy(sessions: [parent, renamed])
        XCTAssertEqual(hierarchy.groups.count, 1)
        XCTAssertEqual(hierarchy.matching("review").map { $0.session.handle }, ["parent"])
        XCTAssertEqual(hierarchy.matching("review")[0].children.map(\.handle), ["child"])
        XCTAssertEqual(hierarchy.matching("orca-frontend")[0].children.map(\.handle), ["child"])
    }

    func testAmbiguousParentNameDoesNotAttachChildToAnArbitraryPane() {
        let first = session("first", "shared")
        let second = session("second", "shared")
        let child = session("child", "shared-review")
        let hierarchy = SessionHierarchy(sessions: [first, second, child])
        XCTAssertEqual(hierarchy.groups.count, 3)
        XCTAssertNil(hierarchy.parent(of: child))
        XCTAssertFalse(hierarchy.canCreateChild(of: first))
        XCTAssertFalse(hierarchy.canCreateChild(of: second))
        XCTAssertEqual(hierarchy.displayName(for: child), child.name)
    }

    func testChildNameUsesCombinedLimitAndRejectsControls() {
        let parent = session("parent", "orca-frontend")
        XCTAssertThrowsError(try SessionHierarchy.childName(parent: parent, suffix: "  "))
        XCTAssertThrowsError(try SessionHierarchy.childName(parent: parent, suffix: "bad\nname"))
        XCTAssertThrowsError(try SessionHierarchy.childName(parent: parent, suffix: String(repeating: "a", count: 200)))
    }
}
