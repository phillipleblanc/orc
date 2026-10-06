import AppKit
import SwiftUI
import XCTest
import OrcKit
@testable import OrcApp

final class SessionWindowTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("orc-session-window-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

    @MainActor func testSelectingAndClosingSessionsKeepsTheWindowSizeAndShowsAPlaceholder() async throws {
        _ = NSApplication.shared
        let model = SessionModel(monitorSessions: false)
        model.workspaces = [try decode(["id": "window-fixture", "path": "/code/project"])]
        model.sessions = try ["alpha", "beta"].map {
            try decode(["handle": $0, "title": $0, "worktreeId": "window-fixture", "worktreePath": "/code/project",
                        "connected": false, "writable": false, "agentIdentity": "pi"])
        }
        let view = SessionWindow(model: model, sidebarOrder: SessionSidebarModel(file: root.appendingPathComponent("order.json")),
                                 usage: UsageModel(monitor: false), briefs: BriefModel(monitor: false))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 700),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: view)
        window.contentView = host
        window.orderFront(nil)
        defer { window.close() }
        func settle(_ name: String) async throws {
            try await Task.sleep(for: .milliseconds(200))
            host.layoutSubtreeIfNeeded()
            if let directory = ProcessInfo.processInfo.environment["ORC_WINDOW_SNAPSHOT_DIR"] {
                let url = URL(fileURLWithPath: directory)
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: url.appendingPathComponent("\(name).png"))
            }
        }
        try await settle("loading")
        let frame = window.frame
        XCTAssertEqual(view.placeholder, .loading)

        model.connected = true
        try await settle("no-selection")
        XCTAssertEqual(view.placeholder, .noSelection)
        model.selected = "alpha"
        try await settle("offline")
        XCTAssertEqual(view.placeholder, .offline("alpha"))
        XCTAssertEqual(window.frame, frame)

        // Closing the selected session leaves the window as it was.
        model.sessions.removeAll { $0.name == "alpha" }
        model.selected = nil
        try await settle("closed")
        XCTAssertEqual(view.placeholder, .noSelection)
        XCTAssertEqual(window.frame, frame)

        model.sessions = []
        try await settle("no-sessions")
        XCTAssertEqual(view.placeholder, .noSessions)
        model.workspaces = []
        try await settle("no-projects")
        XCTAssertEqual(view.placeholder, .noProjects)
        model.connected = false
        model.error = "connection refused"
        try await settle("not-connected")
        XCTAssertEqual(view.placeholder, .runtimeNotConnected)
        XCTAssertEqual(window.frame, frame)
    }
}
