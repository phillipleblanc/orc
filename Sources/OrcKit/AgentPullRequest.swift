import Foundation

/// A pull request linked to an agent session, as the runtime's `agent.list` and `pr.list` report it: what Orc last saw
/// of it on GitHub, and what it told the agent.
public struct AgentPullRequest: Decodable, Equatable, Identifiable {
    public let repo: String
    public let number: Int
    public let url: URL
    public let title: String?
    /// When Orc last looked at it, and why that failed.
    public let checkedAt: Date?
    public let error: String?
    /// When the agent was last told about it.
    public let toldAt: Date?
    public let conflict: Bool
    /// Failing checks of its latest commit, apart from the ignored ones, and the ignored ones.
    public let failing: [String]
    public let ignoredFailing: [String]
    /// Checks still running, apart from the ignored ones.
    public let pending: Int
    /// Unresolved Copilot review threads.
    public let copilot: Int
    /// Checks that failed again after the agent was told about them twice, waiting on its person.
    public let handedOver: [String]

    public var id: String { "\(repo)#\(number)" }

    public init(repo: String, number: Int, url: URL, title: String? = nil, checkedAt: Date? = nil, error: String? = nil, toldAt: Date? = nil,
                conflict: Bool = false, failing: [String] = [], ignoredFailing: [String] = [], pending: Int = 0, copilot: Int = 0,
                handedOver: [String] = []) {
        self.repo = repo; self.number = number; self.url = url; self.title = title; self.checkedAt = checkedAt; self.error = error
        self.toldAt = toldAt; self.conflict = conflict; self.failing = failing; self.ignoredFailing = ignoredFailing; self.pending = pending
        self.copilot = copilot; self.handedOver = handedOver
    }

    enum CodingKeys: String, CodingKey { case repo, number, url, title, checkedAt, error, toldAt, conflict, failing, ignoredFailing, pending, copilot, handedOver }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let date = { (key: CodingKeys) in try container.decodeIfPresent(Double.self, forKey: key).map { Date(timeIntervalSince1970: $0 / 1000) } }
        repo = try container.decode(String.self, forKey: .repo)
        number = try container.decode(Int.self, forKey: .number)
        url = try container.decode(URL.self, forKey: .url)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        checkedAt = try date(.checkedAt)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        toldAt = try date(.toldAt)
        conflict = try container.decodeIfPresent(Bool.self, forKey: .conflict) ?? false
        failing = try container.decodeIfPresent([String].self, forKey: .failing) ?? []
        ignoredFailing = try container.decodeIfPresent([String].self, forKey: .ignoredFailing) ?? []
        pending = try container.decodeIfPresent(Int.self, forKey: .pending) ?? 0
        copilot = try container.decodeIfPresent(Int.self, forKey: .copilot) ?? 0
        handedOver = try container.decodeIfPresent([String].self, forKey: .handedOver) ?? []
    }

    /// What stands in its way, briefly, most pressing first; empty when its checks pass and nothing is unresolved.
    public var problems: [String] {
        var parts: [String] = []
        if conflict { parts.append("conflict") }
        if failing.count == 1 { parts.append("\(failing[0]) failed") } else if failing.count > 1 { parts.append("\(failing.count) checks failed") }
        if copilot > 0 { parts.append("\(copilot) Copilot comment\(copilot == 1 ? "" : "s")") }
        return parts
    }

    /// Its state in a few words: what stands in its way, or that its checks run or pass. Ignored checks are left out.
    public var summary: String {
        if checkedAt == nil { return error ?? "not checked yet" }
        let problems = self.problems
        if !problems.isEmpty { return problems.joined(separator: " · ") }
        return pending > 0 ? "\(pending) check\(pending == 1 ? "" : "s") running" : "checks pass"
    }

    /// The pull requests in a `pr.list` result, by agent name.
    public static func list(from result: [String: Any]) throws -> [String: [AgentPullRequest]] {
        let data = try JSONSerialization.data(withJSONObject: result["agents"] ?? [:])
        return try JSONDecoder().decode([String: [AgentPullRequest]].self, from: data)
    }
}
