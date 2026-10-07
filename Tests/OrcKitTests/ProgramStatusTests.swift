import XCTest
@testable import OrcKit

final class ProgramStatusTests: XCTestCase {
    func testASessionDecodesWhatItsProgramsReportAndReadsAsItsMostUrgentRecord() throws {
        let session: Session = try decode(["handle": "deploy", "title": "deploy", "worktreeId": "w", "worktreePath": "/code", "connected": true,
            "writable": true, "agentIdentity": NSNull(), "programStatus": ["state": "blocked", "records": [
                ["id": "", "state": "working", "app": "deploy", "msg": "Deploying v2.4.1"],
                ["id": "us-east", "state": "working", "app": "deploy", "progress": 40, "title": "US East"],
                ["id": "eu-west", "state": "blocked", "kind": "permission", "app": "deploy", "title": "EU West"]]]])
        let status = try XCTUnwrap(session.programStatus)
        XCTAssertEqual(status.lead?.id, "eu-west")
        XCTAssertEqual(status.app, "deploy")
        XCTAssertEqual(status.text, "EU West")
        XCTAssertEqual(status.records[1].text, "US East · 40%")
        XCTAssertEqual(status.records.map(\.stateText), ["working", "working, 40%", "needs permission"])
        XCTAssertEqual(ProgramStatus.Record(state: "blocked", kind: "auth").text, "needs you to sign in")
        XCTAssertEqual(ProgramStatus.Record(state: "error").text, "failed")
        // Without reports, a session has none.
        let plain: Session = try decode(["handle": "s", "worktreeId": "w", "worktreePath": "/code", "connected": true, "writable": true])
        XCTAssertNil(plain.programStatus)
    }
}
