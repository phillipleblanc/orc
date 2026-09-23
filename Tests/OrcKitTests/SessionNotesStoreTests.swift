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
}
