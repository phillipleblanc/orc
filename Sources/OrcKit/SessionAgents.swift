import Foundation
import Darwin

/// Agent commands for runtimes that advertise `orc.agents.v1`: agents are sessions addressed by name.
public struct SessionAgentCommand {
    public enum Action: String { case spawn, send, list, status, wait, stop }
    public let action: Action
    public let agent: String?
    public let name: String?
    public let options: [String: String]
    public let kill: Bool
    public let whenIdle: Bool
    public let json: Bool

    public init(_ arguments: [String]) throws {
        guard let first = arguments.first, let action = Action(rawValue: first) else {
            throw OrcError("Use `orc agent spawn|send|list|status|wait|stop`. Run `orc agent --help` for details.")
        }
        let allowed: Set<String>
        switch action {
        case .spawn: allowed = ["name", "project", "prompt-file", "model", "effort", "timeout-seconds"]
        case .send: allowed = ["file", "prompt-file"]
        case .wait: allowed = ["timeout-seconds"]
        case .list, .status, .stop: allowed = []
        }
        var positional: [String] = [], options: [String: String] = [:], json = false, kill = false, whenIdle = false
        var index = 1
        while index < arguments.count {
            let value = arguments[index]
            if value == "--json" { json = true; index += 1; continue }
            if value == "--kill", action == .stop { kill = true; index += 1; continue }
            if value == "--when-idle", action == .send { whenIdle = true; index += 1; continue }
            if value.hasPrefix("--") {
                let key = String(value.dropFirst(2))
                guard allowed.contains(key) else { throw OrcError("Unknown option \(value) for agent \(action.rawValue).") }
                guard options[key] == nil else { throw OrcError("Duplicate \(value).") }
                guard index + 1 < arguments.count, !arguments[index + 1].isEmpty else { throw OrcError("Missing value after \(value).") }
                options[key] = arguments[index + 1]; index += 2
            } else { positional.append(value); index += 1 }
        }
        var agent: String?, name = options["name"]
        switch action {
        case .spawn:
            guard let kind = positional.first, ["codex", "claude", "pi"].contains(kind) else { throw OrcError("Choose codex, claude or pi.") }
            agent = kind
            if positional.count == 2 { guard name == nil else { throw OrcError("Give the name once.") }; name = positional[1] }
            guard positional.count <= 2, name != nil else { throw OrcError("Usage: orc agent spawn codex|claude|pi NAME [--prompt-file FILE]") }
        case .list:
            guard positional.isEmpty else { throw OrcError("Usage: orc agent list [--json]") }
        case .send, .status, .wait, .stop:
            guard positional.count == 1 else { throw OrcError("Agent \(action.rawValue) takes one agent name.") }
            name = positional[0]
        }
        if let seconds = options["timeout-seconds"], Int(seconds).map({ (1...3600).contains($0) }) != true {
            throw OrcError("--timeout-seconds must be an integer from 1 to 3600.")
        }
        self.action = action; self.agent = agent; self.name = name; self.options = options; self.kill = kill; self.whenIdle = whenIdle; self.json = json
    }

