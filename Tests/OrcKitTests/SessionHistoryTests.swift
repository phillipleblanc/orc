import XCTest
@testable import OrcKit

final class SessionHistoryTests: XCTestCase {
    func testClosedSessionsDecodeFromTheRuntimeAndShowTheirAge() throws {
        let closed: [ClosedSession] = try decode([[
            "entry": "helper.2026-10-01T08-00-00-000Z", "name": "helper", "agent": "pi", "cwd": "/code/spiceai-project",
            "project": "p-1", "closedAt": "2026-10-01T08:00:00.000Z", "conversation": ["id": "c-1"],
            "lastMessage": "Done.", "screen": ["done", "  ready"]
        ], [
            "entry": "coder.2026-09-30T08-00-00-000Z", "name": "coder", "agent": "codex", "cwd": "/code/orc",
            "closedAt": "2026-09-30T08:00:00.000Z", "conversation": ["id": "c-2"], "screen": []
        ]])
        XCTAssertEqual(closed.map(\.name), ["helper", "coder"])
        XCTAssertEqual(closed[0].lastMessage, "Done.")
        XCTAssertNil(closed[1].lastMessage)
        XCTAssertNil(closed[1].project)
        let now = try XCTUnwrap(closed[0].closedDate)
        XCTAssertEqual(closed[0].age(now: now.addingTimeInterval(20)), "just now")
        XCTAssertEqual(closed[0].age(now: now.addingTimeInterval(125)), "2m ago")
        XCTAssertEqual(closed[0].age(now: now.addingTimeInterval(3 * 3600)), "3h ago")
        XCTAssertEqual(closed[1].age(now: now.addingTimeInterval(86_400)), "2d ago")
    }

    func testConversationsDecodeAndFallBackToTheirPromptForATitle() throws {
        let conversations: [AgentConversation] = try decode([[
            "agent": "codex", "id": "01a0f112", "transcriptPath": "/t/a.jsonl", "cwd": "/code/spiceai-project",
            "title": "coord", "firstPrompt": "$fleet-coordinator", "updatedAt": "2026-10-01T06:00:00.000Z", "openIn": "coord"
        ], [
            "agent": "pi", "id": "pi-1", "transcriptPath": "/t/b.jsonl", "cwd": "/code/orc",
            "firstPrompt": "Benchmark the cache", "lastMessage": "Done", "updatedAt": "2026-10-01T05:00:00.000Z", "project": "p-1"
        ]])
        XCTAssertEqual(conversations.map(\.displayTitle), ["coord", "Benchmark the cache"])
        XCTAssertEqual(conversations[0].openIn, "coord")
        XCTAssertNil(conversations[1].openIn)
        let later = try XCTUnwrap(conversations[0].updatedDate).addingTimeInterval(7200)
        XCTAssertEqual(conversations[1].age(now: later), "3h ago")
    }
}
