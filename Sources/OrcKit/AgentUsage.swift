import Foundation

/// An agent's subscription usage, as the runtime's `usage.read` reports it.
public struct AgentUsage: Decodable, Equatable, Identifiable {
    public enum Status: String, Decodable { case ok, error, unavailable }

    /// A rate-limit window: a session (five hours), the week, or the week on one model.
    public struct Window: Decodable, Equatable, Identifiable {
        public let kind: String
        public let label: String
        public let usedPercent: Double
        public let resetsAt: Date?
        public var id: String { label }

        public init(kind: String, label: String, usedPercent: Double, resetsAt: Date?) {
            self.kind = kind; self.label = label; self.usedPercent = usedPercent; self.resetsAt = resetsAt
        }
        enum CodingKeys: String, CodingKey { case kind, label, usedPercent, resetsAt }
        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            kind = try container.decode(String.self, forKey: .kind)
            label = try container.decode(String.self, forKey: .label)
            usedPercent = try container.decode(Double.self, forKey: .usedPercent)
            resetsAt = try container.decodeIfPresent(Double.self, forKey: .resetsAt).map { Date(timeIntervalSince1970: $0 / 1000) }
        }
    }

    public let provider: String
    public let name: String
    /// The subscription, such as "Max 5x" or "Pro".
    public let plan: String?
    public let windows: [Window]
    /// Codex's free rate-limit resets that can be redeemed.
    public let resetCredits: Int?
    public let status: Status
    /// Why the latest fetch failed, or why the agent's usage is unavailable.
    public let error: String?
    /// When `windows` were fetched.
    public let updatedAt: Date?
    public var id: String { provider }

    public init(provider: String, name: String, plan: String?, windows: [Window], resetCredits: Int? = nil,
                status: Status, error: String?, updatedAt: Date?) {
        self.provider = provider; self.name = name; self.plan = plan; self.windows = windows; self.resetCredits = resetCredits
        self.status = status; self.error = error; self.updatedAt = updatedAt
    }
    enum CodingKeys: String, CodingKey { case provider, name, plan, windows, resetCredits, status, error, updatedAt }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decode(String.self, forKey: .provider)
        name = try container.decode(String.self, forKey: .name)
        plan = try container.decodeIfPresent(String.self, forKey: .plan)
        windows = try container.decodeIfPresent([Window].self, forKey: .windows) ?? []
        resetCredits = try container.decodeIfPresent(Int.self, forKey: .resetCredits)
        status = try container.decode(Status.self, forKey: .status)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        updatedAt = try container.decodeIfPresent(Double.self, forKey: .updatedAt).map { Date(timeIntervalSince1970: $0 / 1000) }
    }

    /// The providers in a `usage.read` result.
    public static func list(from result: [String: Any]) throws -> [AgentUsage] {
        let data = try JSONSerialization.data(withJSONObject: result["providers"] ?? [])
        return try JSONDecoder().decode([AgentUsage].self, from: data)
    }

    /// The window closest to its limit.
    public var tightest: Window? { windows.max { $0.usedPercent < $1.usedPercent } }
}

/// How close a window is to its limit: worth noticing from 60 percent, urgent from 80.
public enum UsageLevel: Equatable {
    case normal, high, critical
    public init(usedPercent: Double) {
        self = usedPercent >= 80 ? .critical : usedPercent >= 60 ? .high : .normal
    }
}

/// A length of time, coarsely: "now", "<1m", "45m", "2h 13m", "3d 4h".
public func formatDuration(_ interval: TimeInterval) -> String {
    guard interval > 0 else { return "now" }
    let minutes = Int(interval / 60)
    if minutes < 1 { return "<1m" }
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60, remainder = minutes % 60
    if hours >= 24 {
        let days = hours / 24, hoursLeft = hours % 24
        return hoursLeft > 0 ? "\(days)d \(hoursLeft)h" : "\(days)d"
    }
    return remainder > 0 ? "\(hours)h \(remainder)m" : "\(hours)h"
}
