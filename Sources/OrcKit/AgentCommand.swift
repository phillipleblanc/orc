import Foundation

public struct AgentCommand {
    public enum Action: String { case spawn, send, stop, release, show, request, rename, list }
    public let action: Action
    public let target: String
    public let options: [String: String]
    public let json: Bool
    public var requestID: String { options["request-id"] ?? generatedRequestID }
    private let generatedRequestID = UUID().uuidString.lowercased()

    public init(_ arguments: [String]) throws {
        guard let first = arguments.first, let action = Action(rawValue: first) else {
            throw OrcError("Use `orc agent spawn|send|stop|release|show|request|rename|list`. Run `orc agent --help` for details.")
        }
        var positional: [String] = [], options: [String: String] = [:], json = false
        var index = 1
        let allowed: Set<String>
        switch action {
        case .spawn: allowed = ["name", "project", "prompt-file", "from", "model", "effort", "request-id", "retry-of", "timeout-seconds"]
        case .send: allowed = ["prompt-file", "subject", "from", "request-id"]
        case .stop, .release: allowed = ["request-id"]
        case .rename: allowed = ["name"]
        case .show, .request: allowed = []
        case .list: allowed = ["run", "cursor"]
        }
        while index < arguments.count {
            let value = arguments[index]
            if value == "--json" {
                guard !json else { throw OrcError("Duplicate --json.") }
                json = true; index += 1
            } else if value.hasPrefix("--") {
                let key = String(value.dropFirst(2))
                guard allowed.contains(key) else { throw OrcError("Unknown option \(value) for agent \(action.rawValue).") }
                guard options[key] == nil else { throw OrcError("Duplicate \(value).") }
                guard index + 1 < arguments.count, !arguments[index + 1].hasPrefix("--"), !arguments[index + 1].isEmpty else {
                    throw OrcError("Missing value after \(value).")
                }
                options[key] = arguments[index + 1]; index += 2
            } else { positional.append(value); index += 1 }
        }
        guard (action == .list && positional.isEmpty) || (action != .list && positional.count == 1 && !positional[0].hasPrefix("-")) else {
            throw OrcError("Agent \(action.rawValue) requires exactly one \(action == .spawn ? "agent type" : "ID").")
        }
        if action == .spawn {
            guard ["pi", "codex", "claude"].contains(positional[0]) else { throw OrcError("Choose pi, codex, or claude.") }
            guard options["name"] != nil else { throw OrcError("Agent spawn requires --name.") }
            if positional[0] == "pi", options["model"] != nil || options["effort"] != nil {
                throw OrcError("Pi uses its own configured model and thinking level; omit --model and --effort.")
            }
            if options["effort"] != nil, options["model"] == nil { throw OrcError("--effort requires --model.") }
            if let seconds = options["timeout-seconds"], Int(seconds).map({ (1...600).contains($0) }) != true {
                throw OrcError("--timeout-seconds must be an integer from 1 to 600.")
            }
            if options["retry-of"] != nil, options["prompt-file"] != nil {
                throw OrcError("--retry-of reuses the original task brief; omit --prompt-file.")
            }
        }
        if action == .send || (action == .spawn && options["retry-of"] == nil) {
            guard options["prompt-file"] != nil else { throw OrcError("Agent \(action.rawValue) requires --prompt-file.") }
        }
        if action == .rename, options["name"] == nil { throw OrcError("Agent rename requires --name.") }
        if let name = options["name"] {
            guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.utf8.count <= 200,
                  !name.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
                throw OrcError("Choose a name of 1–200 bytes without control characters.")
            }
        }
        if let id = options["request-id"], UUID(uuidString: id) == nil { throw OrcError("--request-id must be a UUID.") }
        if action == .request, UUID(uuidString: positional[0]) == nil { throw OrcError("Agent request requires a request UUID.") }
        self.action = action; self.target = positional.first ?? ""; self.options = options; self.json = json
    }

    public func prompt() throws -> String? {
        guard let path = options["prompt-file"] else { return nil }
        let file = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
        defer { try? file.close() }
        let bytes = try file.read(upToCount: 65_537) ?? Data()
        guard bytes.count <= 65_536, let text = String(data: bytes, encoding: .utf8),
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !text.contains("\0") else {
            throw OrcError("The prompt file must contain nonempty UTF-8 text, at most 64 KiB, without NUL bytes.")
        }
        return text
    }

    public static let help = """
    orc agent spawn pi|codex|claude --name NAME --prompt-file FILE
        [--project SELECTOR] [--from OWN_HANDLE] [--model MODEL --effort EFFORT]
        [--timeout-seconds SECONDS] [--request-id UUID] [--json]
    orc agent spawn TYPE --name NAME --retry-of AGENT_ID [--project SELECTOR] [--json]
    orc agent send AGENT_ID --prompt-file FILE [--subject SUBJECT] [--from OWN_HANDLE]
        [--request-id UUID] [--json]
    orc agent stop AGENT_ID [--request-id UUID] [--json]
    orc agent release AGENT_ID [--request-id UUID] [--json]
    orc agent list [--run RUN_ID] [--cursor CURSOR] [--json]
    orc agent show AGENT_ID [--json]
    orc agent request REQUEST_UUID [--json]
    orc agent rename AGENT_ID --name NAME [--json]

    An agent ID is its Dispatch ID. Spawn reuses your bound Run or creates one,
    creates the Task, delivers the brief, checks readiness, and names the terminal.
    Spawn/send require your own live coordinator terminal; --from never transfers ownership.
    Pi uses its configured model and thinking level. Project defaults match `orc new`.
    Stop targets that Dispatch's worker; release asks the runtime to clean settled resources.
    Commands print JSON receipts. List reports its Run scope and pagination cursor.
    Failed/uncertain calls preserve receipts and exit nonzero. Inspect with show/request first.
    Reuse --request-id with identical arguments to recover an uncertain request.
    --retry-of starts a new attempt only when the runtime permits retry of the original Task.
    """
}
