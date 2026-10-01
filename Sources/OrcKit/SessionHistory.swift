import Foundation

/// An agent session that ended in the last week and can resume its conversation.
public struct ClosedSession: Codable, Identifiable, Equatable, Sendable {
    public let entry: String
    public let name: String
    public let agent: String
    public let cwd: String
    public let project: String?
    public let closedAt: String
    public let lastMessage: String?
    public let screen: [String]
    public var id: String { entry }

    public var closedDate: Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: closedAt)
    }

    /// How long ago the session closed, such as `5m ago`.
    public func age(now: Date = Date()) -> String {
        guard let closedDate else { return "" }
        let seconds = max(0, Int(now.timeIntervalSince(closedDate)))
        switch seconds {
        case ..<60: return "just now"
        case ..<3600: return "\(seconds / 60)m ago"
        case ..<86_400: return "\(seconds / 3600)h ago"
        default: return "\(seconds / 86_400)d ago"
        }
    }
}

extension SessionService {
    public func closedSessions() async throws -> [ClosedSession] {
        try decode(await LocalRPC.call("history.list")["sessions"] ?? [])
    }

    /// Starts a closed agent session again, resuming its conversation, under its own name or `newName`.
    public func reopen(entry: String? = nil, name: String? = nil, as newName: String? = nil) async throws -> (handle: String, name: String) {
        var params: [String: Any] = [:]
        if let entry { params["entry"] = entry }
        if let name { params["name"] = name }
        if let newName { params["as"] = try validatedName(newName) }
        let result = try await LocalRPC.call("history.reopen", params, timeout: 60)
        guard let handle = result["handle"] as? String, let reopened = result["name"] as? String else {
            throw OrcError("The runtime did not return the reopened session. Check `orc list` before retrying.")
        }
        return (handle, reopened)
    }
}
