import Foundation
import Darwin
import COrcSupport

public struct Pairing: Codable {
    public let endpoint: String
    public let deviceToken: String
    public let publicKeyB64: String
    public let scope: String?
    public static func parse(_ input: String) throws -> Pairing {
        let input = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard input.count <= 32768, let url = URLComponents(string: input), url.scheme == "orca", url.host == "pair",
              let code = url.queryItems?.first(where: { $0.name == "code" })?.value ?? url.fragment else {
            throw OrcError("Paste an Orca runtime access link (orca://pair?code=…).")
        }
        var base64 = code.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64), let pairing = try? JSONDecoder().decode(Pairing.self, from: data),
              let endpoint = URL(string: pairing.endpoint), ["ws", "wss"].contains(endpoint.scheme), endpoint.host != nil,
              Data(base64Encoded: pairing.publicKeyB64)?.count == 32, !pairing.deviceToken.isEmpty,
              pairing.scope == nil || pairing.scope == "runtime" else {
            throw OrcError("This is not a valid runtime access link. Use Remote Orca Servers, rather than mobile pairing.")
        }
        return pairing
    }
    public static var directory: URL {
        if let path = ProcessInfo.processInfo.environment["ORC_CONFIG_DIR"] { return URL(fileURLWithPath: path) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/orc")
    }
    public static var isConfigured: Bool { FileManager.default.fileExists(atPath: directory.appendingPathComponent("connection.json").path) }
    public static func load() throws -> Pairing {
        do { return try JSONDecoder().decode(Pairing.self, from: Data(contentsOf: directory.appendingPathComponent("connection.json"))) }
        catch { throw OrcError("Connect Orc once: open Orc’s Connection settings, or run `orc connect` and paste a runtime access link from Orca → Settings → Remote Orca Servers.") }
    }
    public func save() throws {
        try FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temp = Self.directory.appendingPathComponent(".connection-\(UUID().uuidString)")
        let fd = Darwin.open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw OrcError("Cannot save the Orc connection.") }
        defer { Darwin.close(fd); try? FileManager.default.removeItem(at: temp) }
        try writeAll(fd, JSONEncoder().encode(self))
        guard Darwin.rename(temp.path, Self.directory.appendingPathComponent("connection.json").path) == 0 else {
            throw OrcError("Cannot save the Orc connection.")
        }
    }
    public func localEndpoint(metadata: RuntimeMetadata) throws -> URL {
        // The key pins the host; the runtime metadata follows its current listening port.
        var components = URLComponents(string: try metadata.endpoint("websocket"))
        if components?.host == "0.0.0.0" || components?.host == "::" || components?.host == "[::]" { components?.host = "127.0.0.1" }
        guard let url = components?.url else { throw OrcError("Invalid local Orca WebSocket endpoint.") }
        return url
    }
}

public struct NaClChannel {
    public let publicKey: Data
    private let shared: [UInt8]
    public init(peerKey: Data) throws {
        guard peerKey.count == 32 else { throw OrcError("Invalid Orca public key.") }
        var pk = [UInt8](repeating: 0, count: 32), sk = pk, key = pk
        guard orc_crypto_keypair(&pk, &sk) == 0, orc_crypto_shared(&key, [UInt8](peerKey), sk) == 0 else {
            throw OrcError("Cannot establish Orca encryption.")
        }
        publicKey = Data(pk); shared = key
    }
    public func seal(_ data: Data) throws -> Data {
        var out = [UInt8](repeating: 0, count: data.count + 40)
        guard orc_crypto_seal(&out, [UInt8](data), data.count, shared) == 0 else { throw OrcError("Encryption failed.") }
        return Data(out)
    }
    public func open(_ data: Data) throws -> Data {
        guard data.count >= 40, data.count <= 16 * 1024 * 1024 else { throw OrcError("Invalid encrypted frame size.") }
        var out = [UInt8](repeating: 0, count: max(1, data.count - 40))
        guard orc_crypto_open(&out, [UInt8](data), data.count, shared) == 0 else { throw OrcError("Orca frame authentication failed.") }
        return Data(out.prefix(data.count - 40))
    }
}
