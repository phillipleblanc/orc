import Foundation
import CryptoKit
import Darwin
import COrcSupport

/// Reuses the selected profile's runtime, or starts the bundled runtime headlessly.
public enum RuntimeBootstrap {
    public static var needsProfileChoice: Bool {
        do {
            try RuntimeProfile.validateSelection(environment: ProcessInfo.processInfo.environment, config: Pairing.directory)
            return false
        } catch is RuntimeProfileChoiceRequired { return true }
        catch { return false }
    }

    public static func startFresh() async throws -> RuntimeMetadata {
        try await connect(startFresh: true)
    }

    public static func ensureRunning() async throws -> RuntimeMetadata {
        try await connect(startFresh: false)
    }

    private static func connect(startFresh: Bool) async throws -> RuntimeMetadata {
        try await Task.detached {
            let connection = try RuntimeStarter().connect(timeout: 3, startFresh: startFresh)
            defer { Darwin.close(connection.fd) }
            _ = try LocalRPC.exchange("status.get", [:], connection: connection, timeout: 3)
            return connection.metadata
        }.value
    }
}

struct RuntimeSocket {
    let metadata: RuntimeMetadata
    let fd: Int32
}

struct RuntimeStarter {
    let profile: URL
    let state: URL
    let config: URL
    let environment: [String: String]
    let startupTimeout: TimeInterval
    let usesSelectedProfile: Bool
    let hostExecutable: URL

