import AppKit
import SwiftUI
import XCTest
import OrcKit
@testable import OrcApp

final class AgentStatusTests: XCTestCase {
    func testTheSidebarShowsTheHeadlineAfterTheAgent() throws {
        let session: Session = try decode(["handle": "cdc", "title": "cdc", "worktreeId": "w", "worktreePath": "/code", "connected": true, "writable": true,
                                           "agentIdentity": "pi"])
        let row = SessionSidebarRow(session: session, name: "cdc", activity: .idle, muted: false, headline: "Checkpoint: fix PR1 Clippy",
                                    isChild: false, childrenCollapsed: nil)
        XCTAssertEqual(row.detail, "pi · Checkpoint: fix PR1 Clippy")
        // A terminal whose program reports its status reads as that program and what it says.
        var program: Session = try decode(["handle": "sync", "title": "sync", "worktreeId": "w", "worktreePath": "/code", "connected": true, "writable": true])
        program.programStatus = ProgramStatus(state: "blocked", records: [.init(state: "blocked", kind: "question", app: "rsync", msg: "Overwrite photos?")])
        XCTAssertEqual(SessionSidebarRow(session: program, name: "sync", activity: .needsAttention, muted: false, isChild: false, childrenCollapsed: nil).detail,
                       "rsync · Overwrite photos?")
    }
}
