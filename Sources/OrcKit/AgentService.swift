import Foundation
import CryptoKit
import Darwin

public struct AgentReply {
    public let body: [String: Any]
    public let exitCode: Int32
}

public enum AgentService {
    public static func execute(_ command: AgentCommand) async -> AgentReply {
        do {
            let prompt = try command.prompt()
            var environment = ProcessInfo.processInfo.environment
            if command.action == .spawn || command.action == .send {
                guard [command.options["from"], environment["ORCA_PANE_KEY"], environment["ORCA_TERMINAL_HANDLE"]]
                    .contains(where: { $0?.isEmpty == false }) else {
                    throw OrcError("Run this command from your own Orc coordinator session, or supply --from with its verified terminal handle. No caller identity was inherited.")
                }
            }
            let metadata = try await RuntimeBootstrap.ensureRunning()
            if [.spawn, .send].contains(command.action), command.options["from"] == nil,
               environment["ORCA_TERMINAL_HANDLE"]?.isEmpty != false,
               let pane = environment["ORCA_PANE_KEY"] {
                let resolved = try await LocalRPC.call("terminal.resolvePane", ["paneKey": pane])
                guard let handle = (resolved["terminal"] as? [String: Any])?["handle"] as? String else {
                    throw OrcError("Cannot resolve your own coordinator pane. No caller identity was selected.")
                }
                environment["ORCA_TERMINAL_HANDLE"] = handle
            }
            var project: String?
            if command.action == .spawn {
                let selector = try command.options["project"] ?? OrcConfiguration.load().defaultProject
                project = try await SessionCreationDefaults.project(selector, in: SessionService().workspaces()).id
            }
            return try await Task.detached {
                let cli = try BundledCLI(runtimeID: metadata.runtimeId, environment: environment)
                let driver = AgentDriver(runtimeID: metadata.runtimeId, call: cli.call)
                return driver.execute(command, prompt: prompt, project: project) { operation in
                    try withRunLock(operation)
                }
            }.value
        } catch {
            return AgentReply(body: ["ok": false, "action": command.action.rawValue,
                "requestId": command.requestID, "error": ["message": error.localizedDescription]], exitCode: 1)
        }
    }

