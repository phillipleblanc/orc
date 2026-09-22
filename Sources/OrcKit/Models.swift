import Foundation

public struct OrcError: LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

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
    public var attachCommand: String { "orc attach " + shellQuote(handle) }
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
        throw OrcError("Orca returned an invalid object.")
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

    init(response: [String: Any], preferTabTitles: Bool) throws {
        // terminal.rename changes the parent tab name. Per-pane terminal titles
        // remain controlled by shell/agent OSC updates, so use the layout's tab
        // title for every handle it contains. Headless terminals keep their title.
        var titles: [String: String] = [:]
        func visit(_ node: [String: Any], title: String? = nil) {
            switch node["type"] as? String {
            case "group":
                // Synthetic headless layouts can retain an old tab title after
                // a rename; their live terminal record owns the saved name.
                guard !(node["groupId"] as? String ?? "").hasPrefix("headless-terminals:") else { return }
                for tab in node["tabs"] as? [[String: Any]] ?? [] {
                    if let panes = tab["panes"] as? [String: Any] {
                        visit(panes, title: tab["title"] as? String)
                    }
                }
            case "split", "pane-split":
                for child in ["first", "second"] {
                    if let child = node[child] as? [String: Any] { visit(child, title: title) }
                }
            case "terminal":
                if let handle = node["handle"] as? String, let title,
                   !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    titles[handle] = title
                }
            default: break
            }
        }
        for layout in preferTabTitles ? response["visualLayouts"] as? [[String: Any]] ?? [] : [] {
            if let root = layout["root"] as? [String: Any] { visit(root) }
        }
        var listing = response
        if let terminals = response["terminals"] as? [[String: Any]] {
            listing["terminals"] = terminals.map { terminal in
                var terminal = terminal
                if let handle = terminal["handle"] as? String, let title = titles[handle] {
                    terminal["title"] = title
                }
                return terminal
            }
        }
        self = try decode(listing)
    }
}

public struct SessionService {
    public init() {}
    public func list() async throws -> SessionListing {
        async let status = LocalRPC.call("status.get")
        let response = try await LocalRPC.call("terminal.list", ["limit": 10000, "includeVisualLayouts": true])
        return try await SessionListing(response: response, preferTabTitles: status["desktopWindowStatus"] as? String == "available")
    }
    public func workspaces() async throws -> [Workspace] {
        let result = try await LocalRPC.call("worktree.list", ["limit": 10000])
        return try decode(result["worktrees"] ?? [])
    }
    public func create(name: String, worktree: String, command: String?) async throws -> String {
        let name = try validatedName(name)
        let existing = try await list()
        guard !existing.terminals.contains(where: { $0.name == name }) else {
            throw OrcError("A session named '\(name)' already exists.")
        }
        var params: [String: Any] = ["title": name, "worktree": worktree,
            "clientMutationId": UUID().uuidString, "presentation": "background", "focus": false]
        if let command, !command.isEmpty { params["command"] = command }
        let response = try await LocalRPC.call("terminal.create", params, timeout: 60)
        let result = response["terminal"] as? [String: Any] ?? response
        guard let handle = result["handle"] as? String else { throw OrcError("Orca did not return the created session handle. Check `orc list` before retrying.") }
        // Creation sets the initial process title. Rename pins the user's tab title
        // so shell OSC title updates cannot erase the name used by `orc attach`.
        do { _ = try await LocalRPC.call("terminal.rename", ["terminal": handle, "title": name]) }
        catch { throw OrcError("Created \(handle), but could not set its permanent name: \(error.localizedDescription). Use that handle; do not create it again.") }
        return handle
    }
    public func rename(handle: String, name: String) async throws {
        let name = try validatedName(name)
        let existing = try await list()
        guard existing.terminals.contains(where: { $0.handle == handle }) else {
            throw OrcError("This session is no longer available. Refresh the session list.")
        }
        guard !existing.terminals.contains(where: { $0.handle != handle && $0.name == name }) else {
            throw OrcError("A session named '\(name)' already exists.")
        }
        _ = try await LocalRPC.call("terminal.rename", ["terminal": handle, "title": name])
    }
    private func validatedName(_ name: String) throws -> String {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf8.count <= 200, !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw OrcError("Choose a session name of 1–200 bytes without control characters.")
        }
        return name
    }
}