    init(profile: URL? = nil, config: URL = Pairing.directory,
         environment: [String: String] = ProcessInfo.processInfo.environment, startupTimeout: TimeInterval = 45,
         hostExecutable: URL = BundledRuntime.currentExecutable) {
        self.profile = (profile ?? RuntimeProfile.directory(environment: environment, config: config)).standardizedFileURL.resolvingSymlinksInPath()
        let key = SHA256.hash(data: Data(self.profile.path.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        self.state = config.appendingPathComponent("runtimes/" + key)
        self.environment = environment
        self.startupTimeout = startupTimeout
        self.config = config
        self.usesSelectedProfile = profile == nil
        self.hostExecutable = hostExecutable
    }

    func connect(timeout: Int = 15, startFresh: Bool = false) throws -> RuntimeSocket {
        if startFresh {
            guard usesSelectedProfile, environment["ORCA_USER_DATA_PATH"] == nil,
                  environment["ORCA_APP_EXECUTABLE"].map({ $0.isEmpty }) ?? true else {
                throw OrcError("Unset ORCA_USER_DATA_PATH and ORCA_APP_EXECUTABLE before starting fresh bundled sessions.")
            }
        } else {
            if usesSelectedProfile { try RuntimeProfile.validateSelection(environment: environment, config: config) }
            if let connection = try reusable(timeout: timeout) { return connection }
        }
        let deadline = ProcessInfo.processInfo.systemUptime + startupTimeout
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let lock = Darwin.open(state.appendingPathComponent("startup.lock").path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard lock >= 0 else { throw OrcError("Cannot coordinate Orca startup at \(state.path). Check folder permissions.") }
        defer { Darwin.close(lock) }
        while flock(lock, LOCK_EX | LOCK_NB) != 0 {
            guard errno == EWOULDBLOCK || errno == EINTR else { throw OrcError("Cannot lock Orca startup at \(state.path).") }
            if !startFresh, let connection = try reusable(timeout: timeout) { return connection }
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw startupError("Another Orc client is still starting the backend") }
            Thread.sleep(forTimeInterval: 0.1)
        }
        defer { flock(lock, LOCK_UN) }
        if startFresh {
            let runtime = try BundledRuntime.verify(host: BundledRuntime.hostBundle(executable: hostExecutable))
            try RuntimeProfile.prepareFresh(profile, config: config, version: runtime.version)
        }
        if let connection = try existing(timeout: timeout) {
            do {
                if try needsAccess() {
                    throw OrcError("The selected runtime is already running without saved Orc access. It was left running. Use `orc connect` with its access link, or stop this runtime explicitly before retrying setup.")
                }
                try validateSavedAccess()
                return connection
            } catch { Darwin.close(connection.fd); throw error }
        }

        let metadataPID = (try? RuntimeMetadata.load(from: profile))?.pid
        let runtimeIsStarting = metadataPID.map { orc_is_orca_process($0) != 0 } ?? false
        let recordURL = state.appendingPathComponent("launch.json")
        let previous = (try? Data(contentsOf: recordURL)).flatMap { try? JSONDecoder().decode(Launch.self, from: $0) }
        var readiness: Data?
        if !runtimeIsStarting, previous?.isAlive != true {
            // A failing backend must not be relaunched on every UI refresh.
            if let previous, Date().timeIntervalSince1970 - previous.createdAt < 30 {
                throw startupError("The Orca backend exited before becoming ready; startup will retry shortly")
            }
            let executable = try resolveExecutable()
            let app = executable.deletingLastPathComponent().deletingLastPathComponent()
            let info = NSDictionary(contentsOf: app.appendingPathComponent("Info.plist"))
            let managed = info?["CFBundleIdentifier"] as? String == BundledRuntime.identifier
            if managed {
                guard let version = info?["CFBundleShortVersionString"] as? String else { throw OrcError("Runtime version is missing.") }
                try RuntimeProfile.prepare(profile, version: version)
                if FileManager.default.fileExists(atPath: config.appendingPathComponent("connection.json").path) {
                    _ = try Pairing.load(from: config, profile: profile)
                }
            } else if try RuntimeProfile.ownership(at: profile) != nil {
                throw OrcError("An external Orca executable cannot open an Orc-managed profile. Select its own ORCA_USER_DATA_PATH.")
            }
            try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let access = try managed && needsAccess() ? BootstrapAccess() : nil
            let launch = try start(executable, access: access)
            access?.closeWriter()
            // Failure to record a launched process must not terminate it or replay a request.
            try JSONEncoder().encode(launch).write(to: recordURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: recordURL.path)
            readiness = try access?.read(deadline: deadline)
        }
        while ProcessInfo.processInfo.systemUptime < deadline {
            if let connection = try existing(timeout: 3) {
                // Authenticate readiness before releasing the startup lock.
                defer { Darwin.close(connection.fd) }
                _ = try LocalRPC.exchange("status.get", [:], connection: connection, timeout: 3)
                if let readiness {
                    let pairing = try BootstrapAccess.pairing(from: readiness, metadata: connection.metadata,
                                                             publicKey: BootstrapAccess.publicKey(profile: profile))
                    try pairing.save(to: config, profile: profile)
                }
                if try needsAccess() { throw OrcError("The runtime is ready but Orc access setup did not finish. No runtime was restarted.") }
                try? FileManager.default.removeItem(at: recordURL)
                if let ready = try existing(timeout: timeout) { return ready }
            }
            // A competing desktop launch can win Orca's own single-instance lock.
            // Its metadata may arrive after our headless process has exited.
            Thread.sleep(forTimeInterval: 0.1)
        }
        throw startupError(runtimeIsStarting ? "Orca is running but its local API is unavailable" : "The Orca backend did not become ready in time")
    }

    private func needsAccess() throws -> Bool {
        try RuntimeProfile.ownership(at: profile) != nil && !FileManager.default.fileExists(atPath: config.appendingPathComponent("connection.json").path)
    }

    private func reusable(timeout: Int) throws -> RuntimeSocket? {
        guard let connection = try existing(timeout: timeout) else { return nil }
        do {
            if try needsAccess() { Darwin.close(connection.fd); return nil }
            try validateSavedAccess()
            return connection
        } catch { Darwin.close(connection.fd); throw error }
    }

    private func validateSavedAccess() throws {
        if try RuntimeProfile.ownership(at: profile) != nil {
            _ = try Pairing.load(from: config, profile: profile)
        }
    }

    private func existing(timeout: Int) throws -> RuntimeSocket? {
        let metadata: RuntimeMetadata
        do { metadata = try RuntimeMetadata.load(from: profile) }
        catch {
            let url = profile.appendingPathComponent("orca-runtime.json")
            if FileManager.default.fileExists(atPath: url.path), !FileManager.default.isReadableFile(atPath: url.path) {
                throw OrcError("Cannot read Orca runtime metadata at \(url.path). Check file permissions.")
            }
            return nil
        }
        let path = try metadata.endpoint("unix")
        let fd = path.withCString { orc_connect_unix($0, Int32(timeout)) }
        if fd >= 0 {
            let connection = RuntimeSocket(metadata: metadata, fd: fd)
            do {
                let status = try LocalRPC.exchange("status.get", [:], connection: connection, timeout: timeout)
                try RuntimeCompatibility.check(status, metadata: metadata, owner: RuntimeProfile.ownership(at: profile))
                return connection
            } catch { Darwin.close(fd); throw error }
        }
        let code = errno
        guard code == ENOENT || code == ECONNREFUSED else {
            throw OrcError("Cannot connect to Orca: \(String(cString: strerror(code))).")
        }
        return nil
    }

    func resolveExecutable() throws -> URL {
        if let override = environment["ORCA_APP_EXECUTABLE"], !override.isEmpty {
            guard override.hasPrefix("/") else { throw OrcError("ORCA_APP_EXECUTABLE must be an absolute path to Orca.app/Contents/MacOS/Orca.") }
            guard FileManager.default.isExecutableFile(atPath: override) else {
                throw OrcError("ORCA_APP_EXECUTABLE is missing or not executable. Correct the development override, or unset it to use Orc's bundled runtime.")
            }
            return URL(fileURLWithPath: override).resolvingSymlinksInPath()
        }
        return try BundledRuntime.verify(host: BundledRuntime.hostBundle(executable: hostExecutable)).executable
    }

    func launchEnvironment() -> [String: String] {
        // Do not turn the backend into a child of the agent/session invoking orc.
        var result = environment.filter { key, _ in
            !key.hasPrefix("ORCA_") && !key.hasPrefix("ELECTRON_") && key != "NODE_OPTIONS" && key != "NODE_REPL_EXTERNAL_MODULE"
        }
        result["ORCA_USER_DATA_PATH"] = profile.path
        result["ORCA_BACKGROUND_LAUNCH"] = "1"
        return result
    }

    private func start(_ executable: URL, access: BootstrapAccess?) throws -> Launch {
        let log = Darwin.open(state.appendingPathComponent("backend.log").path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard log >= 0 else { throw startupError("Cannot open the backend startup log") }
        defer { Darwin.close(log) }
        let arguments = [executable.path, "--user-data-dir=" + profile.path, "--serve"] +
            (access == nil ? ["--serve-no-pairing"] : ["--serve-json", "--serve-pairing-address", "127.0.0.1"])
        let env = launchEnvironment().map { $0.key + "=" + $0.value }
        let argv = arguments.map { strdup($0) } + [nil]
        let envp = env.map { strdup($0) } + [nil]
        defer { for pointer in argv + envp { free(pointer) } }
        var pid: Int32 = 0
        let status = orc_spawn_backend(executable.path, argv, envp, profile.path, access?.writeFD ?? log, log, &pid)
        guard status == 0 else { throw startupError("Could not launch Orca: \(String(cString: strerror(status)))") }
        let launch = Launch(pid: pid, processStart: orc_process_start_time(pid), createdAt: Date().timeIntervalSince1970)
        // Reap our child without holding a thread for the lifetime of the backend.
        let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .global(qos: .utility))
        source.setEventHandler {
            var status: Int32 = 0
            while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
            source.setEventHandler(handler: nil)
            source.cancel()
        }
        source.resume()
        return launch
    }

    private func startupError(_ message: String) -> OrcError {
        OrcError(message + ". See " + state.appendingPathComponent("backend.log").path + ".")
    }

    private struct Launch: Codable {
        let pid: Int32
        let processStart: UInt64
        let createdAt: TimeInterval
        var isAlive: Bool { processStart != 0 && orc_process_start_time(pid) == processStart }
    }
}
