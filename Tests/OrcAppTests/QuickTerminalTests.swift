import AppKit
import XCTest
import OrcKit
@testable import OrcApp

final class QuickTerminalTests: XCTestCase {
    private func session(_ name: String, cwd: String? = nil) throws -> Session {
        var fields: [String: Any] = ["handle": "term-" + name, "title": name, "worktreeId": "fixture", "worktreePath": "/tmp",
                                     "connected": true, "writable": true]
        if let cwd { fields["cwd"] = cwd }
        return try decode(fields)
    }

    @MainActor func testASessionHasOneQuickTerminalUntilItIsClosedOrItsSessionEnds() throws {
        var started: [String] = []
        let quick = QuickTerminals { started.append($0.handle); return GhosttyView(session: $0, command: "sleep 60") }
        let a = try session("a"), b = try session("b")
        quick.open(a)
        quick.open(a)
        quick.open(b)
        XCTAssertEqual(started, [a.handle, b.handle], "opening a session's quick terminal again keeps the one it has")

        let first = try XCTUnwrap(quick.terminal(for: a.handle))
        quick.close(a.handle)
        XCTAssertNil(quick.terminal(for: a.handle))
        XCTAssertTrue(first.isDetached)

        let second = try XCTUnwrap(quick.terminal(for: b.handle))
        quick.keep([a])
        XCTAssertTrue(quick.panels.isEmpty, "a session that ended takes its quick terminal with it")
        XCTAssertTrue(second.isDetached)
    }

    /// The user's shell, here a script set as Ghostty's shell, starts in the session's folder, and the quick terminal
    /// closes when it exits.
    @MainActor func testTheShellStartsInTheSessionsFolderAndItsExitClosesTheQuickTerminal() throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orc-quick-terminal-" + UUID().uuidString)
        let folder = root.appendingPathComponent("agent folder")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("ghostty"), withIntermediateDirectories: true)
        let marker = root.appendingPathComponent("pwd")
        let shell = root.appendingPathComponent("shell")
        try Data("#!/bin/sh\npwd -P > \(shellQuote(marker.path))\n".utf8).write(to: shell)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: shell.path)
        try Data("command = \(shell.path)\n".utf8).write(to: root.appendingPathComponent("ghostty/config"))
        // The developer's own Ghostty and Orc terminal settings stay out of it.
        let keys = ["XDG_CONFIG_HOME", "HOME", "ORC_CONFIG_DIR"]
        let previous = keys.map { ProcessInfo.processInfo.environment[$0] }
        for key in keys { setenv(key, key == "ORC_CONFIG_DIR" ? root.appendingPathComponent("orc").path : root.path, 1) }
        let engine = GhosttyEngine.shared
        engine.reload(using: GhosttyEngine.makeConfig(usingGhosttySettings: true))
        defer {
            for (key, value) in zip(keys, previous) { if let value { setenv(key, value, 1) } else { unsetenv(key) } }
            engine.reload()
            try? FileManager.default.removeItem(at: root)
        }

        let quick = QuickTerminals()
        let agent = try session("agent", cwd: folder.path)
        quick.open(agent)
        let terminal = try XCTUnwrap(quick.terminal(for: agent.handle))
        let window = NSWindow(contentRect: NSRect(x: 150, y: 150, width: 600, height: 360), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = terminal
        window.orderFront(nil)
        defer { quick.keep([]); window.close() }

        let deadline = Date().addingTimeInterval(10)
        while quick.terminal(for: agent.handle) != nil, Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        XCTAssertNil(quick.terminal(for: agent.handle), "the shell exited, so its quick terminal closed")
        let started = try String(contentsOf: marker, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let real = try XCTUnwrap(realpath(folder.path, nil))
        defer { free(real) }
        XCTAssertEqual(started, String(cString: real))
    }

    func testPanelsStayInsideThePaneAtLeastTheirMinimumSize() {
        let pane = CGSize(width: 1000, height: 600)
        let first = QuickTerminals.defaultFrame(in: pane)
        XCTAssertEqual(first.maxX, pane.width - QuickTerminals.margin)
        XCTAssertEqual(first.maxY, pane.height - QuickTerminals.margin)

        // Moved past the pane's edge, a panel stops at it; a smaller pane shrinks it.
        XCTAssertEqual(QuickTerminals.fitted(CGRect(x: 900, y: -40, width: 400, height: 200), in: pane), CGRect(x: 600, y: 0, width: 400, height: 200))
        XCTAssertEqual(QuickTerminals.fitted(CGRect(x: 0, y: 0, width: 400, height: 200), in: CGSize(width: 300, height: 100)),
                       CGRect(x: 0, y: 0, width: 300, height: 100))

        // Dragging the top left corner grows the panel up and left, up to the pane's edges, and never below the minimum.
        let panel = CGRect(x: 100, y: 100, width: 400, height: 200)
        XCTAssertEqual(Grip.topLeading.resized(panel, by: CGSize(width: -500, height: -50), in: pane), CGRect(x: 0, y: 50, width: 500, height: 250))
        XCTAssertEqual(Grip.bottomTrailing.resized(panel, by: CGSize(width: -1000, height: -1000), in: pane),
                       CGRect(origin: panel.origin, size: QuickTerminals.minimumSize))
        XCTAssertEqual(Grip.trailing.resized(panel, by: CGSize(width: 2000, height: 30), in: pane), CGRect(x: 100, y: 100, width: 900, height: 200))
    }
}