    /// Text from `--prompt-file`/`--file`, or from standard input when it is not a terminal.
    func text(required: Bool) throws -> String? {
        let data: Data
        if let path = options["prompt-file"] ?? options["file"] {
            let file = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
            defer { try? file.close() }
            data = try file.read(upToCount: 262_145) ?? Data()
        } else if isatty(STDIN_FILENO) == 0 {
            data = FileHandle.standardInput.readData(ofLength: 262_145)
        } else if required {
            throw OrcError("Give the message with --file FILE or on standard input.")
        } else { return nil }
        guard data.count <= 262_144, let text = String(data: data, encoding: .utf8), !text.contains("\0") else {
            throw OrcError("Text must be UTF-8, at most 256 KiB, without NUL bytes.")
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { if required { throw OrcError("The message is empty.") }; return nil }
        return text
    }

    public static let help = """
    orc agent spawn codex|claude|pi NAME [--project SELECTOR] [--prompt-file FILE]
        [--model MODEL] [--effort LEVEL] [--timeout-seconds SECONDS] [--json]
    orc agent send NAME [--file FILE] [--when-idle] [--json]
    orc agent list [--json]
    orc agent status NAME [--json]
    orc agent wait NAME [--timeout-seconds SECONDS] [--json]
    orc agent stop NAME [--kill] [--json]

    An agent is a session, and its name is its identity. Spawn starts the agent in --project (or
    the current directory), waits until it is ready and types the prompt exactly as given; without
    --prompt-file, a prompt piped on standard input is used. Send types a message that begins with
    a line naming the sender. A working agent reads it at its next step, after the tool call it is
    running; an idle agent starts a turn with it. With --when-idle, the message waits until the
    agent is idle and starts a turn of its own. Messages wait while the agent is at a permission
    prompt or dialog. Wait returns once the agent has finished working on everything sent to it.
    Stop interrupts the current turn and drops queued messages; --kill ends the session.
    """
}

public enum SessionAgentService {
    /// Runs the command and returns its result and whether it fully succeeded.
    public static func execute(_ command: SessionAgentCommand, environment: [String: String] = ProcessInfo.processInfo.environment) async throws -> (body: [String: Any], succeeded: Bool) {
        let caller = environment["ORC_SESSION_NAME"].flatMap { $0.isEmpty ? nil : $0 }
        let timeout = Int(command.options["timeout-seconds"] ?? "") ?? (command.action == .wait ? 600 : 120)
        switch command.action {
        case .spawn:
            var params: [String: Any] = ["agent": command.agent!, "name": command.name!, "timeoutMs": timeout * 1000]
            if let selector = command.options["project"] {
                params["project"] = "id:" + (try SessionCreationDefaults.project(selector, in: await SessionService().workspaces()).id)
            } else {
                params["cwd"] = FileManager.default.currentDirectoryPath
            }
            if let prompt = try command.text(required: false) { params["prompt"] = prompt }
            if let caller { params["parent"] = caller }
            if let model = command.options["model"] { params["model"] = model }
            if let effort = command.options["effort"] { params["effort"] = effort }
            let result = try await LocalRPC.call("agent.spawn", params, timeout: timeout + 30)
            return (result, params["prompt"] == nil || result["delivered"] as? Bool == true)
        case .send:
            let text = try command.text(required: true)!
            let result = try await LocalRPC.call("agent.send", ["to": command.name!, "text": text, "from": caller ?? NSUserName(), "whenIdle": command.whenIdle])
            return (result, true)
        case .list:
            return (try await LocalRPC.call("agent.list"), true)
        case .status:
            return (try await LocalRPC.call("agent.status", ["name": command.name!]), true)
        case .stop:
            return (try await LocalRPC.call("agent.stop", ["name": command.name!, "kill": command.kill], timeout: 30), true)
        case .wait:
            let deadline = Date().addingTimeInterval(TimeInterval(timeout))
            while true {
                let remaining = max(1, Int(deadline.timeIntervalSinceNow * 1000))
                let result = try await LocalRPC.call("agent.wait", ["name": command.name!, "timeoutMs": min(remaining, 25_000)], timeout: 40)
                if result["done"] as? Bool == true || Date() >= deadline { return (result, result["done"] as? Bool == true) }
            }
        }
    }

    /// A short human-readable rendering of a result.
    public static func describe(_ command: SessionAgentCommand, _ body: [String: Any]) -> String {
        func line(_ agent: [String: Any]) -> String {
            let name = agent["name"] as? String ?? "?", kind = agent["agent"] as? String ?? "?", state = agent["state"] as? String ?? "?"
            var parts = ["\(name)", kind, state]
            if let queued = agent["queued"] as? Int, queued > 0 { parts.append("\(queued) queued") }
            if let parent = agent["parent"] as? String { parts.append("from \(parent)") }
            if let dialog = agent["dialog"] as? String { parts.append("waiting at: \(dialog)") }
            return parts.joined(separator: "  ")
        }
        switch command.action {
        case .list:
            let agents = body["agents"] as? [[String: Any]] ?? []
            return agents.isEmpty ? "No agents." : agents.map(line).joined(separator: "\n")
        case .spawn:
            let delivered = body["delivered"] as? Bool == true
            return line(body) + (body["delivered"] == nil ? "" : delivered ? "\nPrompt delivered." : "\nPrompt queued; the agent is not ready yet.")
        case .send:
            return line(body) + (body["delivered"] as? Bool == true ? "\nMessage sent." : "\nMessage queued.")
        case .wait:
            return line(body) + (body["done"] as? Bool == true ? "" : "\nTimed out before the agent finished.")
        case .status, .stop:
            var text = line(body)
            if let message = body["lastAssistantMessage"] as? String { text += "\n\n" + message }
            return text
        }
    }
}
