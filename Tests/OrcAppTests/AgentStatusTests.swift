import AppKit
import SwiftUI
import XCTest
import OrcKit
@testable import OrcApp

final class AgentStatusTests: XCTestCase {
    private let content = AgentBrief.Content(
        headline: "Checkpoint: fix PR1 Clippy", goal: "Deliver a buildable, reviewed three-PR ChangeSink stack.",
        progress: ["All three draft PRs are published.", "PR3's initialization fix passed 21 tests.", "PR1 signoff failed on 45 Clippy errors."],
        now: "At a checkpoint. No builds, tests, or signoff jobs are running; the workspace stays reserved.",
        next: ["Fix PR1's Clippy errors and publish an additive commit.", "Run lab signoff on the new PR1 head.", "Reproduce or dismiss PR2's cancellation concern."],
        needsYou: "Approve merging PR3 despite GitHub's stale conflict flag?")

    func testComingBackAfterAWhileToANewerBrief() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "orc-view-log-\(UUID().uuidString)"))
        let log = SessionViewLog(defaults: defaults)
        let now = Date()
        let brief = { (written: Date) in AgentBrief(name: "cdc", brief: self.content, generatedAt: written, model: "lab/qwen", error: nil, generating: false) }
        // Never looked at: any brief is news.
        XCTAssertTrue(log.isReturning(to: "cdc", brief: brief(now), now: now))
        log.viewed("cdc", at: now.addingTimeInterval(-20 * 60))
        XCTAssertTrue(log.isReturning(to: "cdc", brief: brief(now.addingTimeInterval(-60)), now: now))
        // A brief from before the last look is old news; so is a look within the last 15 minutes.
        XCTAssertFalse(log.isReturning(to: "cdc", brief: brief(now.addingTimeInterval(-30 * 60)), now: now))
        log.viewed("cdc", at: now.addingTimeInterval(-10 * 60))
        XCTAssertFalse(log.isReturning(to: "cdc", brief: brief(now), now: now))
        // Without a brief there is nothing to show.
        XCTAssertFalse(log.isReturning(to: "other", brief: AgentBrief(name: "other", brief: nil, generatedAt: nil, model: nil, error: nil, generating: true), now: now))
    }

    func testTheSidebarShowsTheHeadlineAfterTheAgent() throws {
        let session: Session = try decode(["handle": "cdc", "title": "cdc", "worktreeId": "w", "worktreePath": "/code", "connected": true, "writable": true,
                                           "agentIdentity": "pi"])
        let row = SessionSidebarRow(session: session, name: "cdc", activity: .idle, muted: false, headline: "Checkpoint: fix PR1 Clippy", group: "Priority",
                                    isChild: false, childrenCollapsed: nil)
        XCTAssertEqual(row.detail, "pi · Checkpoint: fix PR1 Clippy · Priority")
    }

    @MainActor func testThePanelShowsTheBrief() async throws {
        _ = NSApplication.shared
        let briefs = BriefModel(monitor: false)
        briefs.briefs = ["cayenne-caching-cdc": AgentBrief(name: "cayenne-caching-cdc", brief: content, generatedAt: Date().addingTimeInterval(-240),
                                                           model: "cuda-gpu-dev/qwen-flash-next", error: nil, generating: false)]
        let effect = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 360, height: 560))
        effect.material = .hudWindow
        effect.blendingMode = .behindWindow
        effect.state = .active
        let host = NSHostingView(rootView: StatusPanelView(briefs: briefs, name: "cayenne-caching-cdc"))
        host.frame = effect.bounds
        host.autoresizingMask = [.width, .height]
        effect.addSubview(host)
        let window = NSWindow(contentRect: effect.frame, styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.contentView = effect
        window.orderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(300))
        guard let directory = ProcessInfo.processInfo.environment["ORC_WINDOW_SNAPSHOT_DIR"] else { return }
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            window.appearance = NSAppearance(named: appearance)
            try await Task.sleep(for: .milliseconds(150))
            let bitmap = try XCTUnwrap(effect.bitmapImageRepForCachingDisplay(in: effect.bounds))
            effect.cacheDisplay(in: effect.bounds, to: bitmap)
            let url = URL(fileURLWithPath: directory)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                .write(to: url.appendingPathComponent("status-panel-\(appearance == .aqua ? "light" : "dark").png"))
        }
    }
}
