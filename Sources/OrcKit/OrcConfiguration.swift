import Foundation

public enum SessionType: String, Codable, CaseIterable {
    case codex, claude, pi, terminal
    public var command: String? { self == .terminal ? nil : rawValue }
}

public struct OrcConfiguration: Decodable {
    public let defaultSessionType: SessionType
    public static var file: URL { Pairing.directory.appendingPathComponent("config.json") }

    public init(defaultSessionType: SessionType = .codex) { self.defaultSessionType = defaultSessionType }
    private enum CodingKeys: CodingKey { case defaultSessionType }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        defaultSessionType = try values.decodeIfPresent(SessionType.self, forKey: .defaultSessionType) ?? .codex
    }
    public static func load(from file: URL = Self.file) throws -> OrcConfiguration {
        guard FileManager.default.fileExists(atPath: file.path) else { return OrcConfiguration() }
        do { return try JSONDecoder().decode(Self.self, from: Data(contentsOf: file)) }
        catch {
            throw OrcError("Cannot read \(file.path). Use a JSON object with defaultSessionType set to codex, claude, pi, or terminal. \(error.localizedDescription)")
        }
    }
}
