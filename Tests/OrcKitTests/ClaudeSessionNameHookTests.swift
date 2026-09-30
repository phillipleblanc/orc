import XCTest
@testable import OrcKit

final class ClaudeSessionNameHookTests: XCTestCase {
    private func request(_ event: String = "SessionStart", source: String = "startup") throws -> Data {
        try JSONSerialization.data(withJSONObject: ["hook_event_name": event, "source": source, "session_id": "claude-session"])
    }

    func testNamesFollowSavedOrcRenamesAcrossSupportedEvents() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let profile = root.appendingPathComponent("profiles/selected")
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
        try jsonData(["activeProfileId": "selected", "profiles": [["id": "selected"]]])
            .write(to: root.appendingPathComponent("orca-profile-index.json"))
        let environment = ["ORCA_USER_DATA_PATH": root.path, "ORCA_WORKTREE_ID": "project", "ORCA_PANE_KEY": "tab:leaf"]
        for (event, source, name) in [("SessionStart", "startup", "Initial"), ("SessionStart", "resume", "Renamed"),
                                      ("SessionStart", "fork", "Fork"), ("UserPromptSubmit", "", "한글 \"name\" $()") ] {
            try jsonData(["workspaceSession": ["tabsByWorktree": ["project": [["id": "tab", "customTitle": name]]]]])
                .write(to: profile.appendingPathComponent("orca-data.json"))
            let response = ClaudeSessionNameHook.response(to: try request(event, source: source), environment: environment)
            let output = try XCTUnwrap(response["hookSpecificOutput"] as? [String: String])
            XCTAssertEqual(output, ["hookEventName": event, "sessionTitle": name])
            XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: response))
        }
        for source in ["compact", "clear", "unknown"] {
            XCTAssertTrue(ClaudeSessionNameHook.response(to: try request(source: source), environment: environment).isEmpty)
        }
        XCTAssertTrue(ClaudeSessionNameHook.response(to: try request("Stop"), environment: environment).isEmpty)
        for key in environment.keys {
            var incomplete = environment
            incomplete.removeValue(forKey: key)
            XCTAssertTrue(ClaudeSessionNameHook.response(to: try request(), environment: incomplete).isEmpty)
        }
        var wrongPane = environment
        wrongPane["ORCA_PANE_KEY"] = "another:leaf"
        XCTAssertTrue(ClaudeSessionNameHook.response(to: try request(), environment: wrongPane).isEmpty)
        XCTAssertTrue(ClaudeSessionNameHook.response(to: Data("{".utf8), environment: environment).isEmpty)
    }

    func testMissingNamesAndRemoteTabsDoNotRenameClaude() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let environment = ["ORCA_USER_DATA_PATH": root.path, "ORCA_WORKTREE_ID": "project", "ORCA_PANE_KEY": "tab:leaf"]
        for state: [String: Any] in [[:], ["workspaceSessionsByHostId": ["remote": ["tabsByWorktree": ["project": [["id": "tab", "customTitle": "Remote"]]]]]],
                                    ["workspaceSession": ["tabsByWorktree": ["project": [["id": "tab", "customTitle": "  "]]]]]] {
            try jsonData(state).write(to: root.appendingPathComponent("orca-data.json"))
            XCTAssertTrue(ClaudeSessionNameHook.response(to: try request(), environment: environment).isEmpty)
        }
        try Data("{".utf8).write(to: root.appendingPathComponent("orca-data.json"))
        XCTAssertTrue(ClaudeSessionNameHook.response(to: try request(), environment: environment).isEmpty)
    }
}
