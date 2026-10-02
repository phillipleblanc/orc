import Foundation

public struct OrcError: LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// A session's name is its identity: notes, board cards and sidebar placement are keyed by it.
public struct Session: Codable, Identifiable, Hashable {
    public var id: String { handle }
    public let handle: String
    public let title: String?
    public let worktreeId: String
    public let worktreePath: String
    public let connected: Bool
    public let writable: Bool
    public let agentIdentity: String?
    public let incarnationId: String?
    public var name: String { title.flatMap { $0.isEmpty ? nil : $0 } ?? handle }

    /// The runtime's rule for session names, which are also directory and file names.
    public static func isValidName(_ name: String) -> Bool {
        // Counted and compared like the runtime: UTF-16 length, and NFC scalars rather than canonical equivalence.
        !name.isEmpty && name.utf16.count <= 64 && Array(name.unicodeScalars) == Array(name.precomposedStringWithCanonicalMapping.unicodeScalars)
            && name == name.trimmingCharacters(in: .whitespacesAndNewlines) && !name.hasPrefix(".")
            && !name.contains("/") && !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    }
}

public struct Workspace: Codable, Identifiable, Hashable {
    public let id: String
    public let path: String
    public let displayName: String?
    public let hostId: String?
    public var name: String { displayName ?? URL(fileURLWithPath: path).lastPathComponent }
}

public func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
}

public func jsonData(_ value: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])
}

public func jsonObject(_ data: Data) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw OrcError("The runtime returned an invalid object.")
    }
    return value
}

public func decode<T: Decodable>(_ value: Any, as: T.Type = T.self) throws -> T {
    try JSONDecoder().decode(T.self, from: jsonData(value))
}

public func resolveSession(_ selector: String, in sessions: [Session]) throws -> Session {
    if let exact = sessions.first(where: { $0.handle == selector }) { return exact }
    let named = sessions.filter { $0.name == selector }
    let matches = named.isEmpty ? sessions.filter { $0.handle.hasPrefix(selector) } : named
    guard matches.count == 1, let match = matches.first else {
        if matches.isEmpty { throw OrcError("No session named '\(selector)'. Run `orc list`.") }
        throw OrcError("Session name '\(selector)' is ambiguous. Use a handle from `orc list`.")
    }
    return match
}

public struct SessionListing: Decodable {
    public let terminals: [Session]
    public let totalCount: Int
    public let truncated: Bool
}

public struct SessionService {
    public init() {}
    public func list() async throws -> SessionListing {
        try decode(await LocalRPC.call("terminal.list", ["limit": 10000]))
    }
    public func workspaces() async throws -> [Workspace] {
        let result = try await LocalRPC.call("worktree.list", ["limit": 10000])
        return try decode(result["worktrees"] ?? [])
    }
    public func registerProject(at directory: URL) async throws -> Workspace {
        let path = directory.standardizedFileURL.resolvingSymlinksInPath()
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw OrcError("Choose an existing project directory.")
        }
        _ = try await LocalRPC.call("repo.add", ["path": path.path], timeout: 60)
        let projects = try await workspaces()
        guard let project = projects.first(where: { $0.path == path.path && ($0.hostId == nil || $0.hostId == "local") }) else {
            throw OrcError("The runtime accepted project registration but has not listed it yet. Check `orc projects` before trying again.")
        }
        return project
    }
    public func create(name: String, worktree: String, command: String?) async throws -> String {
        var params: [String: Any] = ["title": try validatedName(name), "worktree": worktree, "clientMutationId": UUID().uuidString]
        if let command, !command.isEmpty { params["command"] = command }
        let response = try await LocalRPC.call("terminal.create", params, timeout: 60)
        guard let handle = (response["terminal"] as? [String: Any])?["handle"] as? String else {
            throw OrcError("The runtime did not return the created session. Check `orc list` before retrying.")
        }
        return handle
    }
    /// Renaming changes the session's identity; its notes move with it.
    public func rename(handle: String, name: String) async throws {
        let name = try validatedName(name)
        guard let session = try await list().terminals.first(where: { $0.handle == handle }) else {
            throw OrcError("This session is no longer available. Refresh the session list.")
        }
        _ = try await LocalRPC.call("terminal.rename", ["terminal": handle, "title": name])
        try SessionNotesStore.rename(session.name, to: name)
    }
    /// Ends the session and the program running in it. A closed agent session can be reopened.
    public func close(handle: String) async throws {
        _ = try await LocalRPC.call("terminal.close", ["terminal": handle])
    }
    func validatedName(_ name: String) throws -> String {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Session.isValidName(name) else {
            throw OrcError("Choose a session name of 1–64 characters without \"/\" or control characters, not starting with \".\".")
        }
        return name
    }
}
