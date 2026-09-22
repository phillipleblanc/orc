import Foundation
import Darwin
import COrcSupport

public struct RuntimeMetadata: Decodable {
    public struct Transport: Decodable { public let kind: String; public let endpoint: String }
    public let runtimeId: String
    public let pid: Int32?
    public let authToken: String
    public let transports: [Transport]?
    public let transport: Transport?
    public static var directory: URL {
        if let path = ProcessInfo.processInfo.environment["ORCA_USER_DATA_PATH"] { return URL(fileURLWithPath: path) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/orca")
    }
    public static func load() throws -> RuntimeMetadata {
        try load(from: directory)
    }
    static func load(from directory: URL) throws -> RuntimeMetadata {
        try JSONDecoder().decode(Self.self, from: Data(contentsOf: directory.appendingPathComponent("orca-runtime.json")))
    }
    public func endpoint(_ kind: String) throws -> String {
        guard let endpoint = (transports ?? transport.map { [$0] } ?? []).first(where: { $0.kind == kind })?.endpoint else {
            throw OrcError("The running Orca has no \(kind) transport.")
        }
        return endpoint
    }
}

public enum LocalRPC {
    public static func call(_ method: String, _ params: [String: Any] = [:], timeout: Int = 15) async throws -> [String: Any] {
        try await Task.detached {
            let connection = try RuntimeStarter().connect(timeout: timeout)
            defer { Darwin.close(connection.fd) }
            return try exchange(method, params, connection: connection, timeout: timeout)
        }.value
    }
    static func exchange(_ method: String, _ params: [String: Any], connection: RuntimeSocket, timeout: Int) throws -> [String: Any] {
        let meta = connection.metadata, fd = connection.fd
        let id = UUID().uuidString
        var request = try jsonData(["id": id, "authToken": meta.authToken, "method": method, "params": params])
        request.append(10)
        try writeAll(fd, request)
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        let deadline = Date().addingTimeInterval(Double(timeout))
        while Date() < deadline {
            let count = Darwin.read(fd, &chunk, chunk.count)
            if count < 0, errno == EINTR { continue }
            guard count > 0 else { throw OrcError("Orca disconnected or timed out during \(method). Check its result before retrying a creation.") }
            buffer.append(contentsOf: chunk.prefix(count))
            guard buffer.count <= 16 * 1024 * 1024 else { throw OrcError("Orca response exceeds 16 MiB.") }
            while let newline = buffer.firstIndex(of: 10) {
                let line = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
                let response = try jsonObject(line)
                if response["_keepalive"] as? Bool == true { continue }
                guard response["id"] as? String == id else { throw OrcError("Mismatched Orca response.") }
                if let runtimeId = (response["_meta"] as? [String: Any])?["runtimeId"] as? String, runtimeId != meta.runtimeId {
                    throw OrcError("Orca restarted during the request.")
                }
                return try rpcResult(response)
            }
        }
        throw OrcError("Orca request timed out.")
    }
}

public func rpcResult(_ response: [String: Any]) throws -> [String: Any] {
    guard response["ok"] as? Bool == true else {
        let error = response["error"] as? [String: Any]
        throw OrcError(error?["message"] as? String ?? "Orca rejected the request.")
    }
    return response["result"] as? [String: Any] ?? [:]
}

public func writeAll(_ fd: Int32, _ data: Data) throws {
    try data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let written = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if written < 0, errno == EINTR { continue }
            guard written > 0 else { throw OrcError("Write failed: \(String(cString: strerror(errno))).") }
            offset += written
        }
    }
}
