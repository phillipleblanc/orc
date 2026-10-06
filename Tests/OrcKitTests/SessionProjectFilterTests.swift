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
        XCTAssertTrue(SessionProjectFilter.projects(in: [], workspaces: workspaces).isEmpty)
    }
}
