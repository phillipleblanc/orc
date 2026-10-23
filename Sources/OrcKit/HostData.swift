import Foundation

/// What Orc reads and writes on the disk of the Mac whose sessions it shows: this Mac's own files, or another Mac's
/// through its runtime (`orc.host-data.v1`).
public enum HostData {
    /// The largest file another Mac sends or takes in one request.
    public static let maximumTransferBytes = 12 * 1024 * 1024

    static var host: RemoteHost? { RuntimeHost.current.remote }

    /// The New Session defaults, shared with `orc new` on that Mac.
    public static func configuration() async throws -> OrcConfiguration {
        guard host != nil else { return try OrcConfiguration.load() }
        let result = try await RuntimeRPC.call("config.get")
        return OrcConfiguration(defaultSessionType: SessionType(rawValue: result["defaultSessionType"] as? String ?? "") ?? .codex,
                                defaultProject: result["defaultProject"] as? String ?? "")
    }

    public static func setDefaultSessionType(_ type: SessionType) async throws {
        guard host != nil else { return try OrcConfiguration.setDefaultSessionType(type) }
        _ = try await RuntimeRPC.call("config.set", ["defaultSessionType": type.rawValue])
    }

    /// Sets the default project selector, or removes it with nil.
    public static func setDefaultProject(_ selector: String?) async throws {
        guard host != nil else { return try OrcConfiguration.setDefaultProject(selector) }
        _ = try await RuntimeRPC.call("config.set", ["defaultProject": selector ?? NSNull()])
    }

    /// Where the New Session defaults are kept, as Settings says it.
    public static var configurationLocation: String {
        host.map { "Orc's config.json on \($0.name)" } ?? OrcConfiguration.file.path
    }

    /// A session's notes.
    public static func notes(_ name: String) async throws -> String {
        guard host != nil else { return try SessionNotesStore.load(name) }
        return try await RuntimeRPC.call("notes.get", ["name": name])["text"] as? String ?? ""
    }

    public static func saveNotes(_ text: String, for name: String) async throws {
        guard host != nil else { return try SessionNotesStore.save(text, for: name) }
        _ = try await RuntimeRPC.call("notes.set", ["name": name, "text": text])
    }

    /// A file on that Mac, as Markdown windows read it: at most `maximumBytes`, and UTF-8 text unless `binary`.
    public static func read(_ url: URL, maximumBytes: Int, binary: Bool = false) async throws -> Data {
        guard let host else { return try MarkdownDocument.readFile(url, maximumBytes: maximumBytes) }
        let result = try await RuntimeRPC.call("file.read", ["path": url.path, "encoding": binary ? "base64" : "utf8"], timeout: 60)
        let data = binary ? (result["data"] as? String).flatMap { Data(base64Encoded: $0) } : (result["text"] as? String).map { Data($0.utf8) }
        guard let data else { throw OrcError("\(host.name) sent an unreadable copy of \(url.lastPathComponent).") }
        guard data.count <= maximumBytes else { throw OrcError("This file is too large to preview (limit: \(maximumBytes / 1024 / 1024) MiB).") }
        return data
    }

    /// Saves a copy of a file on that Mac, for a program there to read, and returns its path there.
    public static func saveAttachment(name: String, data: Data) async throws -> String {
        guard data.count <= maximumTransferBytes else { throw OrcError("“\(name)” is larger than 12 MiB, the most Orc copies to another Mac.") }
        let result = try await RuntimeRPC.call("attachment.save", ["name": name, "data": data.base64EncodedString()], timeout: 120)
        guard let path = result["path"] as? String else { throw OrcError("The other Mac did not say where it saved “\(name)”.") }
        return path
    }

    /// The folders in a folder on that Mac; only its home folder can be browsed.
    public static func folders(in path: String) async throws -> (path: String, folders: [String], truncated: Bool) {
        let result = try await RuntimeRPC.call("fs.list", ["path": path, "directoriesOnly": true])
        let entries = result["entries"] as? [[String: Any]] ?? []
        return (result["path"] as? String ?? path, entries.compactMap { $0["name"] as? String }, result["truncated"] as? Bool ?? false)
    }
}
