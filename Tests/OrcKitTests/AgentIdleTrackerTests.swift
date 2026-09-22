import XCTest
@testable import OrcKit

final class AgentIdleTrackerTests: XCTestCase {
    private func session(_ handle: String = "one", name: String = "Test session", connected: Bool = true,
                         incarnation: String = "process-one", agent: String = "codex") -> Session {
        Session(handle: handle, title: name, worktreeId: "project", worktreePath: "/code/project",
                connected: connected, writable: true, agentIdentity: agent, incarnationId: incarnation)
    }

    func testNotifiesOncePerObservedWorkCycle() {
        var tracker = AgentIdleTracker()
        let current = session()
        XCTAssertTrue(tracker.update(sessions: [current], activities: ["one": .idle]).isEmpty)
        for _ in 0..<2 {
            XCTAssertTrue(tracker.update(sessions: [current], activities: ["one": .active]).isEmpty)
            XCTAssertTrue(tracker.update(sessions: [current], activities: ["one": .active]).isEmpty)
            XCTAssertEqual(tracker.update(sessions: [current], activities: ["one": .idle]), [current])
            XCTAssertTrue(tracker.update(sessions: [current], activities: ["one": .idle]).isEmpty)
        }
    }

    func testAttentionOnlyCompletesPreviouslyObservedWork() {
        var tracker = AgentIdleTracker()
        let current = session()
        XCTAssertTrue(tracker.update(sessions: [current], activities: ["one": .needsAttention]).isEmpty)
        XCTAssertTrue(tracker.update(sessions: [current], activities: ["one": .idle]).isEmpty)
        _ = tracker.update(sessions: [current], activities: ["one": .active])
        XCTAssertTrue(tracker.update(sessions: [current], activities: ["one": .needsAttention]).isEmpty)
        XCTAssertEqual(tracker.update(sessions: [current], activities: ["one": .idle]), [current])
    }

    func testUncertainOrMissingActivityDoesNotReplayOnRecovery() {
        let current = session()
        for intermediate: AgentActivity? in [.unknown, .noAgent, .offline, nil] {
            var tracker = AgentIdleTracker()
            _ = tracker.update(sessions: [current], activities: ["one": .active])
            _ = tracker.update(sessions: [current], activities: intermediate.map { ["one": $0] } ?? [:])
            XCTAssertTrue(tracker.update(sessions: [current], activities: ["one": .idle]).isEmpty)
        }
        for snapshot in [[], [session(connected: false)]] {
            var tracker = AgentIdleTracker()
            _ = tracker.update(sessions: [current], activities: ["one": .active])
            _ = tracker.update(sessions: snapshot, activities: ["one": .idle])
            XCTAssertTrue(tracker.update(sessions: [current], activities: ["one": .idle]).isEmpty)
        }
        var tracker = AgentIdleTracker()
        _ = tracker.update(sessions: [current], activities: ["one": .active])
        tracker.reset()
        XCTAssertTrue(tracker.update(sessions: [current], activities: ["one": .idle]).isEmpty)
    }

    func testReplacementProcessOrAgentIsNotACompletedCycle() {
        for replacement in [session(incarnation: "process-two"), session(agent: "pi")] {
            var tracker = AgentIdleTracker()
            _ = tracker.update(sessions: [session()], activities: ["one": .active])
            XCTAssertTrue(tracker.update(sessions: [replacement], activities: ["one": .idle]).isEmpty)
        }
    }

    func testIndependentSessionsAndRenamesUseCurrentNames() {
        var tracker = AgentIdleTracker()
        let first = session(), second = session("two")
        _ = tracker.update(sessions: [first, second], activities: ["one": .active, "two": .active])
        let renamed = session(name: "Renamed session")
        XCTAssertEqual(tracker.update(sessions: [renamed, second], activities: ["one": .idle, "two": .active]), [renamed])
        XCTAssertEqual(tracker.update(sessions: [renamed, second], activities: ["one": .idle, "two": .idle]), [second])
    }
}
