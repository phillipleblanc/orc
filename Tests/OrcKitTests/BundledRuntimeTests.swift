import XCTest
@testable import OrcKit

final class BundledRuntimeTests: XCTestCase {
    private func temporary() throws -> URL {
        let root = URL(fileURLWithPath: "/tmp/orc-unit-" + UUID().uuidString).resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    func testBundleDiscoveryFollowsSymlinkAndDoesNotUseWorkingDirectory() throws {
        let root = try temporary(), app = root.appendingPathComponent("Moved Orc.app")
        let cli = app.appendingPathComponent("Contents/Resources/orc")
        try FileManager.default.createDirectory(at: cli.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: cli)
        let link = root.appendingPathComponent("linked-orc")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: cli)
        XCTAssertEqual(try BundledRuntime.hostBundle(executable: link).path, app.resolvingSymlinksInPath().path)
        XCTAssertEqual(try BundledRuntime.hostBundle(executable: app.appendingPathComponent("Contents/MacOS/Orc")).path, app.resolvingSymlinksInPath().path)
        XCTAssertThrowsError(try BundledRuntime.hostBundle(executable: root.appendingPathComponent("orc")))
    }

    func testUnownedProfileAndVersionChangesAreRejectedWithoutRewritingData() throws {
        let root = try temporary(), existing = root.appendingPathComponent("existing")
        try FileManager.default.createDirectory(at: existing, withIntermediateDirectories: true)
        let sentinel = existing.appendingPathComponent("orca-data.json")
        try Data("existing sessions".utf8).write(to: sentinel)
        XCTAssertThrowsError(try RuntimeProfile.prepare(existing, version: "1.4.212"))
        XCTAssertEqual(try Data(contentsOf: sentinel), Data("existing sessions".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: existing.appendingPathComponent(RuntimeProfile.marker).path))
        let owned = root.appendingPathComponent("owned")
        try RuntimeProfile.prepare(owned, version: "1.4.212")
        let marker = owned.appendingPathComponent(RuntimeProfile.marker), original = try Data(contentsOf: marker)
        for version in ["1.4.211", "1.4.213"] {
            XCTAssertThrowsError(try RuntimeProfile.prepare(owned, version: version))
            XCTAssertEqual(try Data(contentsOf: marker), original)
        }
        XCTAssertEqual(try RuntimeProfile.ownership(at: owned)?.runtimeVersion, "1.4.212")
    }

