import XCTest
@testable import OrcKit

final class SessionWakeCommandTests: XCTestCase {
    func testDurationsCombineUnitsAndRejectAnythingElse() {
        XCTAssertEqual(SessionWakeCommand.milliseconds("90s"), 90_000)
        XCTAssertEqual(SessionWakeCommand.milliseconds("1h30m"), 5_400_000)
        XCTAssertEqual(SessionWakeCommand.milliseconds("1.5S"), 1500)
        XCTAssertEqual(SessionWakeCommand.milliseconds("250ms"), 250)
        XCTAssertEqual(SessionWakeCommand.milliseconds("365d"), 365 * 86_400_000)
        for text in ["", "90", "5x", "0s", "m", "1h 30m", "-5m", "30m later", "366d"] {
            XCTAssertNil(SessionWakeCommand.milliseconds(text), text)
        }
    }

    func testConditionsAndMessages() throws {
        XCTAssertEqual(try SessionWakeCommand(["30m", "check", "CI"]).action, .create(.after(milliseconds: 1_800_000), message: "check CI"))
        XCTAssertEqual(try SessionWakeCommand(["pid", "42", "--json"]).action, .create(.pid(42), message: ""))
        XCTAssertTrue(try SessionWakeCommand(["pid", "42", "--json"]).json)
        XCTAssertEqual(try SessionWakeCommand(["list"]).action, .list)
        XCTAssertEqual(try SessionWakeCommand(["cancel", "1a2b"]).action, .cancel("1a2b"))
        for arguments in [[], ["pid"], ["pid", "0"], ["pid", "abc"], ["list", "extra"], ["cancel"], ["cancel", "a", "b"], ["5x"]] {
            XCTAssertThrowsError(try SessionWakeCommand(arguments), "\(arguments)")
        }
    }

    func testScriptsResolveAgainstTheCurrentDirectory() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("bin"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data("true\n".utf8).write(to: directory.appendingPathComponent("bin/check.sh"))
        let command = try SessionWakeCommand(["./bin/../bin/check.sh", "CI", "done"], currentDirectory: directory.path)
        XCTAssertEqual(command.action, .create(.script(path: directory.path + "/bin/check.sh", cwd: directory.path), message: "CI done"))
        XCTAssertThrowsError(try SessionWakeCommand(["bin"], currentDirectory: directory.path))
        XCTAssertThrowsError(try SessionWakeCommand(["missing.sh"], currentDirectory: directory.path))
    }

    func testWakesRunOnlyInsideASession() async throws {
        do {
            _ = try await SessionWakeService.execute(try SessionWakeCommand(["list"]), environment: [:])
            XCTFail("expected an error")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("inside an Orc agent session"))
        }
    }

    func testDescriptionsShowTheShortIdConditionAndMessage() throws {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let list = try SessionWakeCommand(["list"])
        let text = SessionWakeService.describe(list, ["wakes": [
            ["id": "1a2b3c4d-0000", "kind": "timer", "dueAt": (1_000_000 + 5400) * 1000, "message": "check\nCI"],
            ["id": "5e6f7a8b-0000", "kind": "pid", "pid": 42, "command": "cargo test", "message": ""],
            ["id": "9c0d1e2f-0000", "kind": "script", "script": "/tmp/check.sh", "message": "CI done"]
        ]], now: now)
        let lines = text.split(separator: "\n").map(String.init)
        XCTAssertTrue(lines[0].hasPrefix("1a2b3c4d  in 1h30m ("), lines[0])
        XCTAssertTrue(lines[0].hasSuffix(")  check CI"), lines[0])
        XCTAssertEqual(lines[1], "5e6f7a8b  when pid 42 exits (cargo test)")
        XCTAssertEqual(lines[2], "9c0d1e2f  when /tmp/check.sh exits  CI done")
        XCTAssertEqual(SessionWakeService.describe(list, ["wakes": []]), "No wakes.")
        XCTAssertEqual(SessionWakeService.duration(59.6), "1m")
        XCTAssertEqual(SessionWakeService.duration(90_061), "1d1h")
        XCTAssertEqual(SessionWakeService.duration(3605), "1h")
    }
}
