import XCTest
@testable import OrcKit

final class SessionMutesTests: XCTestCase {
    private func session(_ name: String) throws -> Session {
        try decode(["handle": "term_" + name, "title": name, "worktreeId": "p", "worktreePath": "/code/p", "connected": true, "writable": true])
    }

    func testMutedSessionsAreLeftOutAndFollowRenames() throws {
        var mutes = SessionMutes()
        mutes.set(true, for: "coord")
        let sessions = [try session("coord"), try session("helper")]
        XCTAssertEqual(mutes.unmuted(sessions).map(\.name), ["helper"])
        mutes.rename("coord", to: "lead")
        XCTAssertFalse(mutes.isMuted("coord"))
        XCTAssertTrue(mutes.isMuted("lead"))
        mutes.rename("helper", to: "worker")
        XCTAssertEqual(mutes.names, ["lead"])
        mutes.set(false, for: "lead")
        XCTAssertEqual(mutes.names, [])
    }

    func testNamesNoSessionHasAreForgotten() {
        var mutes = SessionMutes(names: ["running", "closed", "gone"])
        mutes.prune(keeping: ["running", "closed", "other"])
        XCTAssertEqual(mutes.names, ["running", "closed"])
    }

    func testMutesPersist() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("muted-sessions.json")
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        XCTAssertEqual(try SessionMuteStore.load(from: file), SessionMutes())
        try SessionMuteStore.save(SessionMutes(names: ["coord"]), to: file)
        XCTAssertEqual(try SessionMuteStore.load(from: file).names, ["coord"])
        let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int
        XCTAssertEqual(permissions, 0o600)
    }
}
