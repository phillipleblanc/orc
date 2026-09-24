import Foundation

/// Tracks observed work cycles, fenced to the terminal process and agent.
/// Missing or uncertain activity clears the cycle so recovery cannot replay it.
public struct AgentIdleTracker: Codable, Equatable {
    private struct Identity: Codable, Equatable {
        let incarnation: String?
        let agent: String?
    }
    private var working: [String: Identity] = [:]

    public init() {}
    public mutating func reset() { working.removeAll() }

    public mutating func update(sessions: [Session], activities: [String: AgentActivity]) -> [Session] {
        var next: [String: Identity] = [:]
        var completed: [Session] = []
        for session in sessions where session.connected {
            let identity = Identity(incarnation: session.incarnationId, agent: session.agentIdentity)
            switch activities[session.handle] ?? .unknown {
            case .active:
                next[session.notesKey] = identity
            case .needsAttention:
                if working[session.notesKey] == identity { next[session.notesKey] = identity }
            case .idle:
                if working[session.notesKey] == identity { completed.append(session) }
            case .unread, .noAgent, .unknown, .offline:
                break
            }
        }
        working = next
        return completed
    }
}
