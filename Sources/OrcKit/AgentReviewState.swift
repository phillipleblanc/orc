import Foundation

public struct AgentReviewState: Codable, Equatable {
    private struct Identity: Codable, Equatable {
        let incarnation: String?
        let agent: String?

        init(_ session: Session) {
            incarnation = session.incarnationId
            agent = session.agentIdentity
        }
    }

    private var idleTracker = AgentIdleTracker()
    private var unread: [String: Identity] = [:]

    public init() {}

    public var unreadKeys: Set<String> { Set(unread.keys) }

    public mutating func update(sessions: [Session], activities: [String: AgentActivity], pruneMissing: Bool = true) -> [Session] {
        let completed = idleTracker.update(sessions: sessions, activities: activities)
        for session in completed { unread[session.notesKey] = Identity(session) }
        let current = Dictionary(sessions.map { ($0.notesKey, Identity($0)) }, uniquingKeysWith: { first, _ in first })
        unread = unread.filter { key, identity in
            guard let currentIdentity = current[key] else { return !pruneMissing }
            return currentIdentity == identity
        }
        return completed
    }

    public mutating func resetCycles() { idleTracker.reset() }

    public mutating func markRead(_ session: Session) {
        guard unread[session.notesKey] == Identity(session) else { return }
        unread.removeValue(forKey: session.notesKey)
    }

    public func activity(for session: Session, base: AgentActivity) -> AgentActivity {
        base == .idle && unread[session.notesKey] == Identity(session) ? .unread : base
    }
}

public enum AgentReviewStore {
    public static var file: URL { Pairing.directory.appendingPathComponent("agent-review.json") }

    public static func load() throws -> AgentReviewState { try load(from: file) }

    static func load(from url: URL) throws -> AgentReviewState {
        guard FileManager.default.fileExists(atPath: url.path) else { return AgentReviewState() }
        return try JSONDecoder().decode(AgentReviewState.self, from: Data(contentsOf: url))
    }

    public static func save(_ state: AgentReviewState) throws { try save(state, to: file) }

    static func save(_ state: AgentReviewState, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(state).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
