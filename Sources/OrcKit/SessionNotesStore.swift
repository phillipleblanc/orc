import Foundation

/// Each session's notes, in `ORC_CONFIG_DIR/notes/NAME.txt`. Pi's /notes command edits the same file.
public enum SessionNotesStore {
    public static var directory: URL {
        Pairing.directory.appendingPathComponent("notes", isDirectory: true)
    }

    public static func file(for name: String) throws -> URL {
        guard Session.isValidName(name) else { throw OrcError("Invalid session name for notes.") }
        return directory.appendingPathComponent(name + ".txt")
    }

    public static func load(_ name: String) throws -> String {
        let url = try file(for: name)
        guard FileManager.default.fileExists(atPath: url.path) else { return "" }
        return try String(contentsOf: url, encoding: .utf8)
    }

    public static func save(_ notes: String, for name: String) throws {
        let url = try file(for: name)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try notes.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    /// Moves notes to a session's new name, unless that name already has notes.
    static func rename(_ name: String, to newName: String) throws {
        let source = try file(for: name), target = try file(for: newName)
        guard name != newName, FileManager.default.fileExists(atPath: source.path),
              !FileManager.default.fileExists(atPath: target.path) else { return }
        try FileManager.default.moveItem(at: source, to: target)
    }
}
