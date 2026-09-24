import XCTest
@testable import OrcKit

final class AgentReviewStateTests: XCTestCase {
    private func session(_ handle: String, tab: String, incarnation: String = "process-one", agent: String = "pi") -> Session {
        var session = Session(handle: handle, title: "Session", worktreeId: "project", worktreePath: "/code/project",
                              connected: true, writable: true, agentIdentity: agent, incarnationId: incarnation)
        session.tabId = tab
        session.leafId = "leaf"
        return session
    }

    func testCompletionStaysUnreadUntilReadAndIsIndependentPerSession() {
        let first = session("first", tab: "tab-one"), second = session("second", tab: "tab-two")
        var state = AgentReviewState()
        _ = state.update(sessions: [first, second], activities: [first.handle: .active, second.handle: .active])
        XCTAssertEqual(state.update(sessions: [first, second], activities: [first.handle: .idle, second.handle: .idle]), [first, second])
        XCTAssertEqual(state.activity(for: first, base: .idle), .unread)
        XCTAssertEqual(state.activity(for: second, base: .idle), .unread)
        state.markRead(first)
        XCTAssertEqual(state.activity(for: first, base: .idle), .idle)
        XCTAssertEqual(state.activity(for: second, base: .idle), .unread)
        XCTAssertTrue(state.update(sessions: [first, second], activities: [first.handle: .idle, second.handle: .idle]).isEmpty)
        XCTAssertEqual(state.activity(for: first, base: .idle), .idle)
    }

    func testBadgeFollowsPaneAcrossHandleChangeButNotReplacementAgent() {
        let original = session("old-handle", tab: "tab")
        let reminted = session("new-handle", tab: "tab")
        var state = AgentReviewState()
        _ = state.update(sessions: [original], activities: [original.handle: .active])
        XCTAssertEqual(state.update(sessions: [reminted], activities: [reminted.handle: .idle]), [reminted])
        XCTAssertEqual(state.activity(for: reminted, base: .idle), .unread)
        XCTAssertEqual(state.activity(for: reminted, base: .offline), .offline)
        XCTAssertEqual(state.activity(for: reminted, base: .active), .active)
        let replacement = session("new-handle", tab: "tab", incarnation: "process-two")
        _ = state.update(sessions: [replacement], activities: [replacement.handle: .idle])
        XCTAssertEqual(state.activity(for: replacement, base: .idle), .idle)
        XCTAssertTrue(state.unreadKeys.isEmpty)
    }

    func testActiveCycleAndUnreadStateSurviveRelaunch() throws {
        let current = session("handle", tab: "tab")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("orc-review-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("agent-review.json")
        var state = AgentReviewState()
        _ = state.update(sessions: [current], activities: [current.handle: .active])
        try AgentReviewStore.save(state, to: file)
        state = try AgentReviewStore.load(from: file)
        XCTAssertEqual(state.update(sessions: [current], activities: [current.handle: .idle]), [current])
        try AgentReviewStore.save(state, to: file)
        state = try AgentReviewStore.load(from: file)
        XCTAssertEqual(state.activity(for: current, base: .idle), .unread)
        state.markRead(current)
        try AgentReviewStore.save(state, to: file)
        XCTAssertEqual(try AgentReviewStore.load(from: file).activity(for: current, base: .idle), .idle)
        let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
    }

    func testTruncatedOrUnavailableInventoryDoesNotLoseUnreadState() {
        let current = session("handle", tab: "tab")
        var state = AgentReviewState()
        _ = state.update(sessions: [current], activities: [current.handle: .active])
        _ = state.update(sessions: [current], activities: [current.handle: .idle])
        _ = state.update(sessions: [], activities: [:], pruneMissing: false)
        XCTAssertEqual(state.activity(for: current, base: .idle), .unread)
        _ = state.update(sessions: [], activities: [:])
        XCTAssertTrue(state.unreadKeys.isEmpty)
    }
}
