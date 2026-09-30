import AppKit
import SwiftUI
import XCTest
import OrcKit
@testable import OrcApp

final class SessionBoardWindowTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("orc-board-window-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }

    private func session(_ handle: String, name: String? = nil, connected: Bool = true, project: String = "spiceai") throws -> Session {
        try decode(["handle": handle, "title": name ?? handle, "worktreeId": project,
                    "worktreePath": "/code/\(project)", "connected": connected, "writable": connected,
                    "agentIdentity": "Codex", "incarnationId": "fixture-process"])
    }

    @MainActor func testFailedLoadPreservesFileAndFailedSavePreservesVisibleOrganization() throws {
        let file = root.appendingPathComponent("board.json")
        let invalid = Data("not JSON".utf8)
        try invalid.write(to: file)
        let model = SessionBoardModel(file: file)
        XCTAssertFalse(model.loaded)
        XCTAssertNotNil(model.error)
        model.update { $0.addGroup("Ignored") }
        XCTAssertEqual(try Data(contentsOf: file), invalid)
        try SessionBoardStore.save(SessionBoard(), to: file)
        model.reload()
        model.update { $0.addGroup("Working") }
        XCTAssertEqual(model.board.groups.map(\.name), ["Working"])
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: true)
        model.update { $0.addGroup("Cannot save") }
        XCTAssertEqual(model.board.groups.map(\.name), ["Working"])
        XCTAssertNotNil(model.error)
    }

    @MainActor func testAttachmentRequestsUseLiveSessionAndRejectMissingOfflineOrReplacedSessions() throws {
        let model = SessionModel(monitorSessions: false)
        model.sessions = [try session("first"), try session("second")]
        model.requestAttachment(to: model.sessions[0])
        model.requestAttachment(to: model.sessions[1])
        XCTAssertEqual(model.takeAttachmentRequest()?.handle, "second")
        XCTAssertNil(model.attachmentRequest)
        XCTAssertNil(model.takeAttachmentRequest())
        model.selected = "second"
        model.requestAttachment(to: model.sessions[1])
        XCTAssertEqual(model.takeAttachmentRequest()?.handle, "second")
        model.requestAttachment(to: try session("gone"))
        XCTAssertNil(model.takeAttachmentRequest())
        XCTAssertNotNil(model.error)
        model.error = nil
        model.requestAttachment(to: model.sessions[0])
        model.sessions[0] = try session("first", connected: false)
        XCTAssertNil(model.takeAttachmentRequest())
        XCTAssertNotNil(model.error)
        model.error = nil
        model.requestAttachment(to: model.sessions[1])
        model.sessions[1] = try decode(["handle": "second", "title": "Replacement", "worktreeId": "fixture",
            "worktreePath": "/code/project", "connected": true, "writable": true, "incarnationId": "replacement"])
        XCTAssertNil(model.takeAttachmentRequest())
        XCTAssertNotNil(model.error)
    }

    @MainActor func testBoardRendersResponsiveGridAndKeepsMainSelection() async throws {
        _ = NSApplication.shared
        let model = SessionModel(monitorSessions: false)
        model.needsRuntimeSetup = false
        model.sessions = try ["Cayenne query performance", "Runtime compatibility", "SDK feature parity", "Review DataFusion changes",
                              "Lab signoff", "A long session name that should wrap without overlapping any other cards"].enumerated().map {
            try session("fixture-\($0.offset)", name: $0.element, connected: $0.offset != 4,
                        project: $0.offset == 1 ? "orc" : "spiceai")
        }
        model.selected = model.sessions[0].id
        let organization = SessionBoardModel(file: root.appendingPathComponent("board.json"))
        organization.update { board in
            board.reconcile(model.sessions)
            let working = board.addGroup("Actively working")!
            let review = board.addGroup("Waiting for review")!
            for session in model.sessions.prefix(3) { board.move(session.notesKey, to: working) }
            board.move(model.sessions[3].notesKey, to: review)
            board.addLabel("Performance", to: model.sessions[0].notesKey)
            board.addLabel("Cayenne", to: model.sessions[0].notesKey)
            board.addLabel("Enterprise", to: model.sessions[1].notesKey)
            board.addLabel("Rust", to: model.sessions[3].notesKey)
        }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 900),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: SessionBoardView(model: model, organization: organization))
        window.contentView = host
        window.orderFront(nil)
        defer { window.close() }
        for width in [1120, 700] {
            window.setContentSize(NSSize(width: width, height: 900))
            try await Task.sleep(for: .milliseconds(250))
            host.layoutSubtreeIfNeeded()
            XCTAssertEqual(model.selected, "fixture-0")
            XCTAssertNil(model.attachmentRequest)
            XCTAssertEqual(organization.board.cards.count, model.sessions.count)
            if let directory = ProcessInfo.processInfo.environment["ORC_BOARD_SNAPSHOT_DIR"] {
                let url = URL(fileURLWithPath: directory)
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                    .write(to: url.appendingPathComponent("board-\(width).png"))
            }
        }
        XCTAssertNotNil(NSImage(systemSymbolName: "tag", accessibilityDescription: nil))
    }
}
