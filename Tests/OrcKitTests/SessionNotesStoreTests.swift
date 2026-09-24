import Foundation
import XCTest
@testable import OrcKit

final class SessionNotesStoreTests: XCTestCase {
    func testMigratesLegacyNoteAndReadsExternalEdits() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("orc-notes-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let previous = getenv("ORC_CONFIG_DIR").map { String(cString: $0) }
        setenv("ORC_CONFIG_DIR", directory.path, 1)
        defer {
            if let previous { setenv("ORC_CONFIG_DIR", previous, 1) }
            else { unsetenv("ORC_CONFIG_DIR") }
            try? FileManager.default.removeItem(at: directory)
        }

        let handle = "term_b3f5b332-fcf9-4bde-8563-f74843456f6f"
        let suite = "dev.phillipleblanc.orc.notes-test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("From the app\nsecond line", forKey: "sessionNotes.\(handle)")
        SessionNotesStore.migrateLegacyPreferences(defaults)
        let file = try SessionNotesStore.file(for: handle)
        XCTAssertEqual(try String(contentsOf: file), "From the app\nsecond line")
        try "Changed in nvim\n".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(try SessionNotesStore.load(handle: handle, legacy: "Stale app preference"), "Changed in nvim\n")
        try SessionNotesStore.save("Changed in Orc", handle: handle)
        XCTAssertEqual(try String(contentsOf: file), "Changed in Orc")
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertThrowsError(try SessionNotesStore.file(for: "../another-session"))
    }

    func testNotesFollowPaneWhenOrcaRemintsTerminalHandle() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("orc-pane-notes-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let previous = getenv("ORC_CONFIG_DIR").map { String(cString: $0) }
        setenv("ORC_CONFIG_DIR", directory.path, 1)
        defer {
            if let previous { setenv("ORC_CONFIG_DIR", previous, 1) }
            else { unsetenv("ORC_CONFIG_DIR") }
            try? FileManager.default.removeItem(at: directory)
        }

        let tab = "b72be201-998f-4848-ba22-ae325c667a6c"
        let leaf = "7d91e62b-a21a-4b91-a828-a868477edfa1"
        let oldHandle = "term_before_restart"
        try SessionNotesStore.save("Keep this note", handle: oldHandle)
        func session(_ handle: String) throws -> Session {
            try decode(["handle": handle, "title": "sidecar", "worktreeId": "project",
                        "worktreePath": "/code/project", "connected": true, "writable": true,
                        "tabId": tab, "leafId": leaf], as: Session.self)
        }
        let before = try session(oldHandle)
        let after = try session("term_after_restart")
        XCTAssertEqual(before.notesKey, after.notesKey)
        XCTAssertEqual(before.notesKey, "pane_\(tab)_\(leaf)")
        XCTAssertEqual(try SessionNotesStore.load(key: before.notesKey, legacyHandle: oldHandle), "Keep this note")
        XCTAssertEqual(try SessionNotesStore.load(key: after.notesKey, legacyHandle: after.handle), "Keep this note")
        try SessionNotesStore.save("Updated after restart", key: after.notesKey)
        XCTAssertEqual(try SessionNotesStore.load(key: before.notesKey, legacyHandle: oldHandle), "Updated after restart")
    }
}
