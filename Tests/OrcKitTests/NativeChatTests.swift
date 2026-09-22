import XCTest
@testable import OrcKit

final class NativeChatTests: XCTestCase {
    func testTranscriptIdentityAndEligibility() throws {
        let target = try XCTUnwrap(ChatTarget(tab: ["type": "terminal", "terminal": "term_test", "launchAgent": "codex",
            "agentStatus": ["agentType": "claude", "state": "done", "providerSession": ["id": "provider-id", "transcriptPath": "/owned/session.jsonl"]]]))
        XCTAssertEqual(target.agent, "claude")
        XCTAssertEqual(target.params["sessionId"] as? String, "provider-id")
        XCTAssertTrue(target.canSend)
        let pi = try XCTUnwrap(ChatTarget(tab: ["type": "terminal", "terminal": "term_pi", "launchAgent": "codex", "agentStatus": ["agentType": "pi"]]))
        XCTAssertTrue(pi.supported)
        XCTAssertNil(pi.identity)
        let pending = try XCTUnwrap(ChatTarget(tab: ["type": "terminal", "terminal": "term_pending", "launchAgent": "codex"]))
        XCTAssertTrue(pending.supported)
        XCTAssertFalse(pending.canSend)
        let blocked = try XCTUnwrap(ChatTarget(tab: ["type": "terminal", "terminal": "term_blocked", "agentStatus": [
            "agentType": "claude", "state": "blocked", "providerSession": ["id": "session"]]]))
        XCTAssertTrue(blocked.requiresTerminal)
        XCTAssertFalse(blocked.canSend)
        let permission = try XCTUnwrap(ChatTarget(tab: ["type": "terminal", "terminal": "term_permission", "agentStatus": [
            "agentType": "codex", "state": "waiting", "providerSession": ["id": "session"]]]))
        XCTAssertTrue(permission.requiresTerminal)
        XCTAssertFalse(permission.canSend)
    }
    func testPiUsesOmpDecoderWithoutChangingAgentOrTranscriptIdentity() throws {
        let path = "/sessions/pi/한글 session.jsonl"
        func target(path: String?, connection: String? = nil, state: String = "done") throws -> ChatTarget {
            var provider: [String: Any] = ["id": "pi-provider-id"]
            if let path { provider["transcriptPath"] = path }
            var status: [String: Any] = ["agentType": "pi", "state": state, "providerSession": provider]
            if let connection { status["connectionId"] = connection }
            return try XCTUnwrap(ChatTarget(tab: ["type": "terminal", "terminal": "term_pi", "agentStatus": status]))
        }
        let pi = try target(path: path)
        XCTAssertTrue(pi.supported)
        XCTAssertTrue(pi.canSend)
        XCTAssertEqual(pi.agent, "pi")
        XCTAssertEqual(pi.handle, "term_pi")
        XCTAssertEqual(pi.identity, "pi\0pi-provider-id\0" + path)
        XCTAssertEqual(pi.params["agent"] as? String, "omp")
        XCTAssertEqual(pi.params["sessionId"] as? String, "pi-provider-id")
        XCTAssertEqual(pi.params["transcriptPath"] as? String, path)
        for invalid in [nil, "", "relative.jsonl", "/sessions/not-jsonl.txt"] as [String?] {
            let missing = try target(path: invalid)
            XCTAssertNil(missing.identity, "Pi must not fall back to looking up an OMP transcript")
            XCTAssertFalse(missing.canSend)
        }
        let remote = try target(path: path, connection: "ssh-remote")
        XCTAssertFalse(remote.supported)
        XCTAssertNil(remote.identity)
        XCTAssertFalse(try target(path: path, state: "blocked").canSend)
        XCTAssertFalse(try target(path: path, state: "waiting").canSend)
    }
    func testHistoryHandlesPendingSnapshotsUpdatesAndReplacement() {
        var history = ChatHistory()
        func message(_ id: String, _ text: String) -> [String: Any] {
            ["id": id, "role": "assistant", "blocks": [["type": "text", "text": text]]]
        }
        history.apply(["type": "snapshot", "messages": [message("a", "first")], "hasMore": true, "beforeOffset": 100])
        history.apply(["type": "snapshot", "messages": [], "pending": true])
        XCTAssertEqual(history.messages.map(\.id), ["a"])
        history.apply(["type": "appended", "messages": [message("a", "updated"), message("b", "next")]])
        XCTAssertEqual(history.messages.map(\.id), ["a", "b"])
        XCTAssertEqual(history.messages.first?.blocks.first?.body, "updated")
        XCTAssertTrue(history.hasMore)
        history.apply(["type": "replacement", "messages": [message("c", "new conversation")], "hasMore": false])
        XCTAssertEqual(history.messages.map(\.id), ["c"])
        XCTAssertFalse(history.hasMore)
    }
    func testEarlierHistoryPreservesLiveUpdates() throws {
        var history = ChatHistory()
        func message(_ id: String, _ text: String) -> [String: Any] {
            ["id": id, "role": "assistant", "blocks": [["type": "text", "text": text]]]
        }
        history.apply(["type": "snapshot", "messages": [message("b", "live")], "hasMore": true, "beforeOffset": 100])
        try history.prepend(["messages": [message("a", "earlier"), message("a", "updated earlier"), message("b", "stale")], "hasMore": true, "beforeOffset": 50])
        XCTAssertEqual(history.messages.map(\.id), ["a", "b"])
        XCTAssertEqual(history.messages.first?.blocks.first?.body, "updated earlier")
        XCTAssertEqual(history.messages.last?.blocks.first?.body, "live")
        try history.prepend(["messages": [], "hasMore": true, "beforeOffset": 50])
        XCTAssertFalse(history.hasMore, "A repeated cursor must not offer endless pagination")
    }
    func testReconnectRetainsHistoryUntilConversationChanges() {
        var history = ChatHistory()
        history.bind(to: "codex\0first")
        history.apply(["type": "snapshot", "messages": [["id": "a", "role": "assistant", "blocks": []]],
                       "hasMore": true, "beforeOffset": 100])
        history.bind(to: "codex\0first")
        history.apply(["type": "snapshot", "pending": true, "messages": []])
        XCTAssertEqual(history.messages.map(\.id), ["a"])
        XCTAssertEqual(history.beforeOffset, 100)
        history.bind(to: "codex\0second")
        XCTAssertTrue(history.messages.isEmpty)
        XCTAssertFalse(history.hasMore)
        XCTAssertNil(history.beforeOffset)
    }
    func testToolAndUnknownBlocksStayVisible() {
        let tool = ChatBlock(["type": "tool-call", "name": "Read", "input": ["path": "README.md"], "state": "completed"])
        XCTAssertTrue(tool.title.contains("Read"))
        XCTAssertTrue(tool.body.contains("README.md"))
        XCTAssertEqual(ChatBlock(["type": "tool-call", "name": "read", "input": [:]]).title, "read",
                       "A transcript tool call without status must not be presented as still running")
        XCTAssertTrue(ChatBlock(["type": "tool-result", "output": "failed", "isError": true]).isError)
        XCTAssertTrue(ChatBlock(["type": "future-block", "detail": "preserved"]).body.contains("preserved"))
    }
}
