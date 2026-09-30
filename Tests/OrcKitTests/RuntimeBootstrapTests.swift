import XCTest
@testable import OrcKit

final class RuntimeBootstrapTests: XCTestCase {
    private func temporary() throws -> URL {
        let root = URL(fileURLWithPath: "/tmp/orc-unit-" + UUID().uuidString).resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    func testProfileComesFromTheEnvironmentOrOrcsConfiguration() {
        let config = URL(fileURLWithPath: "/tmp/orc-config")
        XCTAssertEqual(RuntimeMetadata.directory(environment: [:], config: config).path, "/tmp/orc-config/runtime")
        XCTAssertEqual(RuntimeMetadata.directory(environment: ["ORC_RUNTIME_DIR": "/tmp/other"], config: config).path, "/tmp/other")
    }

    func testBundleDiscoveryFollowsSymlinkAndDoesNotUseWorkingDirectory() throws {
        let root = try temporary(), app = root.appendingPathComponent("Moved Orc.app")
        let cli = app.appendingPathComponent("Contents/Resources/orc")
        try FileManager.default.createDirectory(at: cli.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: cli)
        let link = root.appendingPathComponent("linked-orc")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: cli)
        XCTAssertEqual(try RuntimeStarter.hostBundle(executable: link).path, app.resolvingSymlinksInPath().path)
        XCTAssertEqual(try RuntimeStarter.hostBundle(executable: app.appendingPathComponent("Contents/MacOS/Orc")).path, app.resolvingSymlinksInPath().path)
        XCTAssertThrowsError(try RuntimeStarter.hostBundle(executable: root.appendingPathComponent("orc")))
        let starter = RuntimeStarter(profile: root.appendingPathComponent("profile"), config: root, environment: [:], hostExecutable: cli)
        XCTAssertThrowsError(try starter.resolveExecutable()) { error in
            XCTAssertTrue(error.localizedDescription.contains("Contents/Resources/Runtime/orc-runtime"))
        }
    }

    func testRuntimeDoesNotInheritSessionIdentityOrNodeMode() {
        let profile = URL(fileURLWithPath: "/tmp/orc-runtime-test")
        let starter = RuntimeStarter(profile: profile, environment: [
            "ORC_RUNTIME_DIR": "/wrong/profile", "ORC_SESSION_NAME": "parent", "ORC_AGENT_EVENTS": "/tmp/events",
            "ORCA_TERMINAL_HANDLE": "parent-terminal", "NODE_OPTIONS": "--inspect", "NODE_REPL_EXTERNAL_MODULE": "custom",
            "ORC_CONFIG_DIR": "/tmp/config", "PATH": "/bin:/usr/bin", "HOME": "/Users/test", "LANG": "en_US.UTF-8"])
        XCTAssertEqual(starter.launchEnvironment(), ["ORC_CONFIG_DIR": "/tmp/config",
            "PATH": "/bin:/usr/bin", "HOME": "/Users/test", "LANG": "en_US.UTF-8"])
    }

    func testCanonicalProfileSharesStartupLockWhileOtherProfilesStaySeparate() throws {
        let root = try temporary()
        try FileManager.default.createDirectory(at: root.appendingPathComponent("profile"), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("alias"), withDestinationURL: root.appendingPathComponent("profile"))
        let direct = RuntimeStarter(profile: root.appendingPathComponent("profile"), config: root)
        let alias = RuntimeStarter(profile: root.appendingPathComponent("alias"), config: root)
        let other = RuntimeStarter(profile: root.appendingPathComponent("other"), config: root)
        XCTAssertEqual(direct.state, alias.state)
        XCTAssertNotEqual(direct.state, other.state)
    }

    func testMissingExecutableReportsActionableErrorWithoutLaunching() throws {
        let root = try temporary()
        let starter = RuntimeStarter(profile: root.appendingPathComponent("profile"), config: root.appendingPathComponent("client"),
                                     environment: ["ORC_RUNTIME_EXECUTABLE": root.appendingPathComponent("missing").path])
        XCTAssertThrowsError(try starter.connect()) { error in
            XCTAssertTrue(error.localizedDescription.contains("ORC_RUNTIME_EXECUTABLE"))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: starter.profile.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: starter.state.appendingPathComponent("launch.json").path))
        let relative = RuntimeStarter(environment: ["ORC_RUNTIME_EXECUTABLE": "orc-runtime"])
        XCTAssertThrowsError(try relative.resolveExecutable()) { error in
            XCTAssertTrue(error.localizedDescription.contains("absolute path"))
        }
    }

    func testAStartingFrontendIsAwaitedRatherThanLaunchedAgain() throws {
        let root = try temporary(), profile = root.appendingPathComponent("profile")
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
        try String(getpid()).write(to: profile.appendingPathComponent("frontend.lock"), atomically: true, encoding: .utf8)
        let starter = RuntimeStarter(profile: profile, config: root.appendingPathComponent("client"),
                                     environment: ["ORC_RUNTIME_EXECUTABLE": "/missing/orc-runtime"], startupTimeout: 0.3)
        XCTAssertThrowsError(try starter.connect()) { error in
            XCTAssertTrue(error.localizedDescription.contains("did not become ready"))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: starter.state.appendingPathComponent("launch.json").path))
    }

    func testConnectionsStayBoundToTheirProfileAndServerKeyAndPrivateOnDisk() throws {
        let root = try temporary(), first = root.appendingPathComponent("first"), second = root.appendingPathComponent("second")
        let key = Data(repeating: 7, count: 32).base64EncodedString()
        for profile in [first, second] {
            try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
            try jsonData(["v": 1, "publicKeyB64": key, "secretKeyB64": key]).write(to: profile.appendingPathComponent("orca-e2ee-keypair.json"))
        }
        let pairing = Pairing(endpoint: "ws://127.0.0.1:6768", deviceToken: "token", publicKeyB64: key, scope: "runtime")
        try pairing.save(to: root, profile: first)
        XCTAssertEqual(try Pairing.load(from: root, profile: first).profilePath, first.resolvingSymlinksInPath().path)
        XCTAssertNoThrow(try Pairing.load(from: root, profile: URL(fileURLWithPath: "/private" + first.path, isDirectory: true)))
        XCTAssertThrowsError(try Pairing.load(from: root, profile: second))
        let other = Data(repeating: 9, count: 32).base64EncodedString()
        try jsonData(["v": 1, "publicKeyB64": other, "secretKeyB64": other]).write(to: first.appendingPathComponent("orca-e2ee-keypair.json"))
        XCTAssertThrowsError(try Pairing.load(from: root, profile: first), "a new server key invalidates the saved access")
        let mode = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("connection.json").path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
    }
}
