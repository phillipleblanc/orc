import AppKit
import SwiftUI
import XCTest
import OrcKit
@testable import OrcApp

final class SessionOverviewViewTests: XCTestCase {
    func testKeysMoveOpenAndReplyExceptWhileAReplyIsWritten() {
        typealias Action = SessionOverviewView.KeyAction
        XCTAssertEqual(SessionOverviewView.keyAction(.downArrow, characters: "", replying: false), Action.next)
        XCTAssertEqual(SessionOverviewView.keyAction(KeyEquivalent("j"), characters: "j", replying: false), Action.next)
        XCTAssertEqual(SessionOverviewView.keyAction(KeyEquivalent("k"), characters: "k", replying: false), Action.previous)
        XCTAssertEqual(SessionOverviewView.keyAction(.return, characters: "\r", replying: false), Action.open)
        XCTAssertEqual(SessionOverviewView.keyAction(KeyEquivalent("r"), characters: "r", replying: false), Action.reply)
        XCTAssertNil(SessionOverviewView.keyAction(KeyEquivalent("x"), characters: "x", replying: false))
        XCTAssertEqual(SessionOverviewView.keyAction(KeyEquivalent("m"), characters: "m", replying: false), Action.markRead)
        XCTAssertEqual(SessionOverviewView.keyAction(KeyEquivalent("?"), characters: "?", replying: false), Action.shortcuts)
        XCTAssertEqual(SessionOverviewView.keyAction(.escape, characters: "\u{1b}", replying: false), Action.close)
        // Typing a reply, every key goes to its field.
        for (key, characters) in [(KeyEquivalent("r"), "r"), (KeyEquivalent("j"), "j"), (KeyEquivalent("k"), "k"), (.return, "\r"), (.downArrow, ""), (KeyEquivalent("?"), "?"), (KeyEquivalent("m"), "m")] {
            XCTAssertNil(SessionOverviewView.keyAction(key, characters: characters, replying: true))
        }
    }

