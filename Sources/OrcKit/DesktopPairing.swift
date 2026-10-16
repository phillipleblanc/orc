import Foundation

/// Another computer's grant: Orc for Windows viewing and driving this Mac's sessions.
public struct DesktopDevice: Codable, Identifiable {
    public let deviceId: String
    public let name: String
    public let pairedAt: Double
    public let lastSeenAt: Double
    public let connected: Bool
    public var id: String { deviceId }
    public var isPaired: Bool { lastSeenAt > 0 }
}

public struct DesktopPairingStatus: Decodable {
    public let runtimeId: String
    public let interfaces: [PhonePairingStatus.Address]
    /// This Mac's names on the local network (`NAME.local`), which keep working when its addresses change.
    public let hostnames: [String]
    public let defaultAddress: String?
    public let devices: [DesktopDevice]

    /// Whether a computer can be given `address`: one of this Mac's addresses or local names.
    public func offers(_ address: String) -> Bool {
        hostnames.contains(address) || interfaces.contains { $0.address == address }
    }
}

public enum DesktopPairingService {
    /// The name a computer's grant gets unless one is given.
    public static let defaultName = "Windows PC"

    public static func status() async throws -> DesktopPairingStatus {
        try await PairingAdministration.request("orc.desktop.status") { response, _ in try decode(response) }
    }

    public static func create(address: String, name: String = defaultName, rotate: Bool = false) async throws -> PairingOffer {
        try await PairingAdministration.request("orc.desktop.create", ["address": address, "name": name, "rotate": rotate]) { response, metadata in
            try PairingAdministration.offer(response, metadata: metadata, address: address, scope: "runtime")
        }
    }

    public static func revoke(deviceId: String) async throws {
        let _: Bool = try await PairingAdministration.request("orc.desktop.revoke", ["deviceId": deviceId]) { response, _ in
            guard response["revoked"] as? Bool == true else { throw OrcError("The computer's grant was not revoked. Refresh the list.") }
            return true
        }
    }
}
