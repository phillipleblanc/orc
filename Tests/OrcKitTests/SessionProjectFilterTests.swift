import XCTest
@testable import OrcKit

final class SessionProjectFilterTests: XCTestCase {
    private func session(_ id: String, project: String, path: String = "/code/project", connected: Bool = true) -> Session {
        Session(handle: id, title: id, worktreeId: project, worktreePath: path, connected: connected,
                writable: connected, agentIdentity: nil, incarnationId: nil)
    }

    func testOnlyProjectsWithSessionsAreListedUsingWorkspaceNamesAndStableIDs() {
        let sessions = [session("a", project: "spice"), session("b", project: "spice"),
                        session("c", project: "orc", connected: false),
                        session("d", project: "unlisted", path: "/code/zebra")]
        let workspaces = [Workspace(id: "spice", path: "/code/project", displayName: "Spice.ai", hostId: nil),
                          Workspace(id: "orc", path: "/code/project", displayName: "Orc", hostId: "remote"),
                          Workspace(id: "empty", path: "/code/empty", displayName: nil, hostId: nil)]
        let projects = SessionProjectFilter.projects(in: sessions, workspaces: workspaces)
        XCTAssertEqual(projects.map(\.id), ["orc", "spice", "unlisted"])
        XCTAssertEqual(projects.map(\.name), ["Orc", "Spice.ai", "zebra"])
        XCTAssertEqual(SessionProjectFilter().sessions(in: sessions), sessions)
        XCTAssertEqual(SessionProjectFilter(projectID: "spice").sessions(in: sessions).map(\.id), ["a", "b"])
        XCTAssertEqual(SessionProjectFilter(projectID: "orc").sessions(in: sessions).map(\.id), ["c"])
        XCTAssertTrue(SessionProjectFilter.projects(in: [], workspaces: workspaces).isEmpty)
    }

    func testSelectionResetsWhenItsLastSessionDisappears() {
        var filter = SessionProjectFilter(projectID: "spice")
        filter.reconcile(with: [session("spice", project: "spice", connected: false)])
        XCTAssertEqual(filter.projectID, "spice")
        filter.reconcile(with: [session("orc", project: "orc")])
        XCTAssertNil(filter.projectID)
        filter.reconcile(with: [])
        XCTAssertNil(filter.projectID)
    }

    func testProjectFilteringDoesNotPullInParentsFromAnotherProject() {
        let sessions = [session("review", project: "spice"), session("review-ui", project: "orc")]
        let filtered = SessionProjectFilter(projectID: "orc").sessions(in: sessions)
        let rows = SessionSidebarOrder().rows(in: SessionHierarchy(sessions: filtered))
        XCTAssertEqual(rows.map(\.id), ["review-ui"])
        XCTAssertNil(rows.first?.parentID)
    }
}
