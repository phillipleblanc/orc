import Foundation
import CryptoKit
import Darwin
import COrcSupport

/// Reuses the selected profile's runtime, or starts the bundled one headlessly.
public enum RuntimeBootstrap {
    public static func ensureRunning() async throws -> RuntimeMetadata {
        try await Task.detached {
            let connection = try RuntimeStarter().connect(timeout: 3)
            defer { Darwin.close(connection.fd) }
            return connection.metadata
        }.value
    }
}

struct RuntimeSocket {
    let metadata: RuntimeMetadata
    let fd: Int32

    /// Limits each blocking read and write on the socket to `seconds`.
    func setTimeout(_ seconds: Int) {
        var value = timeval(tv_sec: seconds, tv_usec: 0)
        let size = socklen_t(MemoryLayout<timeval>.size)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &value, size)
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &value, size)
    }
}

struct RuntimeStarter {
    static let capabilities: Set<String> = ["terminal.binary-stream.v1", "terminal.multiplex.v1", "orc.agents.v1"]

    let profile: URL
    let state: URL
    let config: URL
    let environment: [String: String]
    let startupTimeout: TimeInterval
    let hostExecutable: URL

    init(profile: URL? = nil, config: URL = Pairing.directory,
         environment: [String: String] = ProcessInfo.processInfo.environment, startupTimeout: TimeInterval = 30,
         hostExecutable: URL = RuntimeStarter.currentExecutable) {
        self.profile = (profile ?? RuntimeMetadata.directory(environment: environment, config: config)).standardizedFileURL.resolvingSymlinksInPath()
        let key = SHA256.hash(data: Data(self.profile.path.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        self.state = config.appendingPathComponent("runtimes/" + key)
        self.environment = environment
        self.startupTimeout = startupTimeout
        self.config = config
        self.hostExecutable = hostExecutable
    }

    /// Connects to the running runtime, starting it first if needed, and makes sure Orc can attach to it.
    func connect(timeout: Int = 15) throws -> RuntimeSocket {
        if let connection = try existing(timeout: timeout) {
            if hasAccess() { return connection }
            Darwin.close(connection.fd)
        }
        let deadline = ProcessInfo.processInfo.systemUptime + startupTimeout
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let lock = Darwin.open(state.appendingPathComponent("startup.lock").path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard lock >= 0 else { throw OrcError("Cannot coordinate runtime startup at \(state.path). Check folder permissions.") }
        defer { Darwin.close(lock) }
        while flock(lock, LOCK_EX | LOCK_NB) != 0 {
            guard errno == EWOULDBLOCK || errno == EINTR else { throw OrcError("Cannot lock runtime startup at \(state.path).") }
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw startupError("Another Orc client is still starting the runtime") }
            Thread.sleep(forTimeInterval: 0.1)
        }
        defer { flock(lock, LOCK_UN) }

        if try existing(timeout: timeout) == nil, !frontendIsStarting() { try launch() }
        while ProcessInfo.processInfo.systemUptime < deadline {
            // Each probe of a runtime that is still starting waits at most 3 s; the caller's timeout applies once it answers.
            if let connection = try existing(timeout: 3) {
                connection.setTimeout(timeout)
                do {
                    if !hasAccess() { try createAccess(connection, timeout: timeout) }
                    try? FileManager.default.removeItem(at: state.appendingPathComponent("launch.json"))
                    return connection
                } catch { Darwin.close(connection.fd); throw error }
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        throw startupError("The runtime did not become ready in time")
    }

    private func hasAccess() -> Bool {
        (try? Pairing.load(from: config, profile: profile)) != nil
    }

    /// Orc's own device grant, issued over the owner-only local socket.
    private func createAccess(_ connection: RuntimeSocket, timeout: Int) throws {
        let result = try LocalRPC.exchange("slim.pairing.create", ["scope": "runtime", "name": "Orc"], connection: connection, timeout: timeout)
        let pairing = try Pairing.parse(result["link"] as? String ?? "")
        let endpoint = URLComponents(string: pairing.endpoint)
        guard pairing.scope == "runtime", endpoint?.host == "127.0.0.1",
              pairing.publicKeyB64 == (try Pairing.serverKey(profile: profile)) else {
            throw OrcError("The runtime returned access for another server or endpoint. No credentials were saved.")
        }
        try pairing.save(to: config, profile: profile)
    }

    private func existing(timeout: Int) throws -> RuntimeSocket? {
        let metadata: RuntimeMetadata
        do { metadata = try RuntimeMetadata.load(from: profile) }
        catch {
            let url = profile.appendingPathComponent("orca-runtime.json")
            if FileManager.default.fileExists(atPath: url.path), !FileManager.default.isReadableFile(atPath: url.path) {
                throw OrcError("Cannot read runtime metadata at \(url.path). Check file permissions.")
            }
            return nil
        }
        let path = try metadata.endpoint("unix")
        let fd = path.withCString { orc_connect_unix($0, Int32(timeout)) }
        if fd >= 0 {
            let connection = RuntimeSocket(metadata: metadata, fd: fd)
            do {
                let status = try LocalRPC.exchange("status.get", [:], connection: connection, timeout: timeout)
                let capabilities = Set(status["capabilities"] as? [String] ?? [])
                guard status["runtimeId"] as? String == metadata.runtimeId, status["runtimeProtocolVersion"] as? Int == 3,
                      capabilities.isSuperset(of: Self.capabilities) else {
                    throw OrcError("The running runtime is incompatible with this Orc. Restart it after updating Orc; sessions keep running.")
                }
                return connection
            } catch { Darwin.close(fd); throw error }
        }
        let code = errno
        guard code == ENOENT || code == ECONNREFUSED else {
            throw OrcError("Cannot connect to the runtime: \(String(cString: strerror(code))).")
        }
        return nil
    }

    /// A frontend holds `frontend.lock` from the moment it starts, before it publishes its metadata.
    private func frontendIsStarting() -> Bool {
        guard let text = try? String(contentsOf: profile.appendingPathComponent("frontend.lock"), encoding: .utf8),
              let pid = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0 else { return false }
        return kill(pid, 0) == 0 || errno == EPERM
    }

    private func launch() throws {
        let record = state.appendingPathComponent("launch.json")
        // A failing runtime must not be relaunched on every UI refresh.
        if let previous = (try? Data(contentsOf: record)).flatMap({ try? JSONDecoder().decode(Launch.self, from: $0) }),
           Date().timeIntervalSince1970 - previous.createdAt < 30 {
            throw startupError("The runtime exited before becoming ready; startup will retry shortly")
        }
        let executable = try resolveExecutable()
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let log = Darwin.open(state.appendingPathComponent("backend.log").path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard log >= 0 else { throw startupError("Cannot open the runtime log") }
        defer { Darwin.close(log) }
        let arguments = [executable.path, "--profile", profile.path]
        let env = launchEnvironment().map { $0.key + "=" + $0.value }
        let argv = arguments.map { strdup($0) } + [nil]
        let envp = env.map { strdup($0) } + [nil]
        defer { for pointer in argv + envp { free(pointer) } }
        var pid: Int32 = 0
        let status = orc_spawn_backend(executable.path, argv, envp, profile.path, log, log, &pid)
        guard status == 0 else { throw startupError("Could not launch the runtime: \(String(cString: strerror(status)))") }
        // Reap our child without holding a thread for the lifetime of the runtime.
        let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .global(qos: .utility))
        source.setEventHandler {
            var status: Int32 = 0
            while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
            source.setEventHandler(handler: nil)
            source.cancel()
        }
        source.resume()
        try JSONEncoder().encode(Launch(pid: pid, createdAt: Date().timeIntervalSince1970)).write(to: record, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: record.path)
    }

    func resolveExecutable() throws -> URL {
        if let override = environment["ORC_RUNTIME_EXECUTABLE"], !override.isEmpty {
            guard override.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: override) else {
                throw OrcError("ORC_RUNTIME_EXECUTABLE must be an absolute path to an executable. Unset it to use Orc's bundled runtime.")
            }
            return URL(fileURLWithPath: override)
        }
        let launcher = try Self.hostBundle(executable: hostExecutable).appendingPathComponent("Contents/Resources/Runtime/orc-runtime")
        guard FileManager.default.isExecutableFile(atPath: launcher.path) else {
            throw OrcError("The bundled runtime is missing from \(launcher.path). Reinstall Orc.")
        }
        return launcher
    }

    func launchEnvironment() -> [String: String] {
        // The runtime must not inherit the identity of a session or agent that ran `orc`.
        var result = environment.filter { key, _ in
            !key.hasPrefix("ORC_") && !key.hasPrefix("ORCA_") && key != "NODE_OPTIONS" && key != "NODE_REPL_EXTERNAL_MODULE"
        }
        if let config = environment["ORC_CONFIG_DIR"] { result["ORC_CONFIG_DIR"] = config }
        return result
    }

    static var currentExecutable: URL {
        var path = [CChar](repeating: 0, count: 4096)
        guard orc_executable_path(&path, UInt32(path.count)) == 0 else { return Bundle.main.executableURL! }
        return URL(fileURLWithPath: String(cString: path)).resolvingSymlinksInPath()
    }

    /// The Orc.app containing `executable`, which is the app itself or its bundled CLI.
    static func hostBundle(executable: URL) throws -> URL {
        let actual = executable.resolvingSymlinksInPath()
        let contents = actual.deletingLastPathComponent().deletingLastPathComponent()
        guard contents.lastPathComponent == "Contents",
              ["MacOS", "Resources"].contains(actual.deletingLastPathComponent().lastPathComponent),
              contents.deletingLastPathComponent().pathExtension == "app" else {
            throw OrcError("The bundled runtime is unavailable. Run the installed Orc app or its linked CLI, or set ORC_RUNTIME_EXECUTABLE for development.")
        }
        return contents.deletingLastPathComponent()
    }

    private func startupError(_ message: String) -> OrcError {
        OrcError(message + ". See " + state.appendingPathComponent("backend.log").path + ".")
    }

    private struct Launch: Codable {
        let pid: Int32
        let createdAt: TimeInterval
    }
}
