import Foundation

/// Local notes belong to an Orca terminal handle, independently of its name.
public enum SessionNotesStore {
    public static func migrateLegacyPreferences(_ defaults: UserDefaults = .standard) {
        for (key, value) in defaults.dictionaryRepresentation() where key.hasPrefix("sessionNotes.") {
            guard let notes = value as? String else { continue }
            _ = try? load(handle: String(key.dropFirst("sessionNotes.".count)), legacy: notes)
        }
    }

    public static var directory: URL {
        Pairing.directory.appendingPathComponent("notes", isDirectory: true)
    }

    public static func file(for handle: String) throws -> URL {
        guard handle.hasPrefix("term_"), !handle.dropFirst(5).isEmpty, handle.dropFirst(5).allSatisfy({
            $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_")
        }) else { throw OrcError("Invalid Orca terminal handle for notes.") }
        return directory.appendingPathComponent(handle + ".txt")
    }

    public static func load(handle: String, legacy: String? = nil) throws -> String {
        let url = try file(for: handle)
        if FileManager.default.fileExists(atPath: url.path) {
            return try String(contentsOf: url, encoding: .utf8)
        }
        if let legacy, !legacy.isEmpty {
            try save(legacy, handle: handle)
            return legacy
        }
        return ""
    }

    public static func save(_ notes: String, handle: String) throws {
        let url = try file(for: handle)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try notes.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
