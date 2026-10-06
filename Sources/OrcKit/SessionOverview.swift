import Foundation

/// An agent session as the runtime's `agent.list` reports it.
public struct AgentSummary: Decodable, Equatable {
    /// A scheduled wake: a timer with its due time, or a process or script the agent waits on.
    public struct Wake: Decodable, Equatable {
        public let kind: String
        public let dueAt: Date?
        public init(kind: String, dueAt: Date?) { self.kind = kind; self.dueAt = dueAt }
        enum CodingKeys: String, CodingKey { case kind, dueAt }
        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            kind = try container.decode(String.self, forKey: .kind)
            dueAt = try container.decodeIfPresent(Double.self, forKey: .dueAt).map { Date(timeIntervalSince1970: $0 / 1000) }
        }
    }

    public let name: String
    public let agent: String
    public let state: String
    /// The agent session that spawned it.
    public let parent: String?
    /// Messages waiting to be typed.
    public let queued: Int
    /// When the agent entered `state`.
    public let since: Date?
    public let wakes: [Wake]
    /// The pull requests Orc watches for it.
    public let pullRequests: [AgentPullRequest]

    public init(name: String, agent: String, state: String, parent: String? = nil, queued: Int = 0, since: Date? = nil, wakes: [Wake] = [],
                pullRequests: [AgentPullRequest] = []) {
        self.name = name; self.agent = agent; self.state = state; self.parent = parent; self.queued = queued; self.since = since; self.wakes = wakes
        self.pullRequests = pullRequests
    }
    enum CodingKeys: String, CodingKey { case name, agent, state, parent, queued, since, wakes, pullRequests }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        agent = try container.decode(String.self, forKey: .agent)
        state = try container.decode(String.self, forKey: .state)
        parent = try container.decodeIfPresent(String.self, forKey: .parent)
        queued = try container.decodeIfPresent(Int.self, forKey: .queued) ?? 0
        since = try container.decodeIfPresent(Double.self, forKey: .since).map { Date(timeIntervalSince1970: $0 / 1000) }
        wakes = try container.decodeIfPresent([Wake].self, forKey: .wakes) ?? []
        pullRequests = try container.decodeIfPresent([AgentPullRequest].self, forKey: .pullRequests) ?? []
    }

    /// The agents in an `agent.list` result, by name.
    public static func list(from result: [String: Any]) throws -> [String: AgentSummary] {
        let data = try JSONSerialization.data(withJSONObject: result["agents"] ?? [])
        return Dictionary(try JSONDecoder().decode([AgentSummary].self, from: data).map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// The soonest timer wake, else any other wake.
    public var nextWake: Wake? {
        wakes.filter { $0.dueAt != nil }.min { $0.dueAt! < $1.dueAt! } ?? wakes.first
    }
}

/// Where a session stands in the overview: waiting on its person, working, or neither.
public enum OverviewLane: Int, CaseIterable, Comparable {
    case needsYou, working, idle
    public var title: String {
        switch self {
        case .needsYou: return "Needs You"
        case .working: return "Working"
        case .idle: return "Idle"
        }
    }
    public static func < (left: Self, right: Self) -> Bool { left.rawValue < right.rawValue }
}

/// One session in the overview, with what Orc knows about it.
public struct OverviewItem: Identifiable, Equatable {
    public let session: Session
    public let activity: AgentActivity
    public let agent: AgentSummary?
    public let brief: AgentBrief?
    /// When its person last marked it read.
    public let acknowledged: Date?
    public var id: String { session.id }

    public init(session: Session, activity: AgentActivity, agent: AgentSummary?, brief: AgentBrief?, acknowledged: Date? = nil) {
        self.session = session; self.activity = activity; self.agent = agent; self.brief = brief; self.acknowledged = acknowledged
    }

    /// What its brief says the agent waits on from its person, when the brief was written after the agent's last change
    /// of state, so an answered question does not linger, and after its person last marked it read.
    public var needsYou: String? {
        guard let question = brief?.brief?.needsYou, activity != .active else { return nil }
        guard let written = brief?.generatedAt else { return question }
        if let acknowledged, acknowledged >= written { return nil }
        if let since = agent?.since, written < since { return nil }
        return question
    }

    /// Checks of its pull requests that failed again after the agent was told, for its person to decide on.
    public var handedOver: [(pullRequest: AgentPullRequest, check: String)] {
        (agent?.pullRequests ?? []).flatMap { pullRequest in pullRequest.handedOver.map { (pullRequest, $0) } }
    }

    public var lane: OverviewLane {
        if !handedOver.isEmpty { return .needsYou }
        switch activity {
        case .needsAttention, .unread: return .needsYou
        case .active: return .working
        default: return needsYou == nil ? .idle : .needsYou
        }
    }
}

/// A session with the sessions under it: the agents it spawned, and its named children.
public struct OverviewFamily: Identifiable, Equatable {
    public let head: OverviewItem
    public let members: [OverviewItem]
    public var id: String { head.id }
    /// The most urgent lane of the family.
    public var lane: OverviewLane { ([head] + members).map(\.lane).min()! }
    public var items: [OverviewItem] { [head] + members }
}

public enum SessionOverview {
    /// Families in lanes: each session under the root of the sessions that spawned it (or its named parent), each
    /// family in its most urgent member's lane. Within a lane, families that have waited or worked longest come first,
    /// and among idle ones the most recently idle.
    public static func arrange(sessions: [Session], activities: [String: AgentActivity], agents: [String: AgentSummary],
                               briefs: [String: AgentBrief], hierarchy: SessionHierarchy,
                               acknowledged: [String: Date] = [:]) -> [(lane: OverviewLane, families: [OverviewFamily])] {
        let byName = Dictionary(sessions.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        func parent(of session: Session) -> Session? {
            if let spawner = agents[session.name]?.parent, let found = byName[spawner], found.name != session.name { return found }
            return hierarchy.parent(of: session)
        }
        func root(of session: Session) -> Session {
            var current = session, seen: Set<String> = [session.name]
            while let up = parent(of: current), seen.insert(up.name).inserted { current = up }
            return current
        }
        let items = Dictionary(sessions.map { session in
            (session.name, OverviewItem(session: session, activity: activities[session.handle] ?? .unknown, agent: agents[session.name],
                                        brief: briefs[session.name], acknowledged: acknowledged[session.name]))
        }, uniquingKeysWith: { first, _ in first })
        var membersByRoot: [String: [OverviewItem]] = [:], roots: [String] = []
        for session in sessions {
            let top = root(of: session).name
            if top == session.name { roots.append(top) } else { membersByRoot[top, default: []].append(items[session.name]!) }
        }
        let since = { (item: OverviewItem) in item.agent?.since ?? .distantPast }
        let families = roots.map { name in
            OverviewFamily(head: items[name]!, members: (membersByRoot[name] ?? []).sorted { ($0.lane, since($0)) < ($1.lane, since($1)) })
        }
        return OverviewLane.allCases.compactMap { lane in
            let inLane = families.filter { $0.lane == lane }.sorted { left, right in
                let a = left.items.filter { $0.lane == lane }.map(since).min() ?? .distantPast
                let b = right.items.filter { $0.lane == lane }.map(since).min() ?? .distantPast
                return lane == .idle ? a > b : a < b
            }
            return inLane.isEmpty ? nil : (lane, inLane)
        }
    }
}
