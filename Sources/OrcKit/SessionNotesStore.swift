import Foundation

/// Local notes follow an Orca pane across terminal-handle remints.
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

    public static func file(for key: String) throws -> URL {
        guard (key.hasPrefix("term_") && !key.dropFirst(5).isEmpty) ||
              (key.hasPrefix("pane_") && !key.dropFirst(5).isEmpty),
              key.allSatisfy({
            $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_")
        }) else { throw OrcError("Invalid Orca note identity.") }
        return directory.appendingPathComponent(key + ".txt")
    }

    public static func load(handle: String, legacy: String? = nil) throws -> String {
        try load(key: handle, legacyHandle: nil, legacy: legacy)
    }

    public static func load(key: String, legacyHandle: String?, legacy: String? = nil) throws -> String {
        let url = try file(for: key)
        if FileManager.default.fileExists(atPath: url.path) {
            return try String(contentsOf: url, encoding: .utf8)
        }
        if let legacyHandle, legacyHandle != key {
            let old = try file(for: legacyHandle)
            if FileManager.default.fileExists(atPath: old.path) {
                let notes = try String(contentsOf: old, encoding: .utf8)
                try save(notes, key: key)
                return notes
            }
        }
        if let legacy, !legacy.isEmpty {
            try save(legacy, key: key)
            return legacy
        }
        return ""
    }

    public static func save(_ notes: String, handle: String) throws {
        try save(notes, key: handle)
    }

    public static func save(_ notes: String, key: String) throws {
        let url = try file(for: key)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try notes.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
