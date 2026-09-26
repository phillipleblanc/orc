import XCTest
@testable import OrcKit

final class AgentCommandTests: XCTestCase {
    let request = "d188a602-7e51-498f-88de-8f9ff0e8c605"
    func spawn(_ extra: [String] = []) throws -> AgentCommand {
        try AgentCommand(["spawn", "pi", "--name", "test-worker", "--prompt-file", "/tmp/brief", "--request-id", request] + extra)
    }
    func ok(_ result: [String: Any]) -> BundledCLIReply { .init(body: ["ok": true, "result": result], exitCode: 0) }

    func testParserRejectsAmbiguity() throws {
        for args in [
            ["spawn", "pi", "--name", "x"],
            ["spawn", "pi", "--name", "x", "--prompt-file", "a", "--model", "gpt-6-sol"],
            ["spawn", "pi", "--name", "x", "--prompt-file", "a", "--retry-of", "d"],
            ["send", "d", "--prompt-file", "a", "--prompt-file", "b"],
            ["stop", "d", "--terminal", "t"], ["stop", "a", "b"],
            ["stop", "d", "--request-id", "bad"], ["request", "bad"],
            ["rename", "d", "--name", "bad\nname"], ["list", "d"]
        ] { XCTAssertThrowsError(try AgentCommand(args), "\(args)") }
        XCTAssertEqual(try spawn().requestID, request)
        XCTAssertThrowsError(try spawn(["--timeout-seconds", "601"]))
        XCTAssertEqual(try AgentCommand(["list", "--run", "r"]).options["run"], "r")
    }

    func testPromptPreservesBytesAndBounds() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let command = try AgentCommand(["send", "d", "--prompt-file", file.path])
        let text = "First line\n\n`literal` $(literal) 'quoted' 🐳\n"
        try Data(text.utf8).write(to: file)
        XCTAssertEqual(try command.prompt(), text)
        for bytes in [Data(repeating: 65, count: 65_537), Data([0xff]), Data(" \n".utf8), Data([65, 0])] {
            try bytes.write(to: file); XCTAssertThrowsError(try command.prompt())
        }
    }

    func testSpawnCreatesRunDeliversBriefAndNamesExactWorker() throws {
        var calls: [[String]] = []
        var locked = false
        let driver = AgentDriver(runtimeID: "runtime", call: { args in
            calls.append(args)
            switch args[1] {
            case "run-current": XCTAssertTrue(locked); return self.ok(["run": NSNull()])
            case "run-create": XCTAssertTrue(locked); return self.ok(["run": ["id": "run"]])
            case "worker-start":
                XCTAssertFalse(locked)
                return self.ok(["state": "ready", "dispatchId": "d", "taskId": "t", "runId": "run",
                    "effects": [["kind": "terminal", "role": "agent", "id": "terminal"]]])
            case "worker-show": return self.ok(["worker": ["agentTerminalHandle": "terminal"], "observation": ["exactWorker": true]])
            case "rename": return self.ok(["rename": ["handle": "terminal", "title": "test-worker"]])
            default: XCTFail("Unexpected call"); return self.ok([:])
            }
        })
        let reply = driver.execute(try spawn(), prompt: "brief\n", project: "project") { operation in
            locked = true; defer { locked = false }; return try operation()
        }
        XCTAssertEqual(reply.exitCode, 0)
        XCTAssertEqual(reply.body["agentId"] as? String, "d")
        XCTAssertEqual(calls.map { $0[1] }, ["run-current", "run-create", "worker-start", "worker-show", "rename"])
        XCTAssertTrue(calls[1].contains(AgentDriver.runRequestID(request)))
        XCTAssertNotEqual(AgentDriver.runRequestID(request), request)
        XCTAssertTrue(calls[2].contains("brief\n")); XCTAssertTrue(calls[2].contains("id:project"))
        XCTAssertTrue(calls[2].contains(request)); XCTAssertFalse(calls[2].contains("--name"))
        XCTAssertTrue(calls[4].contains("terminal"))
    }

    func testFailureAndUnknownNeverRenameOrRetry() throws {
        for state in ["failed", "outcome_unknown"] {
            var calls: [String] = []
            let driver = AgentDriver(runtimeID: "r", call: { args in
                calls.append(args[1])
                if args[1] == "run-current" { return self.ok(["run": ["id": "run"]]) }
                return .init(body: ["ok": true, "result": ["dispatchId": "d", "state": state,
                    "failedStage": "readiness", "residualResources": ["resource"]]], exitCode: 1)
            })
            let reply = driver.execute(try spawn(), prompt: "brief", project: "p")
            XCTAssertEqual(reply.exitCode, 1); XCTAssertEqual(reply.body["agentId"] as? String, "d")
            XCTAssertEqual(calls, ["run-current", "worker-start"])
            XCTAssertEqual((reply.body["result"] as? [String: Any])?["failedStage"] as? String, "readiness")
        }
    }

    func testNamingFailureRetainsSpawnReceipt() throws {
        let driver = AgentDriver(runtimeID: "r", call: { args in
            switch args[1] {
            case "run-current": return self.ok(["run": ["id": "run"]])
            case "worker-start": return self.ok(["state": "ready", "dispatchId": "d",
                "effects": [["kind": "terminal", "role": "agent", "id": "t"]]])
            default: throw OrcError("lost rename response")
            }
        })
        let reply = driver.execute(try spawn(), prompt: "brief", project: "p")
        XCTAssertEqual(reply.exitCode, 1); XCTAssertEqual(reply.body["agentId"] as? String, "d")
        XCTAssertEqual(reply.body["phase"] as? String, "rename")
        XCTAssertEqual((reply.body["result"] as? [String: Any])?["state"] as? String, "ready")
    }

    func testRetryReusesOriginalTask() throws {
        var start: [String] = []
        let driver = AgentDriver(runtimeID: "r", call: { args in
            switch args[1] {
            case "run-current": return self.ok(["run": ["id": "run"]])
            case "worker-show": return self.ok(["dispatch": ["runId": "run", "taskId": "original"]])
            default: start = args; return .init(body: ["ok": false], exitCode: 1)
            }
        })
        let command = try AgentCommand(["spawn", "pi", "--name", "retry", "--retry-of", "old"])
        _ = driver.execute(command, prompt: nil, project: "p")
        XCTAssertTrue(start.contains("original")); XCTAssertTrue(start.contains("old")); XCTAssertFalse(start.contains("--spec"))
    }

    func testRenameRefusesReplacedWorker() throws {
        var calls = 0
        let driver = AgentDriver(runtimeID: "r", call: { args in
            calls += 1
            XCTAssertEqual(args[1], "worker-show")
            return self.ok(["worker": ["agentTerminalHandle": "other"], "observation": ["exactWorker": false]])
        })
        let command = try AgentCommand(["rename", "old", "--name", "new"])
        XCTAssertEqual(driver.execute(command, prompt: nil, project: nil).exitCode, 1)
        XCTAssertEqual(calls, 1)
    }

    func testStopAndReleaseUseDispatchAndStableRequest() throws {
        for action in ["stop", "release"] {
            var captured: [String] = []
            let driver = AgentDriver(runtimeID: "r", call: { args in captured = args; return self.ok(["state": "settled"]) })
            let command = try AgentCommand([action, "dispatch", "--request-id", request])
            _ = driver.execute(command, prompt: nil, project: nil)
            XCTAssertEqual(captured, ["orchestration", "worker-" + action, "--dispatch", "dispatch", "--retry-request", request])
        }
    }
}
