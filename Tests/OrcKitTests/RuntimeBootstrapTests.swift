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

    func testAConnectionThatCreatesAccessKeepsTheCallersTimeout() throws {
        let root = try temporary(), profile = root.appendingPathComponent("profile")
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
        let key = Data(repeating: 7, count: 32).base64EncodedString()
        try jsonData(["v": 1, "publicKeyB64": key, "secretKeyB64": key]).write(to: profile.appendingPathComponent("orca-e2ee-keypair.json"))
        let socket = root.appendingPathComponent("rpc.sock").path
        try jsonData(["runtimeId": "fake", "authToken": "token", "transports": [["kind": "unix", "endpoint": socket]]])
            .write(to: profile.appendingPathComponent("orca-runtime.json"))
        let pairing = try jsonData(["endpoint": "ws://127.0.0.1:6768", "deviceToken": "device", "publicKeyB64": key, "scope": "runtime"])
        let code = pairing.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        let runtime = try FakeRuntime(path: socket) { method in
            switch method {
            case "status.get": return ["runtimeId": "fake", "runtimeProtocolVersion": 3, "capabilities": Array(RuntimeStarter.capabilities)]
            case "slim.pairing.create": return ["link": "orca://pair?code=" + code]
            default: return [:]
            }
        }
        defer { runtime.stop() }
        let starter = RuntimeStarter(profile: profile, config: root.appendingPathComponent("client"), environment: [:])
        let connection = try starter.connect(timeout: 30)
        defer { Darwin.close(connection.fd) }
        var value = timeval(), size = socklen_t(MemoryLayout<timeval>.size)
        XCTAssertEqual(getsockopt(connection.fd, SOL_SOCKET, SO_RCVTIMEO, &value, &size), 0)
        XCTAssertEqual(value.tv_sec, 30)
        XCTAssertNoThrow(try Pairing.load(from: root.appendingPathComponent("client"), profile: profile))
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

/// A runtime on a Unix socket that answers each request line with `respond(method)`.
private final class FakeRuntime {
    private let fd: Int32

    init(path: String, respond: @escaping (String) -> [String: Any]) throws {
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw OrcError("Socket path too long.") }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in bytes.withUnsafeBytes { buffer.copyMemory(from: $0) } }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, listen(fd, 8) == 0 else { throw OrcError("Cannot listen on \(path).") }
        let listener = fd
        Thread.detachNewThread {
            while true {
                let client = accept(listener, nil, nil)
                guard client >= 0 else { return }
                Thread.detachNewThread { Self.serve(client, respond) }
            }
        }
    }

    private static func serve(_ client: Int32, _ respond: (String) -> [String: Any]) {
        defer { close(client) }
        var buffer = Data(), chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = read(client, &chunk, chunk.count)
            guard count > 0 else { return }
            buffer.append(contentsOf: chunk.prefix(count))
            while let newline = buffer.firstIndex(of: 10) {
                let line = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
                guard let request = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                      var reply = try? JSONSerialization.data(withJSONObject: ["id": request["id"] ?? "", "ok": true, "result": respond(request["method"] as? String ?? "")]) else { return }
                reply.append(10)
                guard (try? writeAll(client, reply)) != nil else { return }
            }
        }
    }

    func stop() {
        shutdown(fd, SHUT_RDWR)
        close(fd)
    }
}