    // Serialize only Run discovery/binding. Worker readiness must not hold this lock.
    private static func withRunLock<T>(_ operation: () throws -> T) throws -> T {
        let profile = RuntimeMetadata.directory.resolvingSymlinksInPath()
        let fd = Darwin.open(profile.appendingPathComponent("orc-agent-run.lock").path,
                             O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw OrcError("Cannot lock this coordinator's Run binding.") }
        defer { Darwin.close(fd) }
        let deadline = Date().addingTimeInterval(30)
        while flock(fd, LOCK_EX | LOCK_NB) != 0 {
            guard (errno == EWOULDBLOCK || errno == EINTR), Date() < deadline else {
                throw OrcError("Another command is still binding this coordinator's Run. Inspect its request before retrying.")
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        defer { flock(fd, LOCK_UN) }
        return try operation()
    }
}

/// Keeps the bundled CLI's mutation receipts and exit semantics intact.
struct AgentDriver {
    let runtimeID: String
    let call: ([String]) throws -> BundledCLIReply

    func execute(_ command: AgentCommand, prompt: String?, project: String?,
                 withRunLock: (() throws -> BundledCLIReply) throws -> BundledCLIReply = { try $0() }) -> AgentReply {
        var phase = command.action.rawValue
        var operationID = command.requestID
        var receipt: BundledCLIReply?
        func finish(_ reply: BundledCLIReply) -> AgentReply {
            var body = reply.body
            body["action"] = command.action.rawValue
            body["runtimeId"] = runtimeID
            body["requestId"] = operationID
            body["spawnRequestId"] = command.action == .spawn ? command.requestID : nil
            body["phase"] = phase
            body["succeeded"] = reply.succeeded
            if let id = reply.result["dispatchId"] as? String ?? (reply.result["dispatch"] as? [String: Any])?["id"] as? String {
                body["agentId"] = id
            } else if [.send, .stop, .release, .show, .rename].contains(command.action) { body["agentId"] = command.target }
            return AgentReply(body: body, exitCode: reply.succeeded ? 0 : 1)
        }
        do {
            let from = command.options["from"].map { ["--from", $0] } ?? []
            let keyed = ["--retry-request", command.requestID]
            switch command.action {
            case .spawn:
                guard let project, let name = command.options["name"] else { throw OrcError("Missing spawn project or name.") }
                phase = "run"
                operationID = Self.runRequestID(command.requestID)
                let runReply = try withRunLock {
                    let current = try call(["orchestration", "run-current"] + from)
                    guard current.succeeded else { return current }
                    if (current.result["run"] as? [String: Any])?["id"] is String { return current }
                    return try call(["orchestration", "run-create", "--objective", "Orc agents",
                                     "--retry-request", operationID] + from)
                }
                guard runReply.succeeded else { return finish(runReply) }
                guard let run = (runReply.result["run"] as? [String: Any])?["id"] as? String else {
                    throw OrcError("The runtime returned no Run ID. Inspect the Run request before retrying.")
                }
                operationID = command.requestID; phase = "spawn"
                var args = ["orchestration", "worker-start", "--run", run, "--worktree", "id:" + project,
                            "--agent", command.target, "--timeout-ms", String((Int(command.options["timeout-seconds"] ?? "60") ?? 60) * 1000)] + from + keyed
                if let retry = command.options["retry-of"] {
                    let original = try call(["orchestration", "worker-show", "--dispatch", retry])
                    guard original.succeeded else { return finish(original) }
                    guard let dispatch = original.result["dispatch"] as? [String: Any],
                          dispatch["runId"] as? String == run, let task = dispatch["taskId"] as? String else {
                        throw OrcError("The original agent must belong to your current Run. No retry was started.")
                    }
                    args += ["--task", task, "--retry-of", retry]
                } else {
                    guard let prompt else { throw OrcError("Missing prompt.") }
                    args += ["--spec", prompt, "--task-title", name]
                }
                for key in ["model", "effort"] { if let value = command.options[key] { args += ["--" + key, value] } }
                var reply = try call(args)
                receipt = reply
                guard reply.succeeded else { return finish(reply) }
                guard reply.result["state"] as? String == "ready", let id = reply.result["dispatchId"] as? String else {
                    reply.exitCode = 1; reply.body["warning"] = "Worker readiness was not proven. Inspect the receipt before retrying."
                    return finish(reply)
                }
                phase = "rename"
                let named = try rename(id, name: name)
                reply.body["naming"] = named.body
                if !named.succeeded {
                    reply.exitCode = 1
                    reply.body["warning"] = "Agent \(id) was spawned, but naming failed. Use `orc agent rename \(id) --name NAME`; do not spawn again."
                }
                return finish(reply)
            case .send:
                guard let prompt else { throw OrcError("Missing prompt.") }
                return finish(try call(["orchestration", "send", "--to", "dispatch:" + command.target,
                    "--subject", command.options["subject"] ?? "Follow-up", "--body", prompt] + from + keyed))
            case .stop, .release:
                return finish(try call(["orchestration", "worker-" + command.action.rawValue, "--dispatch", command.target] + keyed))
            case .list:
                var args = ["orchestration", "worker-list", "--limit", "100"]
                for key in ["run", "cursor"] { if let value = command.options[key] { args += ["--" + key, value] } }
                return finish(try call(args))
            case .show:
                return finish(try call(["orchestration", "worker-show", "--dispatch", command.target]))
            case .request:
                operationID = command.target
                return finish(try call(["orchestration", "request-show", "--request", command.target]))
            case .rename:
                return finish(try rename(command.target, name: command.options["name"]!))
            }
        } catch {
            var reply = receipt ?? BundledCLIReply(body: ["ok": false], exitCode: 1)
            reply.exitCode = 1
            reply.body["clientError"] = ["message": error.localizedDescription]
            reply.body["recovery"] = "Inspect `orc agent request \(operationID) --json` before retrying. Reuse the same request ID and arguments for an uncertain mutation."
            return finish(reply)
        }
    }

    private func rename(_ id: String, name: String) throws -> BundledCLIReply {
        let shown = try call(["orchestration", "worker-show", "--dispatch", id])
        guard shown.succeeded else { return shown }
        let observation = shown.result["observation"] as? [String: Any]
        let resource = shown.result["terminalResource"] as? [String: Any]
        guard observation?["exactWorker"] as? Bool == true,
              resource?["ownerDispatchId"] as? String == nil || resource?["ownerDispatchId"] as? String == id,
              let handle = (shown.result["worker"] as? [String: Any])?["agentTerminalHandle"] as? String else {
            throw OrcError("The runtime could not confirm the exact terminal still belongs to agent \(id). No terminal was renamed.")
        }
        var renamed = try call(["terminal", "rename", "--terminal", handle, "--title", name])
        if renamed.succeeded {
            let rename = renamed.result["rename"] as? [String: Any]
            if rename?["handle"] as? String != handle || rename?["title"] as? String != name {
                renamed.exitCode = 1
                renamed.body["warning"] = "The runtime did not confirm the requested terminal title."
            }
        }
        return renamed
    }

    static func runRequestID(_ id: String) -> String {
        var bytes = Array(SHA256.hash(data: Data((id.lowercased() + ":run").utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80
        let hex = bytes.map { String(format: "%02x", $0) }
        return [hex[0..<4], hex[4..<6], hex[6..<8], hex[8..<10], hex[10..<16]].map { $0.joined() }.joined(separator: "-")
    }
}