    @MainActor func testRendersLanesWithFamiliesAndBriefs() async throws {
        _ = NSApplication.shared
        let now = Date()
        let model = SessionModel(monitorSessions: false)
        let names: [(String, String?)] = [("coord", "codex"), ("finish-cayenne-policy", "claude"), ("fix-startup-conflicts", "pi"),
                                          ("cayenne-caching-cdc", "pi"), ("upgrades", "durable"), ("orc", "claude"), ("scratch", nil)]
        model.sessions = try names.map { name, agent in
            try decode(["handle": name, "title": name, "worktreeId": "w", "worktreePath": "/Users/phillip/code/spiceai-project", "connected": true,
                        "writable": true, "agentIdentity": agent as Any? ?? NSNull()])
        }
        model.activities = ["coord": .idle, "finish-cayenne-policy": .needsAttention, "fix-startup-conflicts": .active, "cayenne-caching-cdc": .idle,
                            "upgrades": .idle, "orc": .active, "scratch": .noAgent]
        let agents = OverviewAgents()
        agents.agents = [
            "coord": AgentSummary(name: "coord", agent: "codex", state: "idle", since: now.addingTimeInterval(-1800),
                                  wakes: [AgentSummary.Wake(kind: "timer", dueAt: now.addingTimeInterval(1200))]),
            "finish-cayenne-policy": AgentSummary(name: "finish-cayenne-policy", agent: "claude", state: "permission", parent: "coord", since: now.addingTimeInterval(-120)),
            "fix-startup-conflicts": AgentSummary(name: "fix-startup-conflicts", agent: "pi", state: "working", parent: "coord", queued: 1, since: now.addingTimeInterval(-720),
                                                  pullRequests: [AgentPullRequest(repo: "spiceai/spiceai", number: 14785, url: URL(string: "https://github.com/spiceai/spiceai/pull/14785")!,
                                                                                  title: "Add a cold-start test", checkedAt: now, failing: ["Rust Lint"], ignoredFailing: ["Attestation"],
                                                                                  pending: 3, copilot: 2)]),
            "cayenne-caching-cdc": AgentSummary(name: "cayenne-caching-cdc", agent: "pi", state: "idle", since: now.addingTimeInterval(-900)),
            "upgrades": AgentSummary(name: "upgrades", agent: "durable", state: "idle", since: now.addingTimeInterval(-7200),
                                     pullRequests: [AgentPullRequest(repo: "spiceai/spiceai", number: 14788, url: URL(string: "https://github.com/spiceai/spiceai/pull/14788")!,
                                                                     checkedAt: now, handedOver: ["Flaky Benchmark"]),
                                                    AgentPullRequest(repo: "spicehq/spiceai", number: 1673, url: URL(string: "https://github.com/spicehq/spiceai/pull/1673")!, checkedAt: now)]),
            "orc": AgentSummary(name: "orc", agent: "claude", state: "working", since: now.addingTimeInterval(-3840))
        ]
        let briefs = BriefModel(monitor: false)
        func brief(_ name: String, _ headline: String, _ current: String, _ next: String, needsYou: String? = nil) -> AgentBrief {
            AgentBrief(name: name, brief: AgentBrief.Content(headline: headline, goal: "", progress: [], now: current, next: [next], needsYou: needsYou),
                       generatedAt: now, model: "lab/qwen", error: nil, generating: false)
        }
        briefs.briefs = [
            "coord": brief("coord", "Acknowledged events, idle until audit", "Acknowledged the Xcode license blocker and notified the workers; idle until the next audit.", "Audit worker progress when the wake fires."),
            "finish-cayenne-policy": AgentBrief(name: "finish-cayenne-policy", brief: AgentBrief.Content(
                headline: "Fixing Clippy errors from lint-02", goal: "Ship the Cayenne cache policy fix as one reviewed PR.",
                progress: ["The policy change and its tests are in place.", "Lint run 02 failed on 3 Clippy errors."],
                now: "Fixing the Clippy errors from lint-02 and waiting for approval to run cargo fmt.",
                next: ["Rerun lint.", "Push the fix.", "Ask for review."], needsYou: nil), generatedAt: now, model: "lab/qwen", error: nil, generating: false),
            "fix-startup-conflicts": brief("fix-startup-conflicts", "Waiting on CUDA builds, lease held", "Waiting for the CUDA builds.", "Check the build logs."),
            "cayenne-caching-cdc": brief("cayenne-caching-cdc", "PR1 lint fix signoff running on Zephyrus", "At a checkpoint; signoff attempt 2 for PR1 runs on Zephyrus with a wake armed.", "Inspect the signoff result when the wake fires.", needsYou: "Approve merging PR3 despite GitHub's stale conflict flag?"),
            "orc": brief("orc", "Reworking the session overview", "Building the self-sorting overview with lanes and families.", "Render and review the overview."),
            "upgrades": brief("upgrades", "Investigating Pi fast mode during compaction", "Idle after explaining how fast mode survives compaction.", "Wait for the next question.")
        ]
        let usage = UsageModel(monitor: false)
        usage.providers = [AgentUsage(provider: "claude", name: "Claude", plan: "Max 5x", windows: [AgentUsage.Window(kind: "session", label: "Session", usedPercent: 36, resetsAt: now.addingTimeInterval(7000))], status: .ok, error: nil, updatedAt: now),
                           AgentUsage(provider: "codex", name: "Codex", plan: "Pro", windows: [AgentUsage.Window(kind: "weekly", label: "Weekly", usedPercent: 64, resetsAt: nil)], status: .ok, error: nil, updatedAt: now)]
        let view = SessionOverviewView(model: model, briefs: briefs, usage: usage, agents: agents, monitor: false, selected: "finish-cayenne-policy")
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 900), styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        // The controller brings the view's title and toolbar into the window, as the app's window scene does.
        let controller = NSHostingController(rootView: view)
        controller.sceneBridgingOptions = .all
        window.contentViewController = controller
        window.setContentSize(NSSize(width: 1120, height: 900))
        window.orderFront(nil)
        let host = try XCTUnwrap(window.contentView?.superview)
        defer { window.close() }
        if let directory = ProcessInfo.processInfo.environment["ORC_WINDOW_SNAPSHOT_DIR"] {
            try FileManager.default.createDirectory(at: URL(fileURLWithPath: directory), withIntermediateDirectories: true)
            let shortcuts = NSHostingView(rootView: OverviewShortcuts().padding(30).background(Color(nsColor: .underPageBackgroundColor)))
            shortcuts.frame = NSRect(origin: .zero, size: shortcuts.fittingSize)
            let shot = try XCTUnwrap(shortcuts.bitmapImageRepForCachingDisplay(in: shortcuts.bounds))
            shortcuts.cacheDisplay(in: shortcuts.bounds, to: shot)
            try XCTUnwrap(shot.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: directory).appendingPathComponent("overview-shortcuts.png"))
        }
        for (width, appearance) in [(1120, NSAppearance.Name.aqua), (1120, .darkAqua), (700, .aqua)] {
            window.appearance = NSAppearance(named: appearance)
            window.setContentSize(NSSize(width: width, height: 900))
            try await Task.sleep(for: .milliseconds(300))
            host.layoutSubtreeIfNeeded()
            guard let directory = ProcessInfo.processInfo.environment["ORC_WINDOW_SNAPSHOT_DIR"] else { continue }
            let url = URL(fileURLWithPath: directory)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                .write(to: url.appendingPathComponent("overview-\(width)-\(appearance == .aqua ? "light" : "dark").png"))
        }
    }
}
