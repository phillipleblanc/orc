import AppKit
import XCTest
import OrcKit
@testable import OrcApp

final class GhosttyRepliesTests: XCTestCase {
    /// The runtime answers a session's OSC 7501 query. The app's Ghostty runs `orc attach`, so a reply from it would
    /// reach the program as a second, typed reply. A Ghostty that answers the query needs it turned off for Orc.
    @MainActor func testTheAppsGhosttyLeavesTheProgramStatusQueryToTheRuntime() async throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orc-ghostty-replies-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let replies = root.appendingPathComponent("replies")
        let script = root.appendingPathComponent("query.py")
        // Ghostty answers in order and always answers device attributes, so their reply ends whatever it sent.
        try Data(#"""
        import os, sys, tty
        tty.setraw(sys.stdin.fileno())
        replies = sys.argv[1]
        os.write(1, b'\x1b]7501;?\x1b\\\x1b[c')
        data = b''
        while not data.endswith(b'c'):
            chunk = os.read(0, 4096)
            if not chunk: break
            data += chunk
        with open(replies + '.tmp', 'wb') as stream: stream.write(data)
        os.rename(replies + '.tmp', replies)
        """#.utf8).write(to: script)
        let session: Session = try decode(["handle": "ghostty-replies-fixture", "worktreeId": "fixture",
                                          "worktreePath": root.path, "connected": false, "writable": false])
        let terminal = GhosttyView(session: session, command: ["/usr/bin/python3", "-u", script.path, replies.path].map(shellQuote).joined(separator: " "))
        let window = NSWindow(contentRect: NSRect(x: 150, y: 150, width: 800, height: 480),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = terminal; window.makeKeyAndOrderFront(nil)
        defer { terminal.detach(); window.close() }

        let deadline = Date().addingTimeInterval(10)
        while !FileManager.default.fileExists(atPath: replies.path) {
            guard Date() < deadline else { throw OrcError("Timed out waiting for Ghostty's replies") }
            try await Task.sleep(for: .milliseconds(25))
        }
        let received = String(decoding: try Data(contentsOf: replies), as: UTF8.self)
        XCTAssertTrue(received.contains("\u{1b}[?"), "Ghostty did not answer device attributes: \(received.debugDescription)")
        XCTAssertFalse(received.contains("\u{1b}]7501"), "The app's Ghostty answered the OSC 7501 query: \(received.debugDescription)")
    }
}
