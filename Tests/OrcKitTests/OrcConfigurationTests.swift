import XCTest
@testable import OrcKit

final class OrcConfigurationTests: XCTestCase {
    func testMissingFileAndMissingSettingsUseDefaults() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        for config in [try OrcConfiguration.load(from: file), try JSONDecoder().decode(OrcConfiguration.self, from: Data("{}".utf8))] {
            XCTAssertEqual(config.defaultSessionType, .codex)
            XCTAssertEqual(config.defaultProject, "")
        }
    }

    func testConfiguredProjectSelectorsAndIndependentDefaults() throws {
        for project in ["My project", "/Users/test/My project", "path:/code/project", "id:remote-project"] {
            let data = try JSONSerialization.data(withJSONObject: ["defaultProject": project])
            let config = try JSONDecoder().decode(OrcConfiguration.self, from: data)
            XCTAssertEqual(config.defaultProject, project)
            XCTAssertEqual(config.defaultSessionType, .codex)
        }
        let config = try JSONDecoder().decode(OrcConfiguration.self, from: Data("{\"defaultSessionType\":\"pi\"}".utf8))
        XCTAssertEqual(config.defaultSessionType, .pi)
        XCTAssertEqual(config.defaultProject, "")
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
            let expected: [SessionType: String] = [.codex: "codex --no-daemon", .claude: "claude", .pi: "pi", .durable: "durable"]
            XCTAssertEqual(config.defaultSessionType.command, expected[type])
        }
    }

    func testSettingDefaultsKeepsOtherSettings() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("config.json")
        try OrcConfiguration.setDefaultSessionType(.pi, file: file)
        try OrcConfiguration.setDefaultProject("id:p-1", file: file)
        var config = try OrcConfiguration.load(from: file)
        XCTAssertEqual(config.defaultSessionType, .pi)
        XCTAssertEqual(config.defaultProject, "id:p-1")
        var settings = try jsonObject(Data(contentsOf: file))
        settings["futureSetting"] = true
        try JSONSerialization.data(withJSONObject: settings).write(to: file)
        try OrcConfiguration.setDefaultProject(nil, file: file)
        try OrcConfiguration.setDefaultSessionType(.claude, file: file)
        config = try OrcConfiguration.load(from: file)
        XCTAssertEqual(config.defaultSessionType, .claude)
        XCTAssertEqual(config.defaultProject, "")
        XCTAssertEqual(try jsonObject(Data(contentsOf: file))["futureSetting"] as? Bool, true)
        let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int
        XCTAssertEqual(permissions, 0o600)
        try Data("{".utf8).write(to: file)
        XCTAssertThrowsError(try OrcConfiguration.setDefaultSessionType(.pi, file: file))
        XCTAssertEqual(try Data(contentsOf: file), Data("{".utf8))
    }

    func testInvalidConfigurationReportsItsPathAndSupportedTypes() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("config.json")
        for contents in ["{", "[]", "null", "{\"defaultSessionType\":\"unknown\"}", "{\"defaultSessionType\":42}",
                         "{\"defaultProject\":42}", "{\"defaultProject\":\"\"}", "{\"defaultProject\":\"  \"}"] {
            try Data(contents.utf8).write(to: file)
            XCTAssertThrowsError(try OrcConfiguration.load(from: file)) { error in
                XCTAssertTrue(error.localizedDescription.contains(file.path))
                XCTAssertTrue(error.localizedDescription.contains("codex, claude, pi, or terminal"))
                XCTAssertTrue(error.localizedDescription.contains("defaultProject"))
            }
        }
        XCTAssertThrowsError(try OrcConfiguration.load(from: directory))
    }
}
