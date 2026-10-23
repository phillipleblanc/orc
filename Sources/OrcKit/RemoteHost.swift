import Foundation

/// Another Mac's Orc runtime that this Mac shows: the access its `orc pair-computer` link granted, and the name it goes
/// by here.
public struct RemoteHost: Codable, Identifiable, Hashable {
    public let id: String
    public var name: String
    public var endpoint: String
    public var publicKeyB64: String
    public var deviceToken: String

    var pairing: Pairing { Pairing(endpoint: endpoint, deviceToken: deviceToken, publicKeyB64: publicKeyB64, scope: "runtime") }

    /// A name for a host from its link: the Mac's local name without `.local`, or its address.
    public static func suggestedName(endpoint: String) -> String {
        let host = URLComponents(string: endpoint)?.host ?? endpoint
        return host.hasSuffix(".local") ? String(host.dropLast(6)) : host
    }
}

/// The Macs this one has been paired to view, one file each in `ORC_CONFIG_DIR/hosts`. A host's file is full control of
/// its sessions, so it is readable only by its owner, as Orc's own `connection.json` is.
public enum RemoteHosts {
    static var directory: URL { Pairing.directory.appendingPathComponent("hosts", isDirectory: true) }

    public static func list() throws -> [RemoteHost] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return try files.filter { $0.pathExtension == "json" }
            .map { try JSONDecoder().decode(RemoteHost.self, from: Data(contentsOf: $0)) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    /// A saved host, by its id or its name.
    public static func load(_ selector: String) throws -> RemoteHost {
        if UUID(uuidString: selector) != nil, let host = try? JSONDecoder().decode(RemoteHost.self, from: Data(contentsOf: file(selector))) {
            return host
        }
        let named = try list().filter { $0.name == selector }
        guard named.count == 1 else {
            throw OrcError(named.isEmpty ? "No Mac named '\(selector)' is paired with Orc. Connect to it from Orc's Host menu."
                                         : "More than one paired Mac is named '\(selector)'. Use its id.")
        }
        return named[0]
    }

    /// Saves a host; one with the same server key is the same Mac, paired again, and keeps its id and what Orc keeps about it.
    @discardableResult public static func save(_ host: RemoteHost) throws -> RemoteHost {
        var saved = host
        if let existing = try list().first(where: { $0.publicKeyB64 == host.publicKeyB64 && $0.id != host.id }) {
            saved = RemoteHost(id: existing.id, name: host.name, endpoint: host.endpoint, publicKeyB64: host.publicKeyB64, deviceToken: host.deviceToken)
        }
        guard UUID(uuidString: saved.id) != nil else { throw OrcError("Invalid host id.") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try writePrivateFile(JSONEncoder().encode(saved), to: file(saved.id))
        return saved
    }

    /// Forgets a host and what Orc kept about its sessions. The host's grant stays until it is revoked on that Mac.
    public static func remove(_ id: String) throws {
        guard UUID(uuidString: id) != nil else { throw OrcError("Invalid host id.") }
        try? FileManager.default.removeItem(at: stateDirectory(id))
        try FileManager.default.removeItem(at: file(id))
    }

    /// What this Mac keeps about a host's sessions: which it has reviewed and which are muted.
    public static func stateDirectory(_ id: String) -> URL {
        directory.appendingPathComponent(id, isDirectory: true)
    }

    /// Checks a link from `orc pair-computer` before it is saved: the Mac answers at the link's address, holds the key
    /// the link pins (the encrypted handshake fails otherwise), accepts the link's grant, and serves what Orc needs.
    @MainActor public static func verify(link: String, name: String) async throws -> RemoteHost {
        let pairing: Pairing
        do { pairing = try Pairing.parse(link) } catch {
            throw OrcError("That is not a link from Pair Device… › Computer on the other Mac.")
        }
        let host = RemoteHost(id: UUID().uuidString, name: name, endpoint: pairing.endpoint,
                              publicKeyB64: pairing.publicKeyB64, deviceToken: pairing.deviceToken)
        let connection = try StreamConnection(host: host)
        defer { connection.close() }
        try await connection.connect()
        try await RemoteRPC.checkCompatible(connection)
        return host
    }

    private static func file(_ id: String) -> URL { directory.appendingPathComponent(id + ".json") }
}

/// The Orc runtime this process works with: this Mac's own, or another Mac's that it views. A process chooses it once,
/// before it makes any request.
public enum RuntimeHost {
    case local
    case remote(RemoteHost)

    nonisolated(unsafe) public private(set) static var current: RuntimeHost = .local
    public static func use(_ host: RuntimeHost) { current = host }

    public var remote: RemoteHost? {
        if case .remote(let host) = self { return host }
        return nil
    }

    /// Where this Mac keeps its own record of the host's sessions.
    public var stateDirectory: URL { remote.map { RemoteHosts.stateDirectory($0.id) } ?? Pairing.directory }
}

/// A request of the runtime this process works with: over the local socket for this Mac's, over the WebSocket of the
/// Mac it views otherwise.
public enum RuntimeRPC {
    public static func call(_ method: String, _ params: [String: Any] = [:], timeout: Int = 15) async throws -> [String: Any] {
        guard let host = RuntimeHost.current.remote else { return try await LocalRPC.call(method, params, timeout: timeout) }
        return try await RemoteRPC.shared.call(host, method, params, timeout: timeout)
    }

    /// Delivers the viewed Mac's events of a streaming method until the returned function is called, then
    /// `{type: "end"}` if the stream or its connection ends first. This Mac's streams are not served here.
    @MainActor public static func subscribe(_ method: String, _ params: [String: Any],
                                            onEvent: @escaping ([String: Any]) -> Void) async throws -> () -> Void {
        guard let host = RuntimeHost.current.remote else { throw OrcError("\(method) streams only from another Mac.") }
        return try await RemoteRPC.shared.subscribe(host, method, params, onEvent: onEvent)
    }
}

/// One encrypted connection to the viewed Mac, opened on the first request and again after it drops.
@MainActor final class RemoteRPC {
    static let shared = RemoteRPC()
    private var connection: (host: RemoteHost, connection: StreamConnection)?
    private var opening: (host: RemoteHost, task: Task<StreamConnection, Error>)?
    /// Each open stream's listener, by its id on the connection.
    private var streams: [String: ([String: Any]) -> Void] = [:]

    func call(_ host: RemoteHost, _ method: String, _ params: [String: Any], timeout: Int) async throws -> [String: Any] {
        do { return try await open(host).request(method, params, timeout: timeout) }
        catch is RequestNotSent {
            // The connection dropped before the request left; it goes on a new one.
            drop()
            return try await open(host).request(method, params, timeout: timeout)
        }
    }

    private func open(_ host: RemoteHost) async throws -> StreamConnection {
        if let connection, connection.host == host, !connection.connection.isClosed { return connection.connection }
        drop()
        if let opening, opening.host == host { return try await opening.task.value }
        let task = Task { @MainActor in
            let connection = try StreamConnection(host: host)
            try await connection.connect()
            do { try await Self.checkCompatible(connection) } catch { connection.close(); throw error }
            return connection
        }
        opening = (host, task)
        defer { opening = nil }
        let opened = try await task.value
        connection = (host, opened)
        opened.onStreamEvent = { [weak self] id, event in
            self?.streams[id]?(event)
            if event["type"] as? String == "end" { self?.streams[id] = nil }
        }
        opened.onClose = { [weak self] _ in
            guard let self else { return }
            for listener in self.streams.values { listener(["type": "end"]) }
            self.streams.removeAll()
        }
        return opened
    }

    /// Closes the connection, ending its streams.
    private func drop() {
        connection?.connection.close()
        connection = nil
        for listener in streams.values { listener(["type": "end"]) }
        streams.removeAll()
    }

    func subscribe(_ host: RemoteHost, _ method: String, _ params: [String: Any],
                   onEvent: @escaping ([String: Any]) -> Void) async throws -> () -> Void {
        let connection = try await open(host)
        let id = "stream-" + UUID().uuidString
        streams[id] = onEvent
        do { try await connection.subscribe(method, params, id: id) } catch { streams[id] = nil; throw error }
        return { [weak self] in self?.streams[id] = nil }
    }

    /// The protocol and capabilities Orc needs of a runtime, as it requires of its own.
    static func checkCompatible(_ connection: StreamConnection) async throws {
        let status = try await connection.request("status.get")
        let capabilities = Set(status["capabilities"] as? [String] ?? [])
        guard status["runtimeProtocolVersion"] as? Int == 3, capabilities.isSuperset(of: RuntimeStarter.capabilities) else {
            throw OrcError("That Mac's Orc is too old or too new for this one. Update Orc on both Macs.")
        }
    }
}
