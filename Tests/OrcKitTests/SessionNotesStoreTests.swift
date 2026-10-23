import XCTest
@testable import OrcKit

final class SessionNotesStoreTests: XCTestCase {
    override func setUpWithError() throws {
        try XCTSkipIf(ProcessInfo.processInfo.environment["ORC_CONFIG_DIR"] == nil,
                      "Set ORC_CONFIG_DIR to a disposable folder; notes live in Orc's configuration directory.")
    }

    func testNotesAreKeyedByNameAndReadExternalEdits() throws {
        let name = "notes-" + UUID().uuidString.prefix(8)
        defer { try? FileManager.default.removeItem(at: SessionNotesStore.file(for: name)) }
        XCTAssertEqual(try SessionNotesStore.load(name), "")
        try SessionNotesStore.save("first", for: name)
        let file = try SessionNotesStore.file(for: name)
        XCTAssertEqual(file.lastPathComponent, name + ".txt")
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int, 0o600)
        try "edited in Pi".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(try SessionNotesStore.load(name), "edited in Pi")
        XCTAssertThrowsError(try SessionNotesStore.file(for: "../escape"))
        XCTAssertThrowsError(try SessionNotesStore.file(for: ".hidden"))
    }
}
