import SwiftUI
import OrcKit

/// The runtime's watch over agents' pull requests.
enum PullRequestWatch {
    /// Answers a check that failed again after the agent was told: ignore it from now on, or keep telling the agent.
    static func resolve(_ name: String, _ pullRequest: AgentPullRequest, check: String, ignore: Bool) async throws {
        _ = try await LocalRPC.call("pr.resolve", ["name": name, "url": pullRequest.url.absoluteString, "check": check, "choice": ignore ? "ignore" : "keep"])
    }

    /// The checks never reported to agents.
    static func ignoredChecks() async throws -> [String] {
        try await LocalRPC.call("pr.settings")["ignoredChecks"] as? [String] ?? []
    }

    static func setIgnoredChecks(_ checks: [String]) async throws {
        _ = try await LocalRPC.call("pr.configure", ["ignoredChecks": checks])
    }
}

/// A pull request in a line: its number, linked to GitHub, and what stands in its way.
struct PullRequestLine: View {
    let pullRequest: AgentPullRequest

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Image(systemName: "arrow.triangle.pull").foregroundStyle(.secondary)
            Link("#" + String(pullRequest.number), destination: pullRequest.url).help(pullRequest.title.map { "\(pullRequest.repo): \($0)" } ?? pullRequest.repo)
            Text(pullRequest.summary).foregroundStyle(pullRequest.problems.isEmpty ? Color.secondary : Color.orange).lineLimit(1)
        }
        .font(.caption)
    }
}

/// A check that failed again after the agent was told about it twice, with the choice its person makes.
struct HandedOverCheck: View {
    let name: String
    let pullRequest: AgentPullRequest
    let check: String
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(check + " failed again on #" + String(pullRequest.number) + " after the agent was told twice.", systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            HStack(spacing: 8) {
                Button("Ignore Check") { resolve(ignore: true) }
                    .help("Never report \(check) to agents again; Settings lists the ignored checks.")
                Button("Keep Telling Agent") { resolve(ignore: false) }
                    .help("Report \(check) to the agent each time it fails on a new commit.")
            }
            .controlSize(.small)
            if let error { Text(error).foregroundStyle(.red) }
        }
        .font(.caption)
    }

    private func resolve(ignore: Bool) {
        Task {
            do { try await PullRequestWatch.resolve(name, pullRequest, check: check, ignore: ignore); error = nil }
            catch { self.error = error.localizedDescription }
        }
    }
}

/// An agent's pull requests in full, for the status panel: each one's state, what the agent was told, and checks
/// waiting on its person.
struct PullRequestsSection: View {
    let name: String
    let pullRequests: [AgentPullRequest]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Pull Requests").font(.caption).foregroundStyle(.secondary)
            if pullRequests.isEmpty {
                Text("None linked. Orc links the pull requests the agent opens when it writes its status, or run `orc pr watch \(name) URL`.")
                    .font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            }
            ForEach(pullRequests) { pullRequest in
                VStack(alignment: .leading, spacing: 3) {
                    Link(destination: pullRequest.url) {
                        Text(verbatim: pullRequest.id).fontWeight(.semibold) + Text(verbatim: pullRequest.title.map { " " + $0 } ?? "")
                    }
                    .font(.callout).lineLimit(2).multilineTextAlignment(.leading)
                    Text(pullRequest.summary).font(.caption).foregroundStyle(pullRequest.problems.isEmpty ? Color.secondary : Color.orange)
                    if !pullRequest.ignoredFailing.isEmpty {
                        Text("Ignored: \(pullRequest.ignoredFailing.joined(separator: ", ")) failed").font(.caption).foregroundStyle(.tertiary)
                    }
                    if let told = pullRequest.toldAt {
                        Text("Told the agent \(RelativeDateTimeFormatter().localizedString(for: min(told, .now), relativeTo: .now))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let error = pullRequest.error {
                        Label(error, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.orange).lineLimit(3)
                    }
                    ForEach(pullRequest.handedOver, id: \.self) { check in
                        HandedOverCheck(name: name, pullRequest: pullRequest, check: check)
                    }
                }
            }
        }
    }
}
