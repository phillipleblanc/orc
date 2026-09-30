import XCTest
@testable import OrcKit

final class ClaudeSessionNameHookTests: XCTestCase {
    private func request(_ event: String = "SessionStart", source: String = "startup", extra: [String: Any] = [:]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["hook_event_name": event, "source": source, "session_id": "claude-session"].merging(extra) { $1 })
    }

    func testTitleIsTheSessionNameOnSupportedEvents() throws {
        let environment = ["ORC_SESSION_NAME": "한글 \"name\" $()"]
        for (event, source) in [("SessionStart", "startup"), ("SessionStart", "resume"), ("SessionStart", "fork"), ("UserPromptSubmit", "")] {
            let response = ClaudeSessionNameHook.response(to: try request(event, source: source), environment: environment)
            XCTAssertEqual(try XCTUnwrap(response["hookSpecificOutput"] as? [String: String]),
                           ["hookEventName": event, "sessionTitle": "한글 \"name\" $()"])
            XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: response))
        }
    }

    func testOtherEventsSubagentsAndSessionsOutsideOrcAreLeftAlone() throws {
        let environment = ["ORC_SESSION_NAME": "review"]
        for source in ["compact", "clear", "unknown"] {
            XCTAssertTrue(ClaudeSessionNameHook.response(to: try request(source: source), environment: environment).isEmpty)
        }
        XCTAssertTrue(ClaudeSessionNameHook.response(to: try request("Stop"), environment: environment).isEmpty)
        XCTAssertTrue(ClaudeSessionNameHook.response(to: try request(extra: ["agent_id": "sub"]), environment: environment).isEmpty)
        XCTAssertTrue(ClaudeSessionNameHook.response(to: try request(), environment: [:]).isEmpty)
        XCTAssertTrue(ClaudeSessionNameHook.response(to: try request(), environment: ["ORC_SESSION_NAME": ""]).isEmpty)
        XCTAssertTrue(ClaudeSessionNameHook.response(to: Data("{".utf8), environment: environment).isEmpty)
    }
}
