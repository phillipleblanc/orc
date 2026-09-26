import XCTest
@testable import OrcKit

final class SessionBoardTests: XCTestCase {
    private func session(_ handle: String, pane: String? = nil, title: String? = nil) -> Session {
        var session = Session(handle: handle, title: title ?? handle, worktreeId: "project", worktreePath: "/code/project",
                              connected: true, writable: true, agentIdentity: "pi", incarnationId: "process")
        session.tabId = pane
        session.leafId = pane.map { _ in "leaf" }
        return session
    }

    func testMovesWithinGridAndAcrossGroupsWithoutDuplicates() throws {
        let sessions = [session("a"), session("b"), session("c"), session("d")]
        var board = SessionBoard()
        board.reconcile(sessions)
        board.move("d", to: nil, before: "b")
        XCTAssertEqual(board.sessions(in: nil, from: sessions).map(\.handle), ["a", "d", "b", "c"])
        board.move("a", to: nil, before: "c")
        XCTAssertEqual(board.sessions(in: nil, from: sessions).map(\.handle), ["d", "b", "a", "c"])
        let group = try XCTUnwrap(board.addGroup(" Waiting for review "))
        board.move("a", to: group)
        board.move("c", to: group, before: "a")
        XCTAssertEqual(board.sessions(in: group, from: sessions).map(\.handle), ["c", "a"])
        XCTAssertEqual(board.sessions(in: nil, from: sessions).map(\.handle), ["d", "b"])
        board.move("c", to: group)
        XCTAssertEqual(board.sessions(in: group, from: sessions).map(\.handle), ["a", "c"])
        board.reconcile(sessions.reversed())
        XCTAssertEqual(Set(board.order).count, sessions.count)
        XCTAssertEqual(board.order.count, sessions.count)
        let before = board
        board.move("missing", to: group)
        board.move("a", to: "missing")
        board.move("a", to: group, before: "a")
        board.move("a", to: group, before: "d")
        XCTAssertEqual(board, before)
    }

    func testLabelsAreReusableAndGroupsCanBeRenamedReorderedAndRemoved() throws {
        let sessions = [session("a"), session("b")]
        var board = SessionBoard()
        board.reconcile(sessions)
        XCTAssertNil(board.addGroup("  \n"))
        let first = try XCTUnwrap(board.addGroup("Active"))
        let second = try XCTUnwrap(board.addGroup("Review"))
        board.move("a", to: first)
        let label = try XCTUnwrap(board.addLabel(" Lab signoff ", to: "a"))
        XCTAssertEqual(board.addLabel("lab SIGNOFF", to: "b"), label)
        XCTAssertEqual(board.labels.count, 1)
        board.toggleLabel(label, for: "a")
        board.toggleLabel(label, for: "b")
        XCTAssertEqual(board.labels.count, 1, "Unused labels remain available for reuse")
        board.toggleLabel(label, for: "a")
        board.renameGroup(first, to: " Actively working ")
        board.moveGroup(second, by: -1)
        XCTAssertEqual(board.groups.map(\.name), ["Review", "Actively working"])
        board.removeGroup(first)
        XCTAssertEqual(board.sessions(in: nil, from: sessions).count, 2)
        XCTAssertEqual(board.labels(for: "a").map(\.id), [label])
        XCTAssertEqual(board.groups.map(\.id), [second])
        let before = board
        board.moveGroup(second, by: -1)
        board.renameGroup(second, to: "  ")
        XCTAssertNil(board.addLabel("  ", to: "a"))
        XCTAssertEqual(board, before)
    }

    func testOrganizationSurvivesRenameHandleChangesAndMissingInventory() throws {
        let old = session("old", pane: "stable", title: "Before rename")
        let fresh = session("fresh", pane: "stable", title: "After rename")
        let other = session("other")
        var board = SessionBoard()
        board.reconcile([old, other])
        let group = try XCTUnwrap(board.addGroup("Working"))
        board.move(old.notesKey, to: group)
        let label = board.addLabel("Backend", to: old.notesKey)
        let before = board
        board.reconcile([])
        board.reconcile([other])
        board.reconcile([fresh, other])
        XCTAssertEqual(board, before)
        XCTAssertEqual(board.sessions(in: group, from: [fresh, other]).map(\.handle), ["fresh"])
        XCTAssertEqual(board.labels(for: fresh.notesKey).first?.id, label)
    }

    func testRoundTripPrivateProfileScopedStorageAndCorruptData() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("orc-board-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = SessionBoardStore.file(config: directory, profile: directory.appendingPathComponent("one"))
        let other = SessionBoardStore.file(config: directory, profile: directory.appendingPathComponent("two"))
        XCTAssertNotEqual(file, other)
        XCTAssertEqual(try SessionBoardStore.load(from: file), SessionBoard())
        var board = SessionBoard()
        board.reconcile([session("a")])
        let group = try XCTUnwrap(board.addGroup("Waiting"))
        board.move("a", to: group)
        board.addLabel("Review", to: "a")
        try SessionBoardStore.save(board, to: file)
        XCTAssertEqual(try SessionBoardStore.load(from: file), board)
        XCTAssertEqual(try SessionBoardStore.load(from: other), SessionBoard())
        let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
        try Data("invalid JSON".utf8).write(to: file)
        XCTAssertThrowsError(try SessionBoardStore.load(from: file))
    }
}
