import AppKit
import XCTest
import OrcKit
@testable import OrcApp

final class TerminalCacheTests: XCTestCase {
    private func session(_ name: String) throws -> Session {
        try decode(["handle": "term-" + name, "title": name, "worktreeId": "fixture", "worktreePath": "/tmp",
                    "connected": true, "writable": true])
    }

    /// Hosts a cache whose terminals run `sleep` instead of attaching to a runtime.
    @MainActor private func hostedCache() -> (TerminalCache, NSWindow) {
        _ = NSApplication.shared
        let cache = TerminalCache { GhosttyView(session: $0, command: "sleep 60") }
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 640, height: 400), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = cache.container
        window.orderFront(nil)
        return (cache, window)
    }

    @MainActor func testSwitchingBackReusesTheTerminalAndOnlyTheShownOneIsVisibleAndSized() throws {
        let (cache, window) = hostedCache()
        defer { cache.keep([]); window.close() }
        let a = try session("a"), b = try session("b")
        cache.show(a)
        let first = try XCTUnwrap(cache.terminal(for: a.handle))
        XCTAssertFalse(first.isDetached)
        cache.show(b)
        let second = try XCTUnwrap(cache.terminal(for: b.handle))
        XCTAssertTrue(first.isHidden)
        XCTAssertFalse(second.isHidden)
        cache.show(a)
        XCTAssertTrue(cache.terminal(for: a.handle) === first, "switching back must reuse the terminal")
        XCTAssertFalse(first.isHidden)
        XCTAssertTrue(second.isHidden)
        XCTAssertEqual(cache.handles, [a.handle, b.handle])

        // Resizing the window resizes only the shown terminal.
        let hiddenFrame = second.frame
        window.setContentSize(NSSize(width: 800, height: 500))
        cache.container.layoutSubtreeIfNeeded()
        XCTAssertEqual(first.frame.size, cache.container.bounds.size)
        XCTAssertEqual(second.frame, hiddenFrame)
    }

    @MainActor func testKeepsTheTenMostRecentlyShownAndDropsEndedSessions() throws {
        let (cache, window) = hostedCache()
        defer { cache.keep([]); window.close() }
        let sessions = try (0...10).map { try session("s\($0)") }
        for session in sessions.prefix(10) { cache.show(session) }
        let s0 = try XCTUnwrap(cache.terminal(for: sessions[0].handle))
        let s1 = try XCTUnwrap(cache.terminal(for: sessions[1].handle))
        cache.show(sessions[0])
        cache.show(sessions[10])
        XCTAssertEqual(cache.handles.count, TerminalCache.limit)
        XCTAssertTrue(cache.terminal(for: sessions[0].handle) === s0, "a recently shown terminal is kept")
        XCTAssertNil(cache.terminal(for: sessions[1].handle), "the least recently shown terminal is dropped")
        XCTAssertTrue(s1.isDetached)
        XCTAssertNil(s1.superview)

        cache.keep(Array(sessions.dropFirst(5)))
        XCTAssertEqual(Set(cache.handles), Set(sessions[5...10].map(\.handle)))
        XCTAssertTrue(s0.isDetached)
    }
}
