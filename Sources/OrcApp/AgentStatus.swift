import AppKit
import SwiftUI
import OrcKit

/// Agent sessions' status briefs, which the runtime writes from their transcripts, and the pull requests it watches for
/// them; checked every few seconds.
@MainActor final class BriefModel: ObservableObject {
    @Published var briefs: [String: AgentBrief] = [:]
    @Published var pullRequests: [String: [AgentPullRequest]] = [:]
    /// Whether briefs have been read from the runtime at least once.
    @Published var loaded = false
    private var monitor: Task<Void, Never>?

    /// Without `monitor`, briefs and pull requests are only what is assigned to them.
    init(monitor: Bool = true) {
        guard monitor else { return }
        self.monitor = Task { [weak self] in
            while !Task.isCancelled {
                await self?.load()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }
    deinit { monitor?.cancel() }

    func load() async {
        guard let result = try? await RuntimeRPC.call("brief.list"), let briefs = try? AgentBrief.list(from: result) else { return }
        if briefs != self.briefs { self.briefs = briefs }
        if !loaded { loaded = true }
        if let result = try? await RuntimeRPC.call("pr.list"), let pullRequests = try? AgentPullRequest.list(from: result), pullRequests != self.pullRequests {
            self.pullRequests = pullRequests
        }
    }

    /// Asks the runtime to write a session's brief now.
    func refresh(_ name: String) async throws {
        let record = try await RuntimeRPC.call("brief.refresh", ["name": name])
        briefs[name] = try AgentBrief(record: record)
    }

    /// Its person marked the brief's question read: the runtime drops it, and later briefs do not raise it again.
    func dismiss(_ name: String, question: String) async throws {
        let record = try await RuntimeRPC.call("brief.dismiss", ["name": name, "question": question])
        briefs[name] = try AgentBrief(record: record)
    }

    /// The model briefs are written with, the models Pi can use, and how the chosen model did on the brief evals.
    struct Settings {
        var model: String?
        var models: [(model: String, name: String)]
        var evaluation: BriefEvaluation?
        var evaluating: Bool
    }

    static func settings() async throws -> Settings {
        let result = try await RuntimeRPC.call("brief.settings")
        let models = (result["models"] as? [[String: Any]] ?? []).compactMap { entry -> (model: String, name: String)? in
            guard let model = entry["model"] as? String else { return nil }
            return (model, entry["name"] as? String ?? model)
        }
        let evaluation = (result["evaluation"] as? [String: Any]).flatMap { try? BriefEvaluation(record: $0) }
        return Settings(model: result["model"] as? String, models: models, evaluation: evaluation, evaluating: result["evaluating"] as? Bool ?? false)
    }

    /// Chooses the model; the runtime then evaluates a newly chosen one.
    static func configure(model: String?) async throws {
        _ = try await RuntimeRPC.call("brief.configure", ["model": model ?? NSNull()])
    }

    /// Starts evaluating the chosen model again.
    static func evaluate() async throws {
        _ = try await RuntimeRPC.call("brief.evaluate")
    }
}
