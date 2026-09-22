import XCTest
@testable import OrcKit

final class SavedSessionNamesTests: XCTestCase {
    private func session(_ name: String) -> [String: Any] {
        ["tabsByWorktree": ["workspace": [["id": "tab", "customTitle": name]]]]
    }
    private func write(_ value: [String: Any], to file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try jsonData(value).write(to: file)
    }
    func testOnlyActiveProfileNamesAreReadAndHostIdentitiesStaySeparate() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try write(["activeProfileId": "selected", "profiles": [["id": "selected"], ["id": "other"]]],
                  to: root.appendingPathComponent("orca-profile-index.json"))
        let file = root.appendingPathComponent("profiles/selected/orca-data.json")
        try write(["workspaceSession": session("Local 한글"), "workspaceSessionsByHostId": ["ssh:remote": session("Remote")]], to: file)
        try write(["workspaceSession": session("Wrong profile")], to: root.appendingPathComponent("profiles/other/orca-data.json"))
        try write(["workspaceSession": session("Old migration data")], to: root.appendingPathComponent("orca-data.json"))
        let before = try Data(contentsOf: file)
        XCTAssertEqual(SavedSessionNames.load(from: root), [
            SessionTab(host: "local", worktree: "workspace", tab: "tab"): "Local 한글",
            SessionTab(host: "ssh:remote", worktree: "workspace", tab: "tab"): "Remote"])
        XCTAssertEqual(try Data(contentsOf: file), before)
    }
    func testUnavailableOrInvalidProfileDataDoesNotInventNamesOrReadAnotherProfile() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertTrue(SavedSessionNames.load(from: root).isEmpty)
        try write(["workspaceSession": session("Legacy")], to: root.appendingPathComponent("orca-data.json"))
        XCTAssertEqual(SavedSessionNames.load(from: root).values.first, "Legacy")
        let index = root.appendingPathComponent("orca-profile-index.json")
        for id in ["missing", "../outside"] {
            try write(["activeProfileId": id, "profiles": [["id": id]]], to: index)
            XCTAssertTrue(SavedSessionNames.load(from: root).isEmpty)
        }
        try Data("{".utf8).write(to: index)
        XCTAssertTrue(SavedSessionNames.load(from: root).isEmpty)
    }
}
