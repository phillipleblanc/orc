import XCTest
@testable import OrcKit

final class SessionCreationDefaultsTests: XCTestCase {
    func testGeneratedNamesStayShortAndAvoidExistingNames() throws {
        var used: Set<String> = ["glide-mouse", "BAKE-OTTER"]
        for _ in 0..<100 {
            let name = try SessionCreationDefaults.name(excluding: used)
            XCTAssertNotNil(name.range(of: "^[a-z]{3,5}-[a-z]{3,5}$", options: .regularExpression))
            XCTAssertFalse(used.map { $0.lowercased() }.contains(name))
            used.insert(name)
        }
    }
    func testOnlyRemainingNameAndExhaustion() throws {
        let all = Set(SessionCreationDefaults.names)
        XCTAssertEqual(all.count, SessionCreationDefaults.names.count)
        XCTAssertTrue(all.contains("glide-mouse"))
        let reserved = Set(all.subtracting(["glide-mouse"]).map { $0.uppercased() })
        XCTAssertEqual(try SessionCreationDefaults.name(excluding: reserved), "glide-mouse")
        XCTAssertThrowsError(try SessionCreationDefaults.name(excluding: all))
    }
    func testDefaultSelectsLocalProjectByNameOrDirectory() throws {
        let remote = Workspace(id: "remote", path: "/remote/spiceai-project", displayName: nil, hostId: "ssh:other")
        let other = Workspace(id: "other", path: "/code/other", displayName: nil, hostId: "local")
        for local in [
            Workspace(id: "local-project", path: "/code/spiceai-project", displayName: "My project", hostId: "local"),
            Workspace(id: "local-project", path: "/code/renamed", displayName: "spiceai-project", hostId: nil)
        ] {
            XCTAssertEqual(try SessionCreationDefaults.project(in: [remote, other, local]).id, "local-project")
        }
    }
    func testMissingRemoteOnlyAndAmbiguousDefaultsRequireExplicitProject() {
        let first = Workspace(id: "first", path: "/one/spiceai-project", displayName: nil, hostId: "local")
        let second = Workspace(id: "second", path: "/two/spiceai-project", displayName: nil, hostId: "local")
        let remote = Workspace(id: "remote", path: "/remote/spiceai-project", displayName: nil, hostId: "ssh:other")
        for projects in [[], [remote], [first, second]] {
            XCTAssertThrowsError(try SessionCreationDefaults.project(in: projects)) { error in
                XCTAssertTrue(error.localizedDescription.contains("--project"))
            }
        }
    }
    func testExplicitProjectSelectorsAndAmbiguity() throws {
        let local = Workspace(id: "local", path: "/one/shared", displayName: "My project", hostId: "local")
        let remote = Workspace(id: "remote", path: "/remote/shared", displayName: "Remote project", hostId: "ssh:other")
        let projects = [local, remote]
        for selector in ["My project", "id:local", "path:/one/shared", "/one/shared"] {
            XCTAssertEqual(try SessionCreationDefaults.project(selector, in: projects), local)
        }
        XCTAssertEqual(try SessionCreationDefaults.project("Remote project", in: projects), remote)
        XCTAssertThrowsError(try SessionCreationDefaults.project("shared", in: projects))
        XCTAssertThrowsError(try SessionCreationDefaults.project("unknown", in: projects))
        XCTAssertThrowsError(try SessionCreationDefaults.project("id:loc", in: projects))
    }
}
