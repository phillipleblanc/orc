import XCTest
@testable import OrcKit

final class SessionOverviewTests: XCTestCase {
    private func session(_ name: String, agent: String? = "codex") -> Session {
        Session(handle: name, title: name, worktreeId: "project", worktreePath: "/code/project",
                connected: true, writable: true, agentIdentity: agent, incarnationId: name)
    }
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func at(minutesAgo: Double) -> Date { now.addingTimeInterval(-minutesAgo * 60) }
    private func brief(_ name: String, needsYou: String?, written: Date) -> AgentBrief {
        AgentBrief(name: name, brief: AgentBrief.Content(headline: "h", goal: "g", progress: [], now: "n", next: [], needsYou: needsYou),
                   generatedAt: written, model: "lab/qwen", error: nil, generating: false)
    }

    func testDecodesTheRuntimesAgents() throws {
        let agents = try AgentSummary.list(from: ["agents": [
            ["name": "coord", "agent": "codex", "state": "idle", "queued": 0, "since": 1_800_000_000_000, "wakes": [
                ["id": "a", "kind": "pid", "pid": 4, "message": "continue", "createdAt": 1],
                ["id": "b", "kind": "timer", "dueAt": 1_800_000_600_000, "message": "continue", "createdAt": 1]]],
            ["name": "worker", "agent": "pi", "state": "working", "parent": "coord", "queued": 2]
        ]])
        XCTAssertEqual(agents["coord"]?.since, now)
        XCTAssertEqual(agents["coord"]?.nextWake, AgentSummary.Wake(kind: "timer", dueAt: now.addingTimeInterval(600)))
        XCTAssertEqual(agents["worker"]?.parent, "coord")
        XCTAssertEqual(agents["worker"]?.queued, 2)
        XCTAssertNil(agents["worker"]?.since)
    }

    func testFamiliesSitInTheirMostUrgentMembersLaneOrderedByHowLongTheyWaitedOrWorked() {
        let sessions = ["coord", "worker-a", "worker-b", "sub", "solo", "frontend", "frontend-review", "shell", "fresh"]
            .map { session($0, agent: $0 == "shell" ? nil : "codex") }
        let activities: [String: AgentActivity] = ["coord": .idle, "worker-a": .active, "worker-b": .needsAttention, "sub": .idle,
                                                   "solo": .active, "frontend": .idle, "frontend-review": .idle, "shell": .noAgent, "fresh": .idle]
        let agents: [String: AgentSummary] = [
            "coord": AgentSummary(name: "coord", agent: "codex", state: "idle", since: at(minutesAgo: 30)),
            "worker-a": AgentSummary(name: "worker-a", agent: "pi", state: "working", parent: "coord", since: at(minutesAgo: 10)),
            "worker-b": AgentSummary(name: "worker-b", agent: "claude", state: "permission", parent: "coord", since: at(minutesAgo: 2)),
            // Spawned by a worker: it joins the coordinator's family.
            "sub": AgentSummary(name: "sub", agent: "pi", state: "idle", parent: "worker-a", since: at(minutesAgo: 5)),
            "solo": AgentSummary(name: "solo", agent: "codex", state: "working", since: at(minutesAgo: 60)),
            "frontend": AgentSummary(name: "frontend", agent: "codex", state: "idle", since: at(minutesAgo: 40)),
            "frontend-review": AgentSummary(name: "frontend-review", agent: "codex", state: "idle", since: at(minutesAgo: 41)),
            "fresh": AgentSummary(name: "fresh", agent: "codex", state: "idle", since: at(minutesAgo: 1))
        ]
        let lanes = SessionOverview.arrange(sessions: sessions, activities: activities, agents: agents, briefs: [:],
                                            hierarchy: SessionHierarchy(sessions: sessions))
        XCTAssertEqual(lanes.map(\.lane), [.needsYou, .working, .idle])
        // The coordinator waits on its person through worker-b; its members are ordered by lane, then time in it.
        XCTAssertEqual(lanes[0].families.map(\.head.session.name), ["coord"])
        XCTAssertEqual(lanes[0].families[0].members.map(\.session.name), ["worker-b", "worker-a", "sub"])
        XCTAssertEqual(lanes[1].families.map(\.head.session.name), ["solo"])
        // A named child joins its parent; the most recently idle come first.
        XCTAssertEqual(lanes[2].families.map(\.head.session.name), ["fresh", "frontend", "shell"])
        XCTAssertEqual(lanes[2].families[1].members.map(\.session.name), ["frontend-review"])
    }

    func testABriefsQuestionCountsOnlyWhileItIsNewerThanTheAgentsState() {
        let item = { (activity: AgentActivity, written: Double) in
            OverviewItem(session: self.session("cdc"), activity: activity,
                         agent: AgentSummary(name: "cdc", agent: "pi", state: "idle", since: self.at(minutesAgo: 20)),
                         brief: self.brief("cdc", needsYou: "Approve merging PR3?", written: self.at(minutesAgo: written)))
        }
        XCTAssertEqual(item(.idle, 10).lane, .needsYou)
        XCTAssertEqual(item(.idle, 10).needsYou, "Approve merging PR3?")
        // Written before the agent last changed state: the question was answered since.
        XCTAssertEqual(item(.idle, 30).lane, .idle)
        // A working agent is not waiting on anyone; output to review is.
        XCTAssertEqual(item(.active, 10).lane, .working)
        XCTAssertEqual(item(.unread, 30).lane, .needsYou)
        // Marking it read acknowledges the question until a newer brief asks again.
        let marked = { (minutesAgo: Double) in
            OverviewItem(session: self.session("cdc"), activity: .idle,
                         agent: AgentSummary(name: "cdc", agent: "pi", state: "idle", since: self.at(minutesAgo: 20)),
                         brief: self.brief("cdc", needsYou: "Approve merging PR3?", written: self.at(minutesAgo: 10)), acknowledged: self.at(minutesAgo: minutesAgo))
        }
        XCTAssertEqual(marked(5).lane, .idle)
        XCTAssertEqual(marked(15).lane, .needsYou)
    }
}
