import XCTest
@testable import OrcKit

final class OrcConfigurationTests: XCTestCase {
    func testMissingFileAndMissingSettingDefaultToCodex() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        XCTAssertEqual(try OrcConfiguration.load(from: file).defaultSessionType, .codex)
        XCTAssertEqual(try JSONDecoder().decode(OrcConfiguration.self, from: Data("{}".utf8)).defaultSessionType, .codex)
    }

    func testSupportedDefaultsAndCommands() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("config.json")
        for type in SessionType.allCases {
            try Data("{\"defaultSessionType\":\"\(type.rawValue)\"}".utf8).write(to: file)
            let config = try OrcConfiguration.load(from: file)
            XCTAssertEqual(config.defaultSessionType, type)
            XCTAssertEqual(config.defaultSessionType.command, type == .terminal ? nil : type.rawValue)
        }
    }

    func testInvalidConfigurationReportsItsPathAndSupportedTypes() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("config.json")
        for contents in ["{", "[]", "null", "{\"defaultSessionType\":\"unknown\"}", "{\"defaultSessionType\":42}"] {
            try Data(contents.utf8).write(to: file)
            XCTAssertThrowsError(try OrcConfiguration.load(from: file)) { error in
                XCTAssertTrue(error.localizedDescription.contains(file.path))
                XCTAssertTrue(error.localizedDescription.contains("codex, claude, pi, or terminal"))
            }
        }
        XCTAssertThrowsError(try OrcConfiguration.load(from: directory))
    }
}
