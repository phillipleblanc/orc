import XCTest
@testable import OrcKit

final class SessionBoardTests: XCTestCase {
    private func session(_ handle: String, title: String? = nil, project: String = "project") -> Session {
        Session(handle: handle, title: title ?? handle, worktreeId: project, worktreePath: "/code/\(project)",
                connected: true, writable: true, agentIdentity: "pi", incarnationId: "process")
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

    func testOrganizationSurvivesHandleChangesAndMissingInventory() throws {
        let old = session("old", title: "Same name")
        let fresh = session("fresh", title: "Same name")
        let other = session("other")
        var board = SessionBoard()
        board.reconcile([old, other])
        let group = try XCTUnwrap(board.addGroup("Working"))
        board.move(old.name, to: group)
        let label = board.addLabel("Backend", to: old.name)
        let before = board
        board.reconcile([])
        board.reconcile([other])
        board.reconcile([fresh, other])
        XCTAssertEqual(board, before)
        XCTAssertEqual(board.sessions(in: group, from: [fresh, other]).map(\.handle), ["fresh"])
        XCTAssertEqual(board.labels(for: fresh.name).first?.id, label)
    }

    func testLabelsAreReusableOnlyWithinTheirProject() throws {
        let sessions = [session("spice", project: "spiceai"), session("other-spice", project: "spiceai"),
                        session("orc", project: "orc")]
        var board = SessionBoard()
        board.reconcile(sessions)
        let spiceLabel = try XCTUnwrap(board.addLabel(" Sumac ", to: "spice"))
        XCTAssertEqual(board.addLabel("súmac", to: "other-spice"), spiceLabel)
        XCTAssertEqual(board.availableLabels(for: "other-spice").map(\.id), [spiceLabel])
        XCTAssertTrue(board.availableLabels(for: "orc").isEmpty)
        board.toggleLabel(spiceLabel, for: "orc")
        XCTAssertTrue(board.labels(for: "orc").isEmpty)

        let orcLabel = try XCTUnwrap(board.addLabel("Sumac", to: "orc"))
        XCTAssertNotEqual(orcLabel, spiceLabel)
        XCTAssertEqual(board.labels(in: "orc").map(\.id), [orcLabel])
        XCTAssertEqual(board.labels(in: "spiceai").map(\.id), [spiceLabel])
        board.toggleLabel(orcLabel, for: "orc")
        XCTAssertTrue(board.labels(for: "orc").isEmpty)
        XCTAssertEqual(board.availableLabels(for: "orc").map(\.id), [orcLabel])
        XCTAssertNil(board.addLabel("Unknown", to: "missing"))
        board.reconcile([])
        XCTAssertEqual(board.labels().count, 2)
    }

    func testLegacyLabelsMigrateByProjectAcrossPartialInventoriesAndReloads() throws {
        let legacy = """
        {"groups":[{"id":"group","name":"Working"}],
         "labels":[{"id":"shared","name":"Sumac"},{"id":"unused","name":"Unused"}],
         "cards":{"spice":{"groupID":"group","labelIDs":["shared"]},
                  "orc":{"labelIDs":["shared"]},"returning":{"labelIDs":["shared"]}},
         "order":["spice","orc","returning"]}
        """
        var board = try JSONDecoder().decode(SessionBoard.self, from: Data(legacy.utf8))
        XCTAssertTrue(board.labels().isEmpty, "Labels with unknown ownership must not appear in every project")
        board.reconcile([session("spice", project: "spiceai")])
        let spiceLabel = try XCTUnwrap(board.labels(for: "spice").first)
        XCTAssertEqual(spiceLabel.projectID, "spiceai")
        XCTAssertEqual(spiceLabel.name, "Sumac")
        XCTAssertEqual(board.cards["spice"]?.groupID, "group")
        XCTAssertEqual(board.cards["orc"]?.labelIDs, ["shared"])

        board = try JSONDecoder().decode(SessionBoard.self, from: JSONEncoder().encode(board))
        board.reconcile([session("orc", project: "orc"), session("returning", project: "spiceai")])
        let orcLabel = try XCTUnwrap(board.labels(for: "orc").first)
        XCTAssertEqual(orcLabel.projectID, "orc")
        XCTAssertNotEqual(orcLabel.id, spiceLabel.id)
        XCTAssertEqual(board.labels(for: "returning"), [spiceLabel])
        XCTAssertEqual(board.labels().count, 2)
        XCTAssertEqual(board.order, ["spice", "orc", "returning"])
        let migrated = board
        board.reconcile([session("spice", project: "spiceai"), session("orc", project: "orc")])
        XCTAssertEqual(board, migrated, "Reconciliation must preserve scoped label identities")
    }

    func testProjectLabelAndSearchFiltersCompose() throws {
        let sessions = [session("spice", title: "Review engine", project: "spiceai"),
                        session("other-spice", title: "Review docs", project: "spiceai"),
                        session("orc", title: "Review UI", project: "orc")]
        var board = SessionBoard()
        board.reconcile(sessions)
        let spiceLabel = try XCTUnwrap(board.addLabel("Sumac", to: "Review engine"))
        board.addLabel("Sumac", to: "Review UI")
        func filtered(_ project: String? = nil, label: String? = nil, search: String = "") -> [String] {
            board.filteredSessions(from: sessions, project: SessionProjectFilter(projectID: project),
                                   labelID: label, search: search).map(\.id)
        }
        XCTAssertEqual(filtered(), ["spice", "other-spice", "orc"])
        XCTAssertEqual(filtered("spiceai"), ["spice", "other-spice"])
        XCTAssertEqual(filtered("spiceai", label: spiceLabel, search: "review"), ["spice"])
        XCTAssertEqual(filtered("spiceai", search: "sumac"), ["spice"])
        XCTAssertEqual(filtered(label: spiceLabel), ["spice"])
        XCTAssertTrue(filtered("orc", label: spiceLabel).isEmpty)
        XCTAssertTrue(filtered("spiceai", label: spiceLabel, search: "docs").isEmpty)
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

    func testGroupOfASessionIsItsOverviewGroupUnlessUngrouped() throws {
        let session: Session = try decode(["handle": "h", "title": "coord", "worktreeId": "p", "worktreePath": "/code/p", "connected": true, "writable": true])
        var board = SessionBoard()
        board.reconcile([session])
        XCTAssertNil(board.group(of: "coord"))
        let priority = try XCTUnwrap(board.addGroup("Priority"))
        board.move("coord", to: priority)
        XCTAssertEqual(board.group(of: "coord")?.name, "Priority")
        board.renameGroup(priority, to: "Urgent")
        XCTAssertEqual(board.group(of: "coord")?.name, "Urgent")
        board.move("coord", to: nil)
        XCTAssertNil(board.group(of: "coord"))
        XCTAssertNil(board.group(of: "unknown"))
    }
}
