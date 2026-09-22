import XCTest
@testable import OrcKit

final class RuntimeBootstrapTests: XCTestCase {
    func testHeadlessEnvironmentDoesNotInheritAgentIdentityOrNodeMode() {
        let profile = URL(fileURLWithPath: "/tmp/orc-runtime-test")
        let starter = RuntimeStarter(profile: profile, environment: [
            "ORCA_USER_DATA_PATH": "/wrong/profile", "ORCA_PANE_KEY": "parent-pane",
            "ORCA_TERMINAL_HANDLE": "parent-terminal", "ORCA_BYPASS_SINGLE_INSTANCE_LOCK": "1",
            "ORCA_PAIRING_CODE": "must-not-propagate", "ELECTRON_RUN_AS_NODE": "1",
            "NODE_OPTIONS": "--inspect", "NODE_REPL_EXTERNAL_MODULE": "custom",
            "PATH": "/bin:/usr/bin", "HOME": "/Users/test", "LANG": "en_US.UTF-8"])
        XCTAssertEqual(starter.launchEnvironment(), ["ORCA_USER_DATA_PATH": starter.profile.path,
            "PATH": "/bin:/usr/bin", "HOME": "/Users/test", "LANG": "en_US.UTF-8"])
    }

    func testCanonicalProfileSharesStartupLockWhileOtherProfilesStaySeparate() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("profile"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("alias"), withDestinationURL: root.appendingPathComponent("profile"))
        let direct = RuntimeStarter(profile: root.appendingPathComponent("profile"), config: root)
        let alias = RuntimeStarter(profile: root.appendingPathComponent("alias"), config: root)
        let other = RuntimeStarter(profile: root.appendingPathComponent("other"), config: root)
        XCTAssertEqual(direct.state, alias.state)
        XCTAssertNotEqual(direct.state, other.state)
    }

    func testMissingExecutableReportsActionableErrorWithoutLaunchingAnotherProfile() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let starter = RuntimeStarter(profile: root.appendingPathComponent("profile"), config: root.appendingPathComponent("client"),
                                     environment: ["ORCA_APP_EXECUTABLE": root.appendingPathComponent("missing").path])
        XCTAssertThrowsError(try starter.connect()) { error in
            XCTAssertTrue(error.localizedDescription.contains("ORCA_APP_EXECUTABLE"))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: starter.profile.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: starter.state.appendingPathComponent("launch.json").path))
        let relative = RuntimeStarter(environment: ["ORCA_APP_EXECUTABLE": "Orca"])
        XCTAssertThrowsError(try relative.resolveExecutable()) { error in
            XCTAssertTrue(error.localizedDescription.contains("absolute path"))
        }
    }
}
