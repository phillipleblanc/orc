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

    public var closedDate: Date? { parseTimestamp(closedAt) }

    /// How long ago the session closed, such as `5m ago`.
    public func age(now: Date = Date()) -> String { relativeAge(closedDate, now: now) }
}

/// A conversation from Codex, Claude or Pi's own history, which Orc can open in a new session.
public struct AgentConversation: Codable, Identifiable, Equatable, Sendable {
    public let agent: String
    public let id: String
    public let transcriptPath: String
    public let cwd: String
    public let title: String?
    public let firstPrompt: String?
    public let lastMessage: String?
    public let updatedAt: String
    public let project: String?
    /// The running session that has this conversation open.
    public let openIn: String?

    public var displayTitle: String { title ?? firstPrompt ?? id }
    public var updatedDate: Date? { parseTimestamp(updatedAt) }
    public func age(now: Date = Date()) -> String { relativeAge(updatedDate, now: now) }
}

/// The session a reopen started, or the running session that already had the conversation open.
public struct ReopenedSession: Equatable, Sendable {
    public let handle: String
    public let name: String
    public let alreadyOpen: Bool
}

func parseTimestamp(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value)
}

/// How long ago `date` was, such as `5m ago`.
public func relativeAge(_ date: Date?, now: Date = Date()) -> String {
    guard let date else { return "" }
    let seconds = max(0, Int(now.timeIntervalSince(date)))
    switch seconds {
    case ..<60: return "just now"
    case ..<3600: return "\(seconds / 60)m ago"
    case ..<86_400: return "\(seconds / 3600)h ago"
    default: return "\(seconds / 86_400)d ago"
    }
}

extension SessionService {
    public func closedSessions() async throws -> [ClosedSession] {
        try decode(await LocalRPC.call("history.list")["sessions"] ?? [])
    }

    /// Conversations whose words include every word of `query`, from registered projects unless `allProjects`.
    public func conversations(query: String = "", allProjects: Bool = false, limit: Int = 50) async throws -> [AgentConversation] {
        try decode(await LocalRPC.call("history.conversations", ["query": query, "allProjects": allProjects, "limit": limit])["conversations"] ?? [])
    }

    /// Starts a closed agent session again, resuming its conversation, under its own name or `newName`.
    /// A `name` that matches no closed session is tried as a conversation id or id prefix.
    public func reopen(entry: String? = nil, name: String? = nil, as newName: String? = nil) async throws -> ReopenedSession {
        var params: [String: Any] = [:]
        if let entry { params["entry"] = entry }
        if let name { params["name"] = name }
        return try await reopen(params, as: newName)
    }

    /// Opens a conversation in a new session in its folder, or returns the running session that has it open.
    public func open(conversation id: String, as newName: String? = nil) async throws -> ReopenedSession {
        try await reopen(["conversation": id], as: newName)
    }

    private func reopen(_ selector: [String: Any], as newName: String?) async throws -> ReopenedSession {
        var params = selector
        if let newName { params["as"] = try validatedName(newName) }
        let result = try await LocalRPC.call("history.reopen", params, timeout: 60)
        guard let handle = result["handle"] as? String, let name = result["name"] as? String else {
            throw OrcError("The runtime did not return the reopened session. Check `orc list` before retrying.")
        }
        return ReopenedSession(handle: handle, name: name, alreadyOpen: result["alreadyOpen"] as? Bool == true)
    }
}
