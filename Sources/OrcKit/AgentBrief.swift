import Foundation

/// Where an agent session's work stands, as the runtime's `brief.*` methods report it: written by a model from the
/// agent's transcript, never by asking the agent.
public struct AgentBrief: Decodable, Equatable {
    public struct Content: Decodable, Equatable {
        /// At most about eight words: what the agent is doing or waiting on.
        public let headline: String
        public let goal: String
        public let progress: [String]
        public let now: String
        public let next: [String]
        /// A decision or answer the agent waits on from the person running it.
        public let needsYou: String?

        public init(headline: String, goal: String, progress: [String], now: String, next: [String], needsYou: String?) {
            self.headline = headline; self.goal = goal; self.progress = progress; self.now = now; self.next = next; self.needsYou = needsYou
        }
    }

    public let name: String
    public let brief: Content?
    /// When `brief` was written.
    public let generatedAt: Date?
    /// The model that wrote it, as `provider/id`.
    public let model: String?
    /// Why the latest attempt failed.
    public let error: String?
    /// Whether a brief is being written now.
    public let generating: Bool

    public init(name: String, brief: Content?, generatedAt: Date?, model: String?, error: String?, generating: Bool) {
        self.name = name; self.brief = brief; self.generatedAt = generatedAt; self.model = model; self.error = error; self.generating = generating
    }
    enum CodingKeys: String, CodingKey { case name, brief, generatedAt, model, error, generating }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        brief = try container.decodeIfPresent(Content.self, forKey: .brief)
        generatedAt = try container.decodeIfPresent(Double.self, forKey: .generatedAt).map { Date(timeIntervalSince1970: $0 / 1000) }
        model = try container.decodeIfPresent(String.self, forKey: .model)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        generating = try container.decodeIfPresent(Bool.self, forKey: .generating) ?? false
    }

    public init(record: [String: Any]) throws {
        self = try JSONDecoder().decode(AgentBrief.self, from: JSONSerialization.data(withJSONObject: record))
    }

    /// The briefs in a `brief.list` result, by session name.
    public static func list(from result: [String: Any]) throws -> [String: AgentBrief] {
        let data = try JSONSerialization.data(withJSONObject: result["briefs"] ?? [])
        return Dictionary(try JSONDecoder().decode([AgentBrief].self, from: data).map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// The brief as plain text, for `orc brief`.
    public func text(relativeTo now: Date = .now) -> String {
        var lines: [String] = []
        let age = generatedAt.map { RelativeDateTimeFormatter().localizedString(for: $0, relativeTo: now) }
        lines.append([name, age, model].compactMap { $0 }.joined(separator: " · "))
        guard let brief else {
            lines.append(generating ? "Writing the first status…" : "No status yet.")
            if let error { lines.append("Last attempt failed: \(error)") }
            return lines.joined(separator: "\n")
        }
        lines.append("")
        lines.append("Goal: \(brief.goal)")
        if !brief.progress.isEmpty { lines.append("Progress:"); lines += brief.progress.map { "  - \($0)" } }
        lines.append("Right now: \(brief.now)")
        if !brief.next.isEmpty { lines.append("Next:"); lines += brief.next.enumerated().map { "  \($0.offset + 1). \($0.element)" } }
        if let needsYou = brief.needsYou { lines.append("Needs you: \(needsYou)") }
        if generating { lines.append("\nWriting a newer status…") }
        if let error { lines.append("\nThe latest attempt failed: \(error)") }
        return lines.joined(separator: "\n")
    }
}
