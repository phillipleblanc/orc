import Foundation

public struct TerminalFrame {
    public let opcode: UInt8
    public let streamID: UInt32
    public let sequence: UInt64
    public let payload: Data
    public init(opcode: UInt8, streamID: UInt32, sequence: UInt64 = 0, payload: Data = Data()) {
        self.opcode = opcode; self.streamID = streamID; self.sequence = sequence; self.payload = payload
    }
    public init(data: Data) throws {
        let bytes = [UInt8](data)
        guard bytes.count >= 16, bytes[0] == 0x74, bytes[1] == 1 else { throw OrcError("Unsupported Orca terminal frame.") }
        func word(_ offset: Int) -> UInt32 { (0..<4).reduce(0) { $0 | UInt32(bytes[offset + $1]) << ($1 * 8) } }
        opcode = bytes[2]; streamID = word(4); sequence = UInt64(word(8)) << 32 | UInt64(word(12)); payload = Data(bytes.dropFirst(16))
    }
    public var encoded: Data {
        var bytes: [UInt8] = [0x74, 1, opcode, 0]
        for word in [streamID, UInt32(truncatingIfNeeded: sequence >> 32), UInt32(truncatingIfNeeded: sequence)] {
            bytes += (0..<4).map { UInt8(truncatingIfNeeded: word >> ($0 * 8)) }
        }
        return Data(bytes) + payload
    }
}

@MainActor public final class StreamConnection {
    private let task: URLSessionWebSocketTask
    private let session: URLSession
    private let pairing: Pairing
    private let crypto: NaClChannel
    private var receiving: Task<Void, Never>?
    private var pending: [String: CheckedContinuation<[String: Any], Error>] = [:]
    private var deadlines: [String: Task<Void, Never>] = [:]
    private var closed = false
    public var onEvent: (([String: Any]) -> Void)?
    public var onBinary: ((Data) -> Void)?
    public var onClose: ((Error?) -> Void)?

    public init(pairing: Pairing) throws {
        self.pairing = pairing
        crypto = try NaClChannel(peerKey: Data(base64Encoded: pairing.publicKeyB64) ?? Data())
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        session = URLSession(configuration: config)
        task = session.webSocketTask(with: try pairing.localEndpoint())
        task.maximumMessageSize = 16 * 1024 * 1024
    }
    public func connect() async throws {
        task.resume()
        let timer = Task { try? await Task.sleep(nanoseconds: 12_000_000_000); if !Task.isCancelled { self.task.cancel(with: .goingAway, reason: nil) } }
        defer { timer.cancel() }
        do {
            try await task.send(.string(String(decoding: jsonData(["type": "e2ee_hello", "publicKeyB64": crypto.publicKey.base64EncodedString()]), as: UTF8.self)))
            guard case .string(let ready) = try await task.receive(), try jsonObject(Data(ready.utf8))["type"] as? String == "e2ee_ready" else {
                throw OrcError("Orca rejected the encryption handshake.")
            }
            try await sendJSON(["type": "e2ee_auth", "deviceToken": pairing.deviceToken])
            guard case .string(let encrypted) = try await task.receive(), let data = Data(base64Encoded: encrypted),
                  try jsonObject(crypto.open(data))["type"] as? String == "e2ee_authenticated" else {
                throw OrcError("Orca rejected this connection. Create a fresh runtime access link and run `orc connect`.")
            }
            receiving = Task { await receiveLoop() }
        } catch { close(); throw error }
    }
    private func sendJSON(_ value: [String: Any]) async throws {
        try await task.send(.string(crypto.seal(jsonData(value)).base64EncodedString()))
    }
    public func request(_ method: String, _ params: [String: Any] = [:]) async throws -> [String: Any] {
        let id = UUID().uuidString
        return try await withCheckedThrowingContinuation { continuation in
            guard !closed else { continuation.resume(throwing: OrcError("Orca connection is closed.")); return }
            pending[id] = continuation
            deadlines[id] = Task {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                if !Task.isCancelled { self.finish(id, .failure(OrcError("Orca request timed out. Input was not retried."))) }
            }
            Task {
                do { try await sendJSON(["id": id, "method": method, "params": params, "deviceToken": pairing.deviceToken]) }
                catch { finish(id, .failure(error)) }
            }
        }
    }
    public func subscribe(_ method: String, _ params: [String: Any]) async throws {
        try await sendJSON(["id": "orc-stream", "method": method, "params": params, "deviceToken": pairing.deviceToken])
    }
    public func send(_ frame: TerminalFrame) async throws { try await task.send(.data(crypto.seal(frame.encoded))) }
    private func finish(_ id: String, _ result: Result<[String: Any], Error>) {
        deadlines.removeValue(forKey: id)?.cancel()
        pending.removeValue(forKey: id)?.resume(with: result)
    }
    private func receiveLoop() async {
        do {
            while !closed {
                switch try await task.receive() {
                case .data(let data): onBinary?(try crypto.open(data))
                case .string(let text):
                    guard let data = Data(base64Encoded: text) else { throw OrcError("Invalid encrypted response.") }
                    let response = try jsonObject(crypto.open(data))
                    if response["_keepalive"] as? Bool == true { continue }
                    guard let id = response["id"] as? String else { throw OrcError("Missing Orca response ID.") }
                    if id == "orc-stream" { onEvent?(try rpcResult(response)) }
                    else { finish(id, Result { try rpcResult(response) }) }
                @unknown default: throw OrcError("Unsupported WebSocket message.")
                }
            }
        } catch {
            if !closed { close(error: error); onClose?(error) }
        }
    }
    public func close(error: Error = OrcError("Detached from Orca.")) {
        guard !closed else { return }; closed = true
        receiving?.cancel(); receiving = nil
        task.cancel(with: .normalClosure, reason: nil); session.invalidateAndCancel()
        for id in Array(pending.keys) { finish(id, .failure(error)) }
    }
}
