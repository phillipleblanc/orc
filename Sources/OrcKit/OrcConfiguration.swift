import Foundation

public enum SessionType: String, Codable, CaseIterable {
    case codex, claude, pi, terminal
    public var command: String? { self == .terminal ? nil : rawValue }
}

public struct OrcConfiguration: Decodable {
    public let defaultSessionType: SessionType
    public let defaultProject: String
    public static var file: URL { Pairing.directory.appendingPathComponent("config.json") }

    public init(defaultSessionType: SessionType = .codex, defaultProject: String = "spiceai-project") {
        self.defaultSessionType = defaultSessionType
        self.defaultProject = defaultProject
    }
    private enum CodingKeys: CodingKey { case defaultSessionType, defaultProject }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        defaultSessionType = try values.decodeIfPresent(SessionType.self, forKey: .defaultSessionType) ?? .codex
        defaultProject = try values.decodeIfPresent(String.self, forKey: .defaultProject) ?? Self().defaultProject
        guard !defaultProject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .defaultProject, in: values, debugDescription: "defaultProject must be a non-empty project selector.")
        }
    }
    public static func load(from file: URL = Self.file) throws -> OrcConfiguration {
        guard FileManager.default.fileExists(atPath: file.path) else { return OrcConfiguration() }
        do { return try JSONDecoder().decode(Self.self, from: Data(contentsOf: file)) }
        catch {
            throw OrcError("Cannot read \(file.path). Use a JSON object with defaultSessionType set to codex, claude, pi, or terminal, and defaultProject set to a non-empty project name, absolute path, path:PATH, or id:ID. \(error.localizedDescription)")
        }
    }
}
