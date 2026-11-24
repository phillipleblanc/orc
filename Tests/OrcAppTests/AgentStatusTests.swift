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

    func testOnlySessionsWithSomethingToNoticeShowAnIndicator() throws {
        let agent: Session = try decode(["handle": "cdc", "title": "cdc", "worktreeId": "w", "worktreePath": "/code", "connected": true, "writable": true,
                                         "agentIdentity": "claude"])
        let terminal: Session = try decode(["handle": "sh", "title": "sh", "worktreeId": "w", "worktreePath": "/code", "connected": true, "writable": true])
        for activity in [AgentActivity.active, .unread, .notified, .needsAttention, .offline] {
            XCTAssertTrue(AgentActivityIndicator.shows(activity, for: agent, muted: false), activity.label)
        }
        for activity in [AgentActivity.idle, .noAgent, .unknown] {
            XCTAssertFalse(AgentActivityIndicator.shows(activity, for: agent, muted: false), activity.label)
        }
        // A muted agent shows its muted bell even when idle.
        XCTAssertTrue(AgentActivityIndicator.shows(.idle, for: agent, muted: true))
        // A plain terminal shows only a notification it sent, or that it is offline.
        XCTAssertEqual([AgentActivity.unread, .notified, .offline, .active].map { AgentActivityIndicator.shows($0, for: terminal, muted: false) },
                       [false, true, true, false])
    }
}
