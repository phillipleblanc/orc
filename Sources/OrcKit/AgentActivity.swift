import Foundation

public enum AgentActivity: Equatable, Sendable {
    case idle, active, needsAttention, noAgent, unknown, offline

    public init(isRunningAgent: Bool?, state: String?) {
        guard let isRunningAgent else { self = .unknown; return }
        guard isRunningAgent else { self = .noAgent; return }
        switch state {
        case "idle", "done": self = .idle
        case "working": self = .active
        case "permission", "blocked", "waiting": self = .needsAttention
        default: self = .unknown
        }
    }

    public var label: String {
        switch self {
        case .idle: return "Idle"
        case .active: return "Active"
        case .needsAttention: return "Needs attention"
        case .noAgent: return "No agent running"
        case .unknown: return "Activity unavailable"
        case .offline: return "Offline"
        }
    }
}

extension SessionService {
    public func activities(for sessions: [Session]) async -> [String: AgentActivity] {
        await withTaskGroup(of: (String, AgentActivity).self) { group in
            var result: [String: AgentActivity] = [:]
            // Bound foreground-process queries even when the inventory is large.
            var pending = sessions.makeIterator()
            func enqueue(_ session: Session) {
                group.addTask {
                    guard session.connected else { return (session.handle, .offline) }
                    guard let response = try? await LocalRPC.call("terminal.agentStatus", ["terminal": session.handle], timeout: 3),
                          let status = response["agentStatus"] as? [String: Any],
                          status["handle"] as? String == session.handle else { return (session.handle, .unknown) }
                    return (session.handle, AgentActivity(isRunningAgent: status["isRunningAgent"] as? Bool,
                                                         state: status["status"] as? String))
                }
            }
            for _ in 0..<8 { if let session = pending.next() { enqueue(session) } }
            for await (handle, activity) in group {
                result[handle] = activity
                if let session = pending.next(), !Task.isCancelled { enqueue(session) }
            }
            return result
        }
    }
}
