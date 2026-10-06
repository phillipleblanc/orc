import XCTest
@testable import OrcKit

final class AgentUsageTests: XCTestCase {
    func testDecodesTheRuntimesUsageWithMillisecondTimes() throws {
        let result: [String: Any] = ["providers": [
            ["provider": "claude", "name": "Claude", "plan": "Max 5x", "status": "ok", "error": NSNull(), "updatedAt": 1_791_000_000_000,
             "windows": [["kind": "session", "label": "Session", "usedPercent": 34, "resetsAt": 1_791_003_600_000, "windowMinutes": 300],
                         ["kind": "model", "label": "Fable", "usedPercent": 81.5, "resetsAt": NSNull(), "windowMinutes": 10080]]],
            ["provider": "codex", "name": "Codex", "plan": NSNull(), "windows": [], "status": "unavailable", "error": "Codex is not signed in",
             "updatedAt": NSNull()],
            ["provider": "codex", "name": "Codex", "plan": "Pro", "resetCredits": 2, "status": "error", "error": "offline", "updatedAt": NSNull(),
             "windows": [["kind": "weekly", "label": "Weekly", "usedPercent": 4, "resetsAt": 1_791_770_623_000, "windowMinutes": 10080]]]
        ]]
        let usage = try AgentUsage.list(from: result)
        XCTAssertEqual(usage.map(\.status), [.ok, .unavailable, .error])
        XCTAssertEqual(usage[0].plan, "Max 5x")
        XCTAssertEqual(usage[0].updatedAt, Date(timeIntervalSince1970: 1_791_000_000))
        XCTAssertEqual(usage[0].windows.map(\.label), ["Session", "Fable"])
        XCTAssertEqual(usage[0].windows[0].resetsAt, Date(timeIntervalSince1970: 1_791_003_600))
        XCTAssertNil(usage[0].windows[1].resetsAt)
        XCTAssertEqual(usage[0].tightest?.label, "Fable")
        XCTAssertEqual(usage[1].error, "Codex is not signed in")
        XCTAssertNil(usage[1].tightest)
        XCTAssertEqual(usage[2].resetCredits, 2)
        XCTAssertEqual(try AgentUsage.list(from: [:]), [])
    }

    func testUsageLevelsAndResetDurations() {
        XCTAssertEqual([0, 59.9, 60, 79, 80, 100].map(UsageLevel.init(usedPercent:)), [.normal, .normal, .high, .high, .critical, .critical])
        XCTAssertEqual(formatDuration(-5), "now")
        XCTAssertEqual(formatDuration(59), "<1m")
        XCTAssertEqual(formatDuration(45 * 60), "45m")
        XCTAssertEqual(formatDuration(2 * 3600), "2h")
        XCTAssertEqual(formatDuration(2 * 3600 + 13 * 60 + 59), "2h 13m")
        XCTAssertEqual(formatDuration(3 * 86400), "3d")
        XCTAssertEqual(formatDuration(3 * 86400 + 4 * 3600 + 30 * 60), "3d 4h")
    }
}
