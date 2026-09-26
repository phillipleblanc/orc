import Foundation
import Darwin

public struct PhoneDevice: Codable, Identifiable {
    public let deviceId: String
    public let name: String
    public let pairedAt: Double
    public let lastSeenAt: Double
    public var id: String { deviceId }
    public var isPaired: Bool { lastSeenAt > 0 }
}

public struct PhonePairingStatus: Decodable {
    public struct Address: Decodable, Identifiable {
        public let name: String
        public let address: String
        public var id: String { name + ":" + address }
    }
    public let runtimeId: String
    public let interfaces: [Address]
    public let defaultAddress: String?
    public let devices: [PhoneDevice]
}

public struct PhonePairingOffer: Codable {
    public let runtimeId: String
    public let pairingUrl: String
    public let endpoint: String
    public let deviceId: String
    public let scope: String

    static func validated(_ response: [String: Any], metadata: RuntimeMetadata, publicKey: String, address: String) throws -> Self {
        struct Claims: Decodable {
            let v: Int
            let endpoint: String
            let deviceToken: String
            let publicKeyB64: String
            let pairedDeviceId: String
            let scope: String
        }
        do {
            let offer: Self = try decode(response)
            guard offer.runtimeId == metadata.runtimeId, offer.scope == "mobile", offer.pairingUrl.utf8.count < 8192,
                  let url = URLComponents(string: offer.pairingUrl), url.scheme == "orca", url.host == "pair",
                  let code = url.queryItems?.first(where: { $0.name == "code" })?.value else { throw OrcError("Invalid offer.") }
            var base64 = code.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
            guard let data = Data(base64Encoded: base64) else { throw OrcError("Invalid offer.") }
            let claims = try JSONDecoder().decode(Claims.self, from: data)
            let endpoint = URLComponents(string: offer.endpoint)
            let bound = URLComponents(string: try metadata.endpoint("websocket"))
            guard claims.v == 2, claims.scope == "mobile", claims.pairedDeviceId == offer.deviceId,
                  !claims.deviceToken.isEmpty, claims.publicKeyB64 == publicKey,
                  Data(base64Encoded: publicKey)?.count == 32, claims.endpoint == offer.endpoint,
                  endpoint?.scheme == "ws", endpoint?.host?.trimmingCharacters(in: CharacterSet(charactersIn: "[]")) == address,
                  endpoint?.port != nil, endpoint?.port == bound?.port, endpoint?.path == bound?.path,
                  endpoint?.user == nil, endpoint?.password == nil, endpoint?.query == nil, endpoint?.fragment == nil else {
                throw OrcError("Invalid offer.")
            }
            return offer
        } catch { throw OrcError("The phone pairing offer did not match this runtime, address, or server key. No link was displayed.") }
    }
}

public enum PhonePairingService {
    public static func status() async throws -> PhonePairingStatus {
        try await request("status") { response, _ in try decode(response) }
    }

    public static func create(address: String, rotate: Bool = false) async throws -> PhonePairingOffer {
        try await request("create", ["address": address, "rotate": rotate]) { response, metadata in
            let current = try RuntimeMetadata.load()
            guard current.runtimeId == metadata.runtimeId else { throw OrcError("The runtime changed during phone pairing. No link was displayed.") }
            return try PhonePairingOffer.validated(response, metadata: current,
                publicKey: BootstrapAccess.publicKey(profile: RuntimeMetadata.directory), address: address)
        }
    }

    public static func revoke(deviceId: String) async throws {
        let _: Bool = try await request("revoke", ["deviceId": deviceId]) { response, _ in
            guard response["revoked"] as? Bool == true else { throw OrcError("The phone grant was not revoked. Refresh the device list.") }
            return true
        }
    }

    private static func request<T>(_ operation: String, _ params: [String: Any] = [:],
                                   decode: @escaping ([String: Any], RuntimeMetadata) throws -> T) async throws -> T {
        try await Task.detached {
            let connection = try RuntimeStarter().connect(timeout: 15)
            defer { Darwin.close(connection.fd) }
            let response: [String: Any]
            do { response = try LocalRPC.exchange("orc.phone." + operation, params, connection: connection, timeout: 15) }
            catch {
                if error.localizedDescription.hasPrefix("Unknown method: orc.phone.") {
                    throw OrcError("This running runtime does not support Orc phone pairing. Use an updated bundled runtime after explicitly stopping it when your sessions are ready. It was left running.")
                }
                throw error
            }
            guard response["schemaVersion"] as? Int == 1, response["runtimeId"] as? String == connection.metadata.runtimeId else {
                throw OrcError("Phone pairing returned an incompatible runtime response.")
            }
            return try decode(response, connection.metadata)
        }.value
    }
}
