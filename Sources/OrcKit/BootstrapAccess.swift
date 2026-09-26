import Foundation
import Darwin

/// Serve readiness contains credentials and must never reach a log.
final class BootstrapAccess {
    let readFD: Int32
    private(set) var writeFD: Int32
    init() throws {
        var descriptors: [Int32] = [0, 0]
        guard pipe(&descriptors) == 0 else { throw OrcError("Cannot create the private runtime readiness pipe.") }
        readFD = descriptors[0]; writeFD = descriptors[1]
        guard fcntl(readFD, F_SETFD, FD_CLOEXEC) == 0,
              fcntl(writeFD, F_SETFD, FD_CLOEXEC) == 0,
              fcntl(readFD, F_SETFL, O_NONBLOCK) == 0 else {
            Darwin.close(readFD); Darwin.close(writeFD)
            throw OrcError("Cannot secure the private runtime readiness pipe.")
        }
    }
    func closeWriter() { if writeFD >= 0 { Darwin.close(writeFD); writeFD = -1 } }
    deinit { Darwin.close(readFD); closeWriter() }

    func read(deadline: TimeInterval) throws -> Data {
        var buffer = Data(), bytes = [UInt8](repeating: 0, count: 8192)
        while ProcessInfo.processInfo.systemUptime < deadline {
            let count = Darwin.read(readFD, &bytes, bytes.count)
            if count > 0 {
                buffer.append(contentsOf: bytes.prefix(count))
                guard buffer.count <= 65536 else { throw OrcError("Runtime readiness exceeded its size limit.") }
                if let end = buffer.firstIndex(of: 10) { return Data(buffer[..<end]) }
            } else if count == 0 || (errno != EAGAIN && errno != EINTR) {
                throw OrcError("Runtime closed its private readiness pipe before providing access.")
            }
            Thread.sleep(forTimeInterval: 0.025)
        }
        throw OrcError("Runtime access setup timed out. The backend was left running; no credentials were saved.")
    }

    static func pairing(from data: Data, metadata: RuntimeMetadata, publicKey: String) throws -> Pairing {
        // Fixed errors keep malformed credential payloads out of diagnostics.
        do {
            let ready = try jsonObject(data)
            guard ready["type"] as? String == "orca_server_ready", ready["schemaVersion"] as? Int == 1,
                  ready["runtimeId"] as? String == metadata.runtimeId,
                  let offer = ready["pairing"] as? [String: Any], offer["available"] as? Bool == true,
                  offer["scope"] as? String == "runtime", let link = offer["url"] as? String else {
                throw OrcError("Invalid readiness.")
            }
            let pairing = try Pairing.parse(link)
            let endpoint = URLComponents(string: pairing.endpoint)
            let boundEndpoint = try metadata.endpoint("websocket")
            let bound = URLComponents(string: boundEndpoint)
            guard pairing.scope == "runtime", pairing.publicKeyB64 == publicKey,
                  endpoint?.scheme == "ws", endpoint?.host == "127.0.0.1", endpoint?.port != nil,
                  endpoint?.port == bound?.port, endpoint?.path == bound?.path,
                  endpoint?.user == nil, endpoint?.password == nil, endpoint?.query == nil, endpoint?.fragment == nil,
                  offer["endpoint"] as? String == pairing.endpoint,
                  ready["boundEndpoint"] as? String == boundEndpoint else {
                throw OrcError("Invalid pairing identity.")
            }
            return pairing
        } catch { throw OrcError("Runtime access setup returned an invalid scope, endpoint, identity, or server key. No credentials were saved.") }
    }

    static func publicKey(profile: URL) throws -> String {
        struct Key: Decodable { let publicKeyB64: String }
        let file = try FileHandle(forReadingFrom: profile.appendingPathComponent("orca-e2ee-keypair.json"))
        defer { try? file.close() }
        guard let data = try file.read(upToCount: 8193), data.count <= 8192,
              let key = try? JSONDecoder().decode(Key.self, from: data), Data(base64Encoded: key.publicKeyB64)?.count == 32 else {
            throw OrcError("Cannot verify the runtime server key.")
        }
        return key.publicKeyB64
    }
}

enum RuntimeCompatibility {
    static func check(_ status: [String: Any], metadata: RuntimeMetadata, owner: RuntimeProfile.Ownership?) throws {
        let capabilities = Set(status["capabilities"] as? [String] ?? [])
        guard status["runtimeId"] as? String == metadata.runtimeId,
              status["runtimeProtocolVersion"] as? Int == 3,
              let minimum = status["minCompatibleRuntimeClientVersion"] as? Int, minimum <= 3,
              capabilities.isSuperset(of: ["terminal.binary-stream.v1", "terminal.multiplex.v1"]) else {
            throw OrcError("The selected runtime is incompatible with Orc. Update Orc and its runtime together; the running backend was not replaced.")
        }
        if let owner, status["appVersion"] as? String != owner.runtimeVersion {
            throw OrcError("The running runtime does not match this profile's version. No backend was replaced.")
        }
    }
}
