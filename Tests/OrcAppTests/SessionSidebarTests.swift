import AppKit
import SwiftUI
import XCTest
import OrcKit
@testable import OrcApp

final class SessionSidebarTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("orc-sidebar-window-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

    private func sessions() throws -> [Session] {
        try ["alpha", "alpha-review", "beta", "gamma"].map {
            try decode(["handle": $0, "title": $0, "worktreeId": "sidebar-fixture", "worktreePath": "/code/project",
                        "connected": false, "writable": false, "tabId": $0, "leafId": "leaf"])
        }
    }

    @MainActor func testMovePersistsAcrossReloadAndRefreshWithoutChangingSelection() throws {
        let model = SessionModel(monitorSessions: false)
        model.sessions = try sessions()
        model.selected = "alpha-review"
        let file = root.appendingPathComponent("order.json")
        let sidebar = SessionSidebarModel(file: file)
        XCTAssertEqual(sidebar.order.rows(in: model.hierarchy).map(\.id), ["alpha", "alpha-review", "beta", "gamma"])
        sidebar.move(fromOffsets: [3], toOffset: 0, rows: sidebar.order.rows(in: model.hierarchy), search: "")
        XCTAssertNil(sidebar.error)
        XCTAssertEqual(sidebar.order.rows(in: model.hierarchy).map(\.id), ["gamma", "alpha", "alpha-review", "beta"])
        XCTAssertEqual(model.selected, "alpha-review")
        XCTAssertNil(model.attachmentRequest)
        model.sessions.reverse()
        XCTAssertEqual(sidebar.order.rows(in: model.hierarchy).map(\.id), ["gamma", "alpha", "alpha-review", "beta"])
        let reloaded = SessionSidebarModel(file: file)
        XCTAssertEqual(reloaded.order, sidebar.order)
        reloaded.move("gamma", by: 1, rows: reloaded.order.rows(in: model.hierarchy), search: "")
        XCTAssertEqual(reloaded.order.rows(in: model.hierarchy).map(\.id), ["alpha", "alpha-review", "gamma", "beta"])
    }

    @MainActor func testSearchDisablesBothDragAndMenuReordering() throws {
        let hierarchy = SessionHierarchy(sessions: try sessions())
        let file = root.appendingPathComponent("order.json")
        let sidebar = SessionSidebarModel(file: file)
        let rows = sidebar.order.rows(in: hierarchy, matching: "a")
        sidebar.move(fromOffsets: [3], toOffset: 0, rows: rows, search: "a")
        sidebar.move("gamma", by: -1, rows: rows, search: "a")
        XCTAssertEqual(sidebar.order, SessionSidebarOrder())
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    @MainActor func testFailedLoadPreservesFileAndFailedSavePreservesVisibleOrder() throws {
        let hierarchy = SessionHierarchy(sessions: try sessions())
        let file = root.appendingPathComponent("order.json")
        let invalid = Data("not JSON".utf8)
        try invalid.write(to: file)
        let sidebar = SessionSidebarModel(file: file)
        XCTAssertFalse(sidebar.loaded)
        XCTAssertNotNil(sidebar.error)
        sidebar.move("gamma", by: -1, rows: sidebar.order.rows(in: hierarchy), search: "")
        XCTAssertEqual(try Data(contentsOf: file), invalid)
        try SessionSidebarOrderStore.save(SessionSidebarOrder(), to: file)
        sidebar.reload()
        sidebar.move("gamma", by: -1, rows: sidebar.order.rows(in: hierarchy), search: "")
        XCTAssertEqual(sidebar.order.rows(in: hierarchy).map(\.id), ["alpha", "alpha-review", "gamma", "beta"])
        let saved = sidebar.order
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: true)
        sidebar.move("gamma", by: -1, rows: sidebar.order.rows(in: hierarchy), search: "")
        XCTAssertEqual(sidebar.order, saved)
        XCTAssertNotNil(sidebar.error)
    }

    @MainActor func testSidebarListSupportsNativeReordering() async throws {
        _ = NSApplication.shared
        let model = SessionModel(monitorSessions: false)
        model.needsRuntimeSetup = false
        model.sessions = try sessions()
        let sidebar = SessionSidebarModel(file: root.appendingPathComponent("order.json"))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 560),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: SessionSidebarList(organization: sidebar, hierarchy: model.hierarchy,
            search: "", collapsed: [], selection: Binding(get: { model.selected }, set: { model.selected = $0 })) { row in
                Text(row.session.name)
            })
        window.contentView = host
        window.orderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(250))
        host.layoutSubtreeIfNeeded()
        let table = try XCTUnwrap(descendant(NSOutlineView.self, in: host))
        XCTAssertEqual(table.numberOfRows, 4)
        let item = try XCTUnwrap(table.item(atRow: 3))
        XCTAssertNotNil(table.dataSource?.outlineView?(table, pasteboardWriterForItem: item),
                        "Sidebar rows must support native dragging")
        sidebar.move(fromOffsets: [3], toOffset: 0, rows: sidebar.order.rows(in: model.hierarchy), search: "")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(sidebar.order.rows(in: model.hierarchy).map(\.id), ["gamma", "alpha", "alpha-review", "beta"])
        XCTAssertNil(model.selected)
        XCTAssertEqual(table.numberOfRows, 4)
        host.rootView = SessionSidebarList(organization: sidebar, hierarchy: model.hierarchy,
            search: "a", collapsed: [], selection: Binding(get: { model.selected }, set: { model.selected = $0 })) { row in
                Text(row.session.name)
            }
        try await Task.sleep(for: .milliseconds(100))
        let filteredItem = try XCTUnwrap(table.item(atRow: 0))
        XCTAssertNil(table.dataSource?.outlineView?(table, pasteboardWriterForItem: filteredItem),
                     "Searching must disable native dragging")
    }

    @MainActor private func descendant<T: NSView>(_ type: T.Type, in view: NSView) -> T? {
        if let match = view as? T { return match }
        return view.subviews.lazy.compactMap { self.descendant(type, in: $0) }.first
    }
}
