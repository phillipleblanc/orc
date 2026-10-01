import Foundation

/// Sessions whose notifications are muted, by name. A muted session posts no idle notifications and
/// is left out of the Dock badge.
public struct SessionMutes: Codable, Equatable, Sendable {
    public private(set) var names: Set<String> = []

    public init(names: Set<String> = []) { self.names = names }

    public func isMuted(_ name: String) -> Bool { names.contains(name) }

    public mutating func set(_ muted: Bool, for name: String) {
        if muted { names.insert(name) } else { names.remove(name) }
    }

    /// Keeps a muted session muted under its new name.
    public mutating func rename(_ name: String, to newName: String) {
        guard names.remove(name) != nil else { return }
        names.insert(newName)
    }

    /// Forgets names that no running or recently closed session has, so a later session that reuses
    /// a name does not start muted.
    public mutating func prune(keeping kept: Set<String>) {
        names.formIntersection(kept)
    }

    public func unmuted(_ sessions: [Session]) -> [Session] { sessions.filter { !isMuted($0.name) } }
}

public enum SessionMuteStore {
    public static var file: URL { Pairing.directory.appendingPathComponent("muted-sessions.json") }

    public static func load(from url: URL = file) throws -> SessionMutes {
        guard FileManager.default.fileExists(atPath: url.path) else { return SessionMutes() }
        return try JSONDecoder().decode(SessionMutes.self, from: Data(contentsOf: url))
    }

    public static func save(_ mutes: SessionMutes, to url: URL = file) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(mutes).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
