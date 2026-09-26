import Foundation

struct BundledCLIReply {
    var body: [String: Any]
    var exitCode: Int32
    var result: [String: Any] { body["result"] as? [String: Any] ?? [:] }
    var succeeded: Bool { exitCode == 0 && body["ok"] as? Bool == true }
}

struct BundledCLI {
    let executable: URL
    let environment: [String: String]
    let runtimeID: String

    init(runtimeID: String, hostExecutable: URL = BundledRuntime.currentExecutable,
         environment: [String: String] = ProcessInfo.processInfo.environment) throws {
        let host = try BundledRuntime.hostBundle(executable: hostExecutable)
        let runtime = try BundledRuntime.verify(host: host)
        self.executable = runtime.executable.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Resources/bin/orca")
        var environment = environment
        environment["ORCA_USER_DATA_PATH"] = RuntimeMetadata.directory.resolvingSymlinksInPath().path
        environment["ORCA_CLI_COMMAND"] = executable.path
        environment["ORCA_BACKGROUND_LAUNCH"] = "1"
        for key in ["ORCA_APP_EXECUTABLE", "ORCA_OPEN_COMMAND", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_REPL_EXTERNAL_MODULE",
                    "ORCA_ENVIRONMENT", "ORCA_PAIRING_CODE", "ORCA_REMOTE_PAIRING", "ORCA_DEV_CLI_INVOCATION"] {
            environment.removeValue(forKey: key)
        }
        self.environment = environment
        self.runtimeID = runtimeID
    }

    func call(_ arguments: [String]) throws -> BundledCLIReply {
        guard try RuntimeMetadata.load().runtimeId == runtimeID else {
            throw OrcError("The selected runtime changed. Inspect existing receipts before retrying against a different runtime.")
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("orc-agent-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let stdout = directory.appendingPathComponent("stdout"), stderr = directory.appendingPathComponent("stderr")
        for file in [stdout, stderr] {
            guard FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                throw OrcError("Cannot capture the bundled CLI response.")
            }
        }
        let output = try FileHandle(forWritingTo: stdout), error = try FileHandle(forWritingTo: stderr)
        defer { try? output.close(); try? error.close() }
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments + ["--json"]
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output; process.standardError = error
        try process.run()
        process.waitUntilExit()
        var response: [String: Any]?
        for file in [stdout, stderr] {
            let reader = try FileHandle(forReadingFrom: file)
            defer { try? reader.close() }
            let bytes = try reader.read(upToCount: 16 * 1024 * 1024 + 1) ?? Data()
            if bytes.count <= 16 * 1024 * 1024, let object = try? jsonObject(bytes) { response = object; break }
        }
        guard let response else {
            throw OrcError("The bundled CLI returned no valid receipt. The operation may have taken effect; inspect its request ID before retrying.")
        }
        if let actual = (response["_meta"] as? [String: Any])?["runtimeId"] as? String, actual != runtimeID {
            throw OrcError("The runtime changed during this operation. It may have taken effect; inspect its request ID before retrying.")
        }
        return BundledCLIReply(body: response, exitCode: process.terminationStatus == 0 ? 0 : 1)
    }
}
