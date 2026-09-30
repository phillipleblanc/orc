import Foundation

/// `orc wake`: the agent session running the command asks to be sent a message later.
public struct SessionWakeCommand {
    public enum Condition: Equatable {
        case after(milliseconds: Int)
        case pid(Int)
        case script(path: String, cwd: String)
    }
    public enum Action: Equatable { case create(Condition, message: String), list, cancel(String) }
    public let action: Action
    public let json: Bool

    public init(_ arguments: [String], currentDirectory: String = FileManager.default.currentDirectoryPath) throws {
        let words = arguments.filter { $0 != "--json" }
        json = words.count != arguments.count
        guard let first = words.first else { throw OrcError("Usage: orc wake DURATION|pid PID|SCRIPT [MESSAGE]. Run `orc wake --help` for details.") }
        let message = words.dropFirst(first == "pid" ? 2 : 1).joined(separator: " ")
        switch first {
        case "list":
            guard words.count == 1 else { throw OrcError("Usage: orc wake list [--json]") }
            action = .list
        case "cancel":
            guard words.count == 2, !words[1].isEmpty else { throw OrcError("Usage: orc wake cancel ID [--json]") }
            action = .cancel(words[1])
        case "pid":
            guard words.count >= 2, let pid = Int(words[1]), pid > 0 else { throw OrcError("Usage: orc wake pid PID [MESSAGE]") }
            action = .create(.pid(pid), message: message)
        default:
            if let milliseconds = Self.milliseconds(first) {
                action = .create(.after(milliseconds: milliseconds), message: message)
                break
            }
            let path = URL(fileURLWithPath: first, relativeTo: URL(fileURLWithPath: currentDirectory, isDirectory: true)).standardizedFileURL.path
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
                throw OrcError("'\(first)' is not a duration (such as 90s, 30m or 1h30m), `pid PID`, or a script file.")
            }
            action = .create(.script(path: path, cwd: currentDirectory), message: message)
        }
    }

    /// Milliseconds in a duration such as `90s`, `30m`, `1h30m` or `1.5d`, which may not exceed 365 days.
    public static func milliseconds(_ text: String) -> Int? {
        let units: [String: Double] = ["ms": 1, "s": 1000, "m": 60_000, "h": 3_600_000, "d": 86_400_000]
        guard let pattern = try? NSRegularExpression(pattern: #"(\d+(?:\.\d+)?)(ms|s|m|h|d)"#) else { return nil }
        let text = text.lowercased() as NSString
        var total = 0.0, end = 0
        for match in pattern.matches(in: text as String, range: NSRange(location: 0, length: text.length)) {
            guard match.range.location == end, let amount = Double(text.substring(with: match.range(at: 1))) else { return nil }
            total += amount * units[text.substring(with: match.range(at: 2))]!
            end = match.range.location + match.range.length
        }
        guard end > 0, end == text.length, total > 0, total <= 365 * 86_400_000 else { return nil }
        return Int(total.rounded(.up))
    }

    public static let help = """
    orc wake DURATION [MESSAGE]     After DURATION, such as 90s, 30m or 1h30m
    orc wake pid PID [MESSAGE]      When process PID exits
    orc wake SCRIPT [MESSAGE]       Run SCRIPT in the background now; wake when it exits
    orc wake list [--json]
    orc wake cancel ID [--json]     ID may be the first characters of a wake's id

    A wake sends the agent session that set it a message, queued like any other and beginning with
    [from wake]. A timer's message defaults to "continue". A process or script wake adds the exit
    status, and a script wake adds the end of the script's output. SCRIPT runs in the current
    directory with the session's environment, with bash when it is not executable. Wakes survive
    runtime restarts; ending the session removes its wakes and stops their scripts.
    """
}

public enum SessionWakeService {
    public static func execute(_ command: SessionWakeCommand, environment: [String: String] = ProcessInfo.processInfo.environment) async throws -> [String: Any] {
        guard let name = environment["ORC_SESSION_NAME"], !name.isEmpty else {
            throw OrcError("orc wake works only inside an Orc agent session, which it wakes.")
        }
        switch command.action {
        case .list:
            return try await LocalRPC.call("wake.list", ["name": name])
        case .cancel(let id):
            return try await LocalRPC.call("wake.cancel", ["name": name, "id": id])
        case .create(let condition, let message):
            var params: [String: Any] = ["name": name, "message": message]
            switch condition {
            case .after(let milliseconds): params["kind"] = "timer"; params["delayMs"] = milliseconds
            case .pid(let pid): params["kind"] = "pid"; params["pid"] = pid
            case .script(let path, let cwd): params["kind"] = "script"; params["script"] = path; params["cwd"] = cwd
            }
            return try await LocalRPC.call("wake.create", params)
        }
    }

    /// A short human-readable rendering of a result.
    public static func describe(_ command: SessionWakeCommand, _ body: [String: Any], now: Date = Date()) -> String {
        func line(_ wake: [String: Any]) -> String {
            var parts = [String((wake["id"] as? String ?? "?").prefix(8)), condition(wake)]
            if let message = wake["message"] as? String, !message.isEmpty {
                parts.append(message.split(whereSeparator: \.isNewline).joined(separator: " "))
            }
            return parts.joined(separator: "  ")
        }
        func condition(_ wake: [String: Any]) -> String {
            switch wake["kind"] as? String {
            case "timer":
                let due = Date(timeIntervalSince1970: ((wake["dueAt"] as? NSNumber)?.doubleValue ?? 0) / 1000)
                let dateStyle: DateFormatter.Style = due.timeIntervalSince(now) < 86_400 ? .none : .short
                return "in \(duration(due.timeIntervalSince(now))) (\(DateFormatter.localizedString(from: due, dateStyle: dateStyle, timeStyle: .short)))"
            case "pid":
                return "when pid \((wake["pid"] as? NSNumber)?.intValue ?? 0) exits (\(wake["command"] as? String ?? "?"))"
            case "script":
                return "when \(wake["script"] as? String ?? "?") exits"
            default:
                return "?"
            }
        }
        switch command.action {
        case .list:
            let wakes = body["wakes"] as? [[String: Any]] ?? []
            return wakes.isEmpty ? "No wakes." : wakes.map(line).joined(separator: "\n")
        case .create:
            return "Wake " + line(body)
        case .cancel:
            return "Cancelled " + line(body)
        }
    }

    static func duration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded()))
        let parts = [(total / 86_400, "d"), (total % 86_400 / 3600, "h"), (total % 3600 / 60, "m"), (total % 60, "s")]
        let shown = parts.drop { $0.0 == 0 }.prefix(2).filter { $0.0 > 0 }
        return shown.isEmpty ? "0s" : shown.map { "\($0.0)\($0.1)" }.joined()
    }
}
