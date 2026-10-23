import AppKit
import SwiftUI
import XCTest
import OrcKit
@testable import OrcApp

final class SessionSidebarTests: XCTestCase {
    private func sessions() throws -> [Session] {
        try ["alpha", "alpha-review", "beta", "gamma"].map {
            try decode(["handle": $0, "title": $0, "worktreeId": "sidebar-fixture", "worktreePath": "/code/project",
                        "connected": false, "writable": false, "tabId": $0, "leafId": "leaf"])
        }
    }

    @MainActor func testMoveIsSavedToTheRuntimeAndReadBackWithoutChangingSelection() async throws {
        let model = SessionModel(monitorSessions: false)
        model.sessions = try sessions()
        model.selected = "alpha-review"
        let runtime = RuntimeOrder()
        let sidebar = SessionSidebarModel(store: .memory(runtime), monitor: false)
        sidebar.move(fromOffsets: [0], toOffset: 1, rows: sidebar.order.rows(in: model.hierarchy), search: "")
        XCTAssertEqual(sidebar.order, SessionSidebarOrder(), "nothing moves until the order is read")
        await sidebar.reload()
        XCTAssertEqual(sidebar.order.rows(in: model.hierarchy).map(\.id), ["alpha", "alpha-review", "beta", "gamma"])
        sidebar.move(fromOffsets: [3], toOffset: 0, rows: sidebar.order.rows(in: model.hierarchy), search: "")
        XCTAssertEqual(sidebar.order.rows(in: model.hierarchy).map(\.id), ["gamma", "alpha", "alpha-review", "beta"], "a drag shows at once")
        try await until { runtime.keys == ["gamma", "alpha", "beta"] }
        XCTAssertNil(sidebar.error)
        XCTAssertEqual(model.selected, "alpha-review")
        XCTAssertNil(model.attachmentRequest)
        model.sessions.reverse()
        XCTAssertEqual(sidebar.order.rows(in: model.hierarchy).map(\.id), ["gamma", "alpha", "alpha-review", "beta"])

        // The order changed elsewhere, as by a tab moved in Rex.
        runtime.keys = ["beta", "gamma", "alpha"]
        await sidebar.reload()
        XCTAssertEqual(sidebar.order.rows(in: model.hierarchy).map(\.id), ["beta", "gamma", "alpha", "alpha-review"])
    }

    @MainActor func testSearchDisablesReordering() async throws {
        let hierarchy = SessionHierarchy(sessions: try sessions())
        let runtime = RuntimeOrder()
        let sidebar = SessionSidebarModel(store: .memory(runtime), monitor: false)
        await sidebar.reload()
        let rows = sidebar.order.rows(in: hierarchy, matching: "a")
        sidebar.move(fromOffsets: [3], toOffset: 0, rows: rows, search: "a")
        XCTAssertEqual(sidebar.order, SessionSidebarOrder())
        XCTAssertEqual(runtime.saves, 0)
    }

    @MainActor func testAFailedSaveIsReportedAndTheRuntimesOrderComesBack() async throws {
        let hierarchy = SessionHierarchy(sessions: try sessions())
        let runtime = RuntimeOrder()
        runtime.reachable = false
        let sidebar = SessionSidebarModel(store: .memory(runtime), monitor: false)
        await sidebar.reload()
        XCTAssertFalse(sidebar.loaded)
        runtime.reachable = true
        await sidebar.reload()
        runtime.reachable = false
        sidebar.move(fromOffsets: [3], toOffset: 2, rows: sidebar.order.rows(in: hierarchy), search: "")
        XCTAssertEqual(sidebar.order.rows(in: hierarchy).map(\.id), ["alpha", "alpha-review", "gamma", "beta"])
        try await until { sidebar.error != nil }
        runtime.reachable = true
        await sidebar.reload()
        XCTAssertEqual(sidebar.order, SessionSidebarOrder())
    }

    @MainActor private func until(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !condition() {
            guard Date() < deadline else { throw OrcError("Timed out") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    @MainActor func testSidebarListShowsCollapsibleProjectSectionsWithNativeReordering() async throws {
        _ = NSApplication.shared
        let model = SessionModel(monitorSessions: false)
        model.sessions = try sessions() + [try decode(["handle": "delta", "title": "delta", "worktreeId": "other-fixture",
            "worktreePath": "/code/other", "connected": false, "writable": false, "tabId": "delta", "leafId": "leaf"])]
        let sidebar = SessionSidebarModel(store: .memory(), monitor: false)
        await sidebar.reload()
        var collapsed: Set<String> = []
        func list() -> SessionSidebarList<Text> {
            SessionSidebarList(organization: sidebar, sections: sidebar.order.sections(of: model.sessions, workspaces: []),
                collapsedProjects: Binding(get: { collapsed }, set: { collapsed = $0 }),
                selection: Binding(get: { model.selected }, set: { model.selected = $0 })) { _, row in Text(row.session.name) }
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 560),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: list())
        window.contentView = host
        window.orderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(250))
        host.layoutSubtreeIfNeeded()
        let table = try XCTUnwrap(descendant(NSOutlineView.self, in: host))
        // A header per project, then its sessions.
        XCTAssertEqual(table.numberOfRows, 7)
        // Clicking empty space clears the selection.
        XCTAssertTrue(table.allowsEmptySelection)
        let item = try XCTUnwrap(table.item(atRow: 4))
        XCTAssertNotNil(table.dataSource?.outlineView?(table, pasteboardWriterForItem: item),
                        "Sidebar rows must support native dragging")
        sidebar.move(fromOffsets: [3], toOffset: 0, rows: sidebar.order.sections(of: model.sessions, workspaces: [])[0].rows, search: "")
        XCTAssertEqual(sidebar.order.sections(of: model.sessions, workspaces: [])[0].rows.map(\.id), ["gamma", "alpha", "alpha-review", "beta"])
        XCTAssertNil(model.selected)
        // Collapsing a project hides its sessions.
        collapsed = ["sidebar-fixture"]
        host.rootView = list()
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(table.numberOfRows, 3)
        // The sidebar's own disclosure control on the header expands it again.
        table.expandItem(try XCTUnwrap(table.item(atRow: 0)))
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(collapsed, [])
    }

    @MainActor private func descendant<T: NSView>(_ type: T.Type, in view: NSView) -> T? {
        if let match = view as? T { return match }
        return view.subviews.lazy.compactMap { self.descendant(type, in: $0) }.first
    }
}

/// The order as a runtime keeps it, in memory.
final class RuntimeOrder: @unchecked Sendable {
    var keys: [String] = []
    var reachable = true
    private(set) var saves = 0

    func load() throws -> [String] {
        guard reachable else { throw OrcError("The runtime is not running.") }
        return keys
    }

    func save(_ keys: [String]) throws {
        guard reachable else { throw OrcError("The runtime is not running.") }
        self.keys = keys
        saves += 1
    }
}

extension SessionOrderStore {
    static func memory(_ runtime: RuntimeOrder = RuntimeOrder()) -> SessionOrderStore {
        SessionOrderStore(load: { try runtime.load() }, save: { try runtime.save($0) })
    }
}
