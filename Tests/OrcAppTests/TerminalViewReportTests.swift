import XCTest
@testable import OrcApp

final class TerminalViewReportTests: XCTestCase {
    @MainActor func testReportsShownChangesAndAttentionInOrderAndOnceForRepeatedAttention() async throws {
        var sent: [[String: Any]] = []
        var owners: [String?] = []
        let report = TerminalViewReport(handle: "term_a", viewer: "orc-view", send: { params in
            sent.append(params)
            return ["owner": sent.count == 1, "ownerDevice": sent.count == 1 ? "Mac" : "EPYC-WINDOWS"]
        }, ownerChanged: { owner, device in owners.append(owner ? nil : device) })
        let start = Date()
        report.report(shown: true, attention: .strong, now: start)
        report.report(shown: true, attention: .strong, now: start.addingTimeInterval(0.1))
        report.report(shown: true, attention: nil, now: start.addingTimeInterval(0.2))
        report.report(shown: true, attention: .presence, now: start.addingTimeInterval(0.2))
        report.report(shown: true, attention: .strong, now: start.addingTimeInterval(0.5))
        report.report(shown: false, attention: nil, now: start.addingTimeInterval(0.6))
        for _ in 0..<100 where sent.count < 4 { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(sent.map { $0["attention"] as? String }, ["strong", "presence", "strong", nil])
        XCTAssertEqual(sent.map { $0["shown"] as? Bool }, [true, true, true, false])
        XCTAssertEqual(sent.map { ($0["client"] as? [String: Any])?["id"] as? String }, Array(repeating: "orc-view", count: 4))
        XCTAssertEqual(owners, [nil, "EPYC-WINDOWS", "EPYC-WINDOWS", "EPYC-WINDOWS"])
    }
}
