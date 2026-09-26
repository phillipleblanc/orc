import Foundation
import Darwin

public struct RuntimeProfileChoiceRequired: LocalizedError {
    public var errorDescription: String? {
        "Choose Start Fresh in Orc to set up bundled sessions, or run `orc setup --fresh`. Existing Orca sessions and phone pairings stay in the old profile. To keep using that profile, select it with ORCA_USER_DATA_PATH and ORCA_APP_EXECUTABLE."
    }
}

enum RuntimeProfile {
    struct Ownership: Codable {
        let schemaVersion: Int
        let bundleIdentifier: String
        let runtimeVersion: String
    }
    static let marker = "orc-runtime-profile.json"
    static func directory(environment: [String: String] = ProcessInfo.processInfo.environment,
                          config: URL = Pairing.directory, home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        if let path = environment["ORCA_USER_DATA_PATH"] { return URL(fileURLWithPath: path) }
        if let executable = environment["ORCA_APP_EXECUTABLE"], !executable.isEmpty {
            return home.appendingPathComponent("Library/Application Support/orca")
        }
        return config.appendingPathComponent("runtime")
    }

    static func validateSelection(environment: [String: String], config: URL,
                                  home: URL = FileManager.default.homeDirectoryForCurrentUser) throws {
        if let path = environment["ORCA_USER_DATA_PATH"] {
            guard path.hasPrefix("/") else { throw OrcError("ORCA_USER_DATA_PATH must be an absolute profile path.") }
            return
        }
        if let executable = environment["ORCA_APP_EXECUTABLE"], !executable.isEmpty { return }
        let profile = directory(environment: environment, config: config, home: home)
        if FileManager.default.fileExists(atPath: profile.appendingPathComponent(marker).path) { return }
        let legacy = home.appendingPathComponent("Library/Application Support/orca")
        if FileManager.default.fileExists(atPath: config.appendingPathComponent("connection.json").path) ||
            (environment["ORC_CONFIG_DIR"] == nil && FileManager.default.fileExists(atPath: legacy.path)) {
            throw RuntimeProfileChoiceRequired()
        }
    }

    static func ownership(at profile: URL) throws -> Ownership? {
        let file = profile.appendingPathComponent(marker)
        var info = stat()
        if lstat(file.path, &info) != 0 {
            if errno == ENOENT { return nil }
            throw OrcError("Cannot read runtime profile ownership.")
        }
        guard info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else {
            throw OrcError("Runtime profile ownership must be an owner-only regular file.")
        }
        let owner = try JSONDecoder().decode(Ownership.self, from: Data(contentsOf: file))
        guard owner.schemaVersion == 1, owner.bundleIdentifier == BundledRuntime.identifier else {
            throw OrcError("This profile does not belong to the bundled Orc runtime.")
        }
        return owner
    }

    private static func requiresPreparation(_ profile: URL, version: String) throws -> Bool {
        guard profile.path.utf8.count <= 75 else {
            throw OrcError("The runtime profile path is too long for macOS local sockets. Choose a shorter ORC_CONFIG_DIR or ORCA_USER_DATA_PATH.")
        }
        if let owner = try ownership(at: profile) {
            guard owner.runtimeVersion == version else {
                throw OrcError("This profile requires runtime \(owner.runtimeVersion); Orc bundles \(version). An explicit profile migration is required. No runtime was launched.")
            }
            return false
        }
        if FileManager.default.fileExists(atPath: profile.path), try !FileManager.default.contentsOfDirectory(atPath: profile.path).isEmpty {
            throw OrcError("The bundled runtime cannot open an existing unowned profile. Choose an empty ORCA_USER_DATA_PATH or a separate ORC_CONFIG_DIR.")
        }
        return true
    }

    /// Called under the profile startup lock, after verifying the bundled runtime.
    @discardableResult
    static func prepareFresh(_ profile: URL, config: URL, version: String) throws -> URL? {
        guard try requiresPreparation(profile, version: version) else { return nil }
        let connection = config.appendingPathComponent("connection.json")
        var archive: URL?
        var info = stat()
        if lstat(connection.path, &info) == 0 {
            guard info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else {
                throw OrcError("Existing runtime credentials must be an owner-only regular file before starting fresh.")
            }
            let destination = config.appendingPathComponent("connection.legacy-\(UUID().uuidString).json")
            try FileManager.default.moveItem(at: connection, to: destination)
            archive = destination
        } else if errno != ENOENT {
            throw OrcError("Cannot read existing runtime credentials. Check folder permissions.")
        }
        do {
            try prepare(profile, version: version)
        } catch {
            if let archive {
                // moveItem refuses to overwrite a connection saved by another client.
                try FileManager.default.moveItem(at: archive, to: connection)
            }
            throw error
        }
        return archive
    }

    static func prepare(_ profile: URL, version: String) throws {
        guard try requiresPreparation(profile, version: version) else { return }
        try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let owner = Ownership(schemaVersion: 1, bundleIdentifier: BundledRuntime.identifier, runtimeVersion: version)
        let fd = Darwin.open(profile.appendingPathComponent(marker).path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw OrcError("Cannot create runtime profile ownership.") }
        var written = false
        defer {
            Darwin.close(fd)
            if !written { try? FileManager.default.removeItem(at: profile.appendingPathComponent(marker)) }
        }
        try writeAll(fd, JSONEncoder().encode(owner))
        written = true
    }
}