    func testOwnershipSymlinksAndPublicPermissionsAreRejected() throws {
        let root = try temporary()
        try RuntimeProfile.prepare(root, version: "1.4.212")
        let marker = root.appendingPathComponent(RuntimeProfile.marker)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: marker.path)
        XCTAssertThrowsError(try RuntimeProfile.ownership(at: root))
        try FileManager.default.moveItem(at: marker, to: root.appendingPathComponent("other"))
        try FileManager.default.createSymbolicLink(at: marker, withDestinationURL: root.appendingPathComponent("other"))
        XCTAssertThrowsError(try RuntimeProfile.ownership(at: root))
    }

    func testLongProfilePathIsRejectedBeforeCreatingFiles() throws {
        let root = try temporary(), profile = root.appendingPathComponent(String(repeating: "x", count: 76))
        XCTAssertThrowsError(try RuntimeProfile.prepare(profile, version: "1.4.212")) { error in
            XCTAssertTrue(error.localizedDescription.contains("shorter ORC_CONFIG_DIR"))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: profile.path))
    }

    func testExistingInstallationRequiresExplicitProfileChoice() throws {
        let home = try temporary(), config = home.appendingPathComponent("settings")
        try FileManager.default.createDirectory(at: home.appendingPathComponent("Library/Application Support/orca"), withIntermediateDirectories: true)
        XCTAssertThrowsError(try RuntimeProfile.validateSelection(environment: [:], config: config, home: home))
        XCTAssertNoThrow(try RuntimeProfile.validateSelection(environment: ["ORC_CONFIG_DIR": config.path], config: config, home: home))
        XCTAssertNoThrow(try RuntimeProfile.validateSelection(environment: ["ORCA_USER_DATA_PATH": "/explicit/profile"], config: config, home: home))
        XCTAssertThrowsError(try RuntimeProfile.validateSelection(environment: ["ORCA_USER_DATA_PATH": "relative"], config: config, home: home))
        try FileManager.default.createDirectory(at: config, withIntermediateDirectories: true)
        try Data("legacy credentials".utf8).write(to: config.appendingPathComponent("connection.json"))
        XCTAssertThrowsError(try RuntimeProfile.validateSelection(environment: ["ORC_CONFIG_DIR": config.path], config: config, home: home))
    }

    private let key = Data(repeating: 1, count: 32).base64EncodedString()

    func testFreshSetupPreservesLegacyDataAndDoesNotResetAnOwnedProfile() throws {
        let root = try temporary(), profile = root.appendingPathComponent("runtime")
        let legacy = root.appendingPathComponent("Library/Application Support/orca")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        let sentinel = legacy.appendingPathComponent("sessions.json")
        let oldData = Data("existing sessions and phone grants".utf8)
        try oldData.write(to: sentinel)
        let connection = root.appendingPathComponent("connection.json")
        let credentials = Data("old runtime credentials".utf8)
        try credentials.write(to: connection)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: connection.path)
        XCTAssertThrowsError(try RuntimeProfile.validateSelection(environment: [:], config: root, home: root)) {
            XCTAssertTrue($0 is RuntimeProfileChoiceRequired)
        }
        let archive = try XCTUnwrap(RuntimeProfile.prepareFresh(profile, config: root, version: "1.4.212"))
        XCTAssertEqual(try Data(contentsOf: archive), credentials)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: archive.path)[.posixPermissions] as? Int, 0o600)
        XCTAssertEqual(try Data(contentsOf: sentinel), oldData)
        XCTAssertFalse(FileManager.default.fileExists(atPath: connection.path))
        XCTAssertNoThrow(try RuntimeProfile.validateSelection(environment: [:], config: root, home: root))
        let managedCredentials = Data("managed runtime credentials".utf8)
        try managedCredentials.write(to: connection)
        XCTAssertNil(try RuntimeProfile.prepareFresh(profile, config: root, version: "1.4.212"))
        XCTAssertThrowsError(try RuntimeProfile.prepareFresh(profile, config: root, version: "1.4.213"))
        XCTAssertEqual(try Data(contentsOf: connection), managedCredentials)
        XCTAssertEqual(try Data(contentsOf: archive), credentials)
    }

    func testFreshSetupRefusesNonemptyProfilesBeforeMovingCredentials() throws {
        let root = try temporary(), profile = root.appendingPathComponent("runtime")
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
        try Data("unowned profile".utf8).write(to: profile.appendingPathComponent("sessions.json"))
        let connection = root.appendingPathComponent("connection.json"), original = Data("credentials".utf8)
        try original.write(to: connection)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: connection.path)
        XCTAssertThrowsError(try RuntimeProfile.prepareFresh(profile, config: root, version: "1.4.212"))
        XCTAssertEqual(try Data(contentsOf: connection), original)
        XCTAssertFalse(FileManager.default.fileExists(atPath: profile.appendingPathComponent(RuntimeProfile.marker).path))
    }

    func testFreshSetupRestoresCredentialsIfProfileCreationFails() throws {
        let root = try temporary(), blocked = root.appendingPathComponent("x")
        try FileManager.default.createDirectory(at: blocked, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: blocked.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: blocked.path) }
        let connection = root.appendingPathComponent("connection.json"), original = Data("credentials".utf8)
        try original.write(to: connection)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: connection.path)
        XCTAssertThrowsError(try RuntimeProfile.prepareFresh(blocked.appendingPathComponent("runtime"), config: root, version: "1.4.212"))
        XCTAssertEqual(try Data(contentsOf: connection), original)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: root.path).contains { $0.hasPrefix("connection.legacy-") })
    }

    func testFreshSetupRejectsCredentialSymlinks() throws {
        let root = try temporary(), profile = root.appendingPathComponent("runtime")
        let target = root.appendingPathComponent("original.json")
        try Data("credentials".utf8).write(to: target)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("connection.json"), withDestinationURL: target)
        XCTAssertThrowsError(try RuntimeProfile.prepareFresh(profile, config: root, version: "1.4.212"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: profile.path))
        XCTAssertEqual(try Data(contentsOf: target), Data("credentials".utf8))
    }
    private func metadata() throws -> RuntimeMetadata {
        try decode(["runtimeId": "test-runtime", "authToken": "test-auth", "pid": 123,
                    "transports": [["kind": "websocket", "endpoint": "ws://0.0.0.0:9876"]]])
    }
    private func readiness(scope: String = "runtime", runtimeID: String = "test-runtime", endpoint: String = "ws://127.0.0.1:9876", publicKey: String? = nil) throws -> Data {
        let token = try jsonData(["endpoint": endpoint, "deviceToken": "secret-test-token", "publicKeyB64": publicKey ?? key, "scope": scope])
        return try jsonData(["type": "orca_server_ready", "schemaVersion": 1, "runtimeId": runtimeID,
                             "boundEndpoint": "ws://0.0.0.0:9876",
                             "pairing": ["available": true, "scope": scope, "endpoint": endpoint,
                                         "url": "orca://pair?code=" + token.base64EncodedString()]])
    }

    func testReadinessPinsScopeRuntimeEndpointAndServerKeyWithoutLeakingTokens() throws {
        XCTAssertEqual(try BootstrapAccess.pairing(from: readiness(), metadata: metadata(), publicKey: key).scope, "runtime")
        let invalid = try [readiness(scope: "mobile"), readiness(runtimeID: "another-runtime"),
                           readiness(endpoint: "ws://example.com:9876"), readiness(endpoint: "ws://127.0.0.1:1234"),
                           readiness(endpoint: "ws://127.0.0.1:9876?token=secret-test-token"),
                           readiness(publicKey: Data(repeating: 2, count: 32).base64EncodedString())]
        for data in invalid {
            XCTAssertThrowsError(try BootstrapAccess.pairing(from: data, metadata: metadata(), publicKey: key)) { error in
                XCTAssertFalse(error.localizedDescription.contains("secret-test-token"))
                XCTAssertFalse(error.localizedDescription.contains("orca://"))
            }
        }
    }

    func testConnectionsStayBoundToTheirProfileAndPrivateOnDisk() throws {
        let root = try temporary(), first = root.appendingPathComponent("first"), second = root.appendingPathComponent("second")
        try FileManager.default.createDirectory(at: first, withIntermediateDirectories: true)
        let pairing = try BootstrapAccess.pairing(from: readiness(), metadata: metadata(), publicKey: key)
        try pairing.save(to: root, profile: first)
        XCTAssertEqual(try Pairing.load(from: root, profile: first).profilePath, first.resolvingSymlinksInPath().path)
        let alias = URL(fileURLWithPath: "/private" + first.path, isDirectory: true)
        XCTAssertNoThrow(try Pairing.load(from: root, profile: alias))
        XCTAssertThrowsError(try Pairing.load(from: root, profile: second))
        let mode = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("connection.json").path)[.posixPermissions] as? Int
        XCTAssertEqual(mode, 0o600)
    }

    func testIncompatibleRuntimeFailsBeforeAnyMutation() throws {
        var status: [String: Any] = ["runtimeId": "test-runtime", "runtimeProtocolVersion": 3,
                                    "minCompatibleRuntimeClientVersion": 2,
                                    "capabilities": ["terminal.binary-stream.v1", "terminal.multiplex.v1"]]
        XCTAssertNoThrow(try RuntimeCompatibility.check(status, metadata: metadata(), owner: nil))
        status["runtimeId"] = "changed"
        XCTAssertThrowsError(try RuntimeCompatibility.check(status, metadata: metadata(), owner: nil))
        status["runtimeId"] = "test-runtime"; status["capabilities"] = ["terminal.binary-stream.v1"]
        XCTAssertThrowsError(try RuntimeCompatibility.check(status, metadata: metadata(), owner: nil))
        status["capabilities"] = ["terminal.binary-stream.v1", "terminal.multiplex.v1"]
        status["minCompatibleRuntimeClientVersion"] = 4
        XCTAssertThrowsError(try RuntimeCompatibility.check(status, metadata: metadata(), owner: nil))
    }
}
