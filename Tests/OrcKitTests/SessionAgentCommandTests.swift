import XCTest
@testable import OrcKit

final class SessionAgentCommandTests: XCTestCase {
    func testSpawnTakesTheNamePositionallyOrAsAnOption() throws {
        let positional = try SessionAgentCommand(["spawn", "codex", "fix-ci", "--project", "orc", "--json"])
        XCTAssertEqual(positional.action, .spawn)
        XCTAssertEqual(positional.agent, "codex")
        XCTAssertEqual(positional.name, "fix-ci")
        XCTAssertEqual(positional.options["project"], "orc")
        XCTAssertTrue(positional.json)
        XCTAssertEqual(try SessionAgentCommand(["spawn", "pi", "--name", "helper"]).name, "helper")
        XCTAssertThrowsError(try SessionAgentCommand(["spawn", "pi", "helper", "--name", "other"]))
        XCTAssertThrowsError(try SessionAgentCommand(["spawn", "vim", "editor"]))
        XCTAssertThrowsError(try SessionAgentCommand(["spawn", "codex"]))
    }

    func testMessagingCommandsTakeOneName() throws {
        XCTAssertEqual(try SessionAgentCommand(["send", "fix-ci", "--file", "note.md"]).options["file"], "note.md")
        XCTAssertTrue(try SessionAgentCommand(["stop", "fix-ci", "--kill"]).kill)
        XCTAssertEqual(try SessionAgentCommand(["wait", "fix-ci", "--timeout-seconds", "30"]).options["timeout-seconds"], "30")
        XCTAssertThrowsError(try SessionAgentCommand(["send"]))
        XCTAssertThrowsError(try SessionAgentCommand(["status", "a", "b"]))
        XCTAssertThrowsError(try SessionAgentCommand(["list", "extra"]))
        XCTAssertThrowsError(try SessionAgentCommand(["wait", "fix-ci", "--timeout-seconds", "0"]))
        XCTAssertThrowsError(try SessionAgentCommand(["send", "fix-ci", "--kill"]))
    }

    func testDescriptionsNameTheAgentAndItsState() throws {
        let command = try SessionAgentCommand(["list"])
        let text = SessionAgentService.describe(command, ["agents": [["name": "fix-ci", "agent": "codex", "state": "working", "queued": 2, "parent": "lead"]]])
        XCTAssertEqual(text, "fix-ci  codex  working  2 queued  from lead")
        XCTAssertEqual(SessionAgentService.describe(command, ["agents": []]), "No agents.")
    }
}
