import AppKit
import XCTest
import OrcKit
@testable import OrcApp

final class TerminalMarkdownClickTests: XCTestCase {
    @MainActor private func waitFor(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(10)
        while !condition() {
            guard Date() < deadline else { throw OrcError("Timed out waiting for terminal mouse input") }
            try await Task.sleep(for: .milliseconds(25))
        }
    }

    @MainActor func testMarkdownClicksStayNativeWhileDragsAndOtherClicksReachTheTerminal() async throws {
        _ = NSApplication.shared
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("orc-markdown-mouse-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let document = root.appendingPathComponent("report.md").standardizedFileURL
        try Data("# Report\n\n## Details\n\nRead-only preview.".utf8).write(to: document)
        let events = root.appendingPathComponent("events")
        let ready = root.appendingPathComponent("ready")
        let script = root.appendingPathComponent("mouse.py")
        try Data(#"""
        import os, pathlib, sys, tty
        tty.setraw(sys.stdin.fileno())
        uri, events, ready = sys.argv[1:]
        sys.stdout.write('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[2J\x1b[H')
        sys.stdout.write('\x1b]8;;' + uri + '\x07Report\x1b]8;;\x07        ')
        sys.stdout.write('\x1b]8;;https://example.invalid/\x07EXTERNAL_LINK\x1b]8;;\x07')
        sys.stdout.flush()
        pathlib.Path(ready).touch()
        while True:
            data = os.read(sys.stdin.fileno(), 4096)
            if not data: break
            with open(events, 'ab') as stream: stream.write(data)
        """#.utf8).write(to: script)
        let session: Session = try decode(["handle": "markdown-mouse-fixture", "worktreeId": "fixture",
                                          "worktreePath": root.path, "connected": false, "writable": false])
        let command = (["/usr/bin/python3", "-u", script.path, document.path + "#details", events.path, ready.path])
            .map(shellQuote).joined(separator: " ")
        let terminal = GhosttyView(session: session, command: command)
        let window = NSWindow(contentRect: NSRect(x: 150, y: 150, width: 800, height: 480),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = terminal; window.makeKeyAndOrderFront(nil)
        defer {
            MarkdownWindowController.documents[document]?.close()
            terminal.detach(); window.close()
        }
        try await waitFor { FileManager.default.fileExists(atPath: ready.path) }
        try await Task.sleep(for: .milliseconds(200))
        func event(_ type: NSEvent.EventType, x: CGFloat, modifiers: NSEvent.ModifierFlags = [], count: Int = 1) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: terminal.convert(NSPoint(x: x, y: 8), to: nil),
                modifierFlags: modifiers, timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: count, pressure: 0)!
        }
        func received() -> String { (try? String(contentsOf: events, encoding: .utf8)) ?? "" }
        func clearEvents() throws { try Data().write(to: events) }
        func click(x: CGFloat, modifiers: NSEvent.ModifierFlags = [], count: Int = 1) {
            terminal.mouseDown(with: event(.leftMouseDown, x: x, modifiers: modifiers, count: count))
            terminal.mouseUp(with: event(.leftMouseUp, x: x, modifiers: modifiers, count: count))
        }
        for modifiers: NSEvent.ModifierFlags in [[], .command] {
            try clearEvents()
            click(x: 20, modifiers: modifiers)
            try await waitFor { MarkdownWindowController.documents[document]?.model.document != nil }
            let controller = try XCTUnwrap(MarkdownWindowController.documents[document])
            XCTAssertEqual(controller.model.mode, .rendered)
            XCTAssertEqual(controller.model.fragment, "details")
            XCTAssertNil(controller.model.error)
            XCTAssertEqual(received(), "", "The terminal application must not receive a Markdown click and invoke its system opener")
            controller.close()
        }

        try clearEvents()
        terminal.mouseDown(with: event(.leftMouseDown, x: 20))
        terminal.mouseDragged(with: event(.leftMouseDragged, x: 55))
        terminal.mouseUp(with: event(.leftMouseUp, x: 55))
        try await waitFor { received().contains("m") }
        XCTAssertTrue(received().contains("\u{1b}[<0;"), "The original press must be replayed for selection")
        XCTAssertTrue(received().contains("\u{1b}[<32;"), "The drag must reach the terminal application")
        XCTAssertNil(MarkdownWindowController.documents[document])

        for (x, count) in [(CGFloat(160), 1), (CGFloat(500), 1), (CGFloat(20), 2)] {
            try clearEvents()
            click(x: x, count: count)
            try await waitFor { received().contains("m") }
            XCTAssertTrue(received().contains("\u{1b}[<0;"))
            XCTAssertNil(MarkdownWindowController.documents[document], "Web links, ordinary text, and double-click selection must retain terminal handling")
        }
    }
}
