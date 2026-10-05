import XCTest
@testable import OrcKit

final class AgentBriefTests: XCTestCase {
    private let record: [String: Any] = [
        "name": "cdc", "generatedAt": 1_791_000_000_000, "model": "lab/qwen", "error": NSNull(), "generating": false, "mark": "1:2",
        "brief": ["headline": "Checkpoint: fix PR1 Clippy", "goal": "Ship the ChangeSink stack.",
                  "progress": ["PR3 passed 21 tests.", "PR1 signoff failed on 45 Clippy errors."],
                  "now": "At a checkpoint; nothing is running.", "next": ["Fix PR1's Clippy errors.", "Rerun signoff.", "Diagnose PR3's conflict flag."],
                  "needsYou": NSNull()]
    ]

    func testDecodesTheRuntimesBriefs() throws {
        let briefs = try AgentBrief.list(from: ["briefs": [record, ["name": "fresh", "brief": NSNull(), "generatedAt": NSNull(), "model": NSNull(),
                                                                    "error": "The agent has no transcript yet", "generating": true]]])
        XCTAssertEqual(Set(briefs.keys), ["cdc", "fresh"])
        let cdc = try XCTUnwrap(briefs["cdc"])
        XCTAssertEqual(cdc.generatedAt, Date(timeIntervalSince1970: 1_791_000_000))
        XCTAssertEqual(cdc.brief?.headline, "Checkpoint: fix PR1 Clippy")
        XCTAssertEqual(cdc.brief?.next.count, 3)
        XCTAssertNil(cdc.brief?.needsYou)
        XCTAssertNil(briefs["fresh"]?.brief)
        XCTAssertEqual(briefs["fresh"]?.generating, true)
        XCTAssertEqual(try AgentBrief.list(from: [:]), [:])
    }

    func testPlainTextForTheCLI() throws {
        let brief = try AgentBrief(record: record)
        let text = brief.text(relativeTo: Date(timeIntervalSince1970: 1_791_000_000 + 300))
        XCTAssertEqual(text.components(separatedBy: "\n").first, "cdc · \(RelativeDateTimeFormatter().localizedString(for: Date(timeIntervalSince1970: 1_791_000_000), relativeTo: Date(timeIntervalSince1970: 1_791_000_300))) · lab/qwen")
        XCTAssertTrue(text.contains("Goal: Ship the ChangeSink stack.\nProgress:\n  - PR3 passed 21 tests.\n  - PR1 signoff failed on 45 Clippy errors.\nRight now: At a checkpoint; nothing is running.\nNext:\n  1. Fix PR1's Clippy errors.\n  2. Rerun signoff.\n  3. Diagnose PR3's conflict flag."))
        XCTAssertFalse(text.contains("Needs you"))
        let empty = AgentBrief(name: "fresh", brief: nil, generatedAt: nil, model: nil, error: "the lab is down", generating: false)
        XCTAssertEqual(empty.text(), "fresh\nNo status yet.\nLast attempt failed: the lab is down")
    }
}
