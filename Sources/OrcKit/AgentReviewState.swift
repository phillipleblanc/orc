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
    /// Sessions that sent `orc notify` since they were last viewed.
    private var notified: [String: Identity] = [:]

    public init() {}

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        idleTracker = try container.decode(AgentIdleTracker.self, forKey: .idleTracker)
        unread = try container.decode([String: Identity].self, forKey: .unread)
        notified = try container.decodeIfPresent([String: Identity].self, forKey: .notified) ?? [:]
    }

    /// Sessions with something to review: a finished turn, or a notification.
    public var unreadKeys: Set<String> { Set(unread.keys).union(notified.keys) }

    public mutating func update(sessions: [Session], activities: [String: AgentActivity], pruneMissing: Bool = true) -> [Session] {
        let completed = idleTracker.update(sessions: sessions, activities: activities)
        for session in completed { unread[session.handle] = Identity(session) }
        let current = Dictionary(sessions.map { ($0.handle, Identity($0)) }, uniquingKeysWith: { first, _ in first })
        let kept: (String, Identity) -> Bool = { key, identity in
            guard let currentIdentity = current[key] else { return !pruneMissing }
            return currentIdentity == identity
        }
        unread = unread.filter(kept)
        notified = notified.filter(kept)
        return completed
    }

    /// The session sent a notification; it shows until the session is viewed, whether or not it is muted.
    public mutating func markNotified(_ session: Session) {
        notified[session.handle] = Identity(session)
    }

    public mutating func resetCycles() { idleTracker.reset() }

    public mutating func markRead(_ session: Session) {
        if unread[session.handle] == Identity(session) { unread.removeValue(forKey: session.handle) }
        if notified[session.handle] == Identity(session) { notified.removeValue(forKey: session.handle) }
    }

    /// A notification shows over working and idle; a prompt waiting for an answer, or an offline session, shows as such.
    public func activity(for session: Session, base: AgentActivity) -> AgentActivity {
        if notified[session.handle] == Identity(session), base != .needsAttention, base != .offline { return .notified }
        return base == .idle && unread[session.handle] == Identity(session) ? .unread : base
    }
}

public enum AgentReviewStore {
    public static var file: URL { RuntimeHost.current.stateDirectory.appendingPathComponent("agent-review.json") }

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
