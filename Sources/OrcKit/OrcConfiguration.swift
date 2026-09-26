import Foundation
import Darwin

public enum SessionType: String, Codable, CaseIterable {
    case codex, claude, pi, terminal
    public var command: String? {
        switch self {
        case .codex: return "codex --no-daemon"
        case .terminal: return nil
        default: return rawValue
        }
    }
}

public struct OrcConfiguration: Decodable {
    public let defaultSessionType: SessionType
    public let defaultProject: String
    public static var file: URL { Pairing.directory.appendingPathComponent("config.json") }

    public init(defaultSessionType: SessionType = .codex, defaultProject: String = "") {
        self.defaultSessionType = defaultSessionType
        self.defaultProject = defaultProject
    }
    private enum CodingKeys: CodingKey { case defaultSessionType, defaultProject }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        defaultSessionType = try values.decodeIfPresent(SessionType.self, forKey: .defaultSessionType) ?? .codex
        let project = try values.decodeIfPresent(String.self, forKey: .defaultProject)
        defaultProject = project ?? ""
        guard project == nil || !defaultProject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .defaultProject, in: values, debugDescription: "defaultProject must be a non-empty project selector.")
        }
    }
    public static func setDefaultProject(_ selector: String, file: URL = Self.file) throws {
        _ = try load(from: file)
        var settings = FileManager.default.fileExists(atPath: file.path) ? try jsonObject(Data(contentsOf: file)) : [:]
        settings["defaultProject"] = selector
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = file.deletingLastPathComponent().appendingPathComponent(".config-" + UUID().uuidString)
        let fd = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw OrcError("Cannot save the default project.") }
        defer { Darwin.close(fd); try? FileManager.default.removeItem(at: temporary) }
        try writeAll(fd, JSONSerialization.data(withJSONObject: settings, options: [.prettyPrinted, .sortedKeys]))
        guard Darwin.rename(temporary.path, file.path) == 0 else { throw OrcError("Cannot save the default project.") }
    }
    public static func load(from file: URL = Self.file) throws -> OrcConfiguration {
        guard FileManager.default.fileExists(atPath: file.path) else { return OrcConfiguration() }
        do { return try JSONDecoder().decode(Self.self, from: Data(contentsOf: file)) }
        catch {
            throw OrcError("Cannot read \(file.path). Use a JSON object with defaultSessionType set to codex, claude, pi, or terminal, and defaultProject set to a non-empty project name, absolute path, path:PATH, or id:ID. \(error.localizedDescription)")
        }
    }
}
