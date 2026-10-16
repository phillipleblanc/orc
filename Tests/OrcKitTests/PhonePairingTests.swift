import XCTest
import CoreImage
@testable import OrcKit

final class PhonePairingTests: XCTestCase {
    private let key = Data(repeating: 7, count: 32).base64EncodedString()
    private func fixture(scope: String = "mobile", endpoint: String = "ws://100.64.1.2:6767", device: String = "phone", key: String? = nil,
                         offerScope: String = "mobile") throws -> [String: Any] {
        let claims = try jsonData(["v": 2, "scope": scope, "endpoint": endpoint, "deviceToken": "private-test-credential",
                                  "publicKeyB64": key ?? self.key, "pairedDeviceId": device])
        let code = claims.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        return ["runtimeId": "runtime", "scope": offerScope, "deviceId": "phone", "endpoint": endpoint,
                "pairingUrl": "orca://pair?code=" + code]
    }
    private func validate(_ response: [String: Any], address: String = "100.64.1.2", scope: String = "mobile") throws -> PairingOffer {
        let metadata: RuntimeMetadata = try decode(["runtimeId": "runtime", "authToken": "local-secret",
            "transports": [["kind": "websocket", "endpoint": "ws://0.0.0.0:6767"]]])
        return try PairingOffer.validated(response, metadata: metadata, publicKey: key, address: address, scope: scope)
    }

    func testPhoneOfferPinsRuntimeScopeAddressDeviceAndKey() throws {
        let valid = try fixture()
        XCTAssertEqual(try validate(valid).scope, "mobile")
        var wrongRuntime = valid; wrongRuntime["runtimeId"] = "another-runtime"
        let invalid = try [fixture(scope: "runtime"), fixture(endpoint: "ws://127.0.0.1:6767"),
                           fixture(endpoint: "ws://100.64.1.2:9999"), fixture(device: "different-phone"),
                           fixture(key: Data(repeating: 9, count: 32).base64EncodedString()), wrongRuntime]
        for response in invalid {
            XCTAssertThrowsError(try validate(response)) { error in
                XCTAssertFalse(error.localizedDescription.contains("private-test-credential"))
                XCTAssertFalse(error.localizedDescription.contains("orca://pair"))
            }
        }
        XCTAssertThrowsError(try Pairing.parse(try validate(valid).pairingUrl))
    }

    func testComputerOfferPinsRuntimeScopeAndTheLocalNameOrAddress() throws {
        let host = "Phillips-MacBook-Pro.local"
        func computer(scope: String = "runtime", endpoint: String = "ws://Phillips-MacBook-Pro.local:6767", offerScope: String = "runtime") throws -> [String: Any] {
            try fixture(scope: scope, endpoint: endpoint, offerScope: offerScope)
        }
        let offer = try validate(computer(), address: host, scope: "runtime")
        XCTAssertEqual(offer.endpoint, "ws://Phillips-MacBook-Pro.local:6767")
        // A computer's link is the runtime access link Orc for Windows and Orc itself accept.
        XCTAssertEqual(try Pairing.parse(offer.pairingUrl).scope, "runtime")
        XCTAssertEqual(try validate(computer(endpoint: "ws://100.64.1.2:6767"), address: "100.64.1.2", scope: "runtime").deviceId, "phone")
        for (response, address) in try [(computer(), "Other-Mac.local"), (computer(scope: "mobile"), host), (computer(offerScope: "mobile"), host),
                                         (computer(endpoint: "ws://Phillips-MacBook-Pro.local:9999"), host),
                                         (computer(endpoint: "wss://Phillips-MacBook-Pro.local:6767"), host)] {
            XCTAssertThrowsError(try validate(response, address: address, scope: "runtime")) { error in
                XCTAssertFalse(error.localizedDescription.contains("private-test-credential"))
            }
        }
        XCTAssertThrowsError(try validate(fixture(), scope: "runtime"), "a phone's offer is not a computer's")
    }

    func testImageAndTerminalQRDecodeToTheSamePairingLink() throws {
        let link = try validate(fixture()).pairingUrl
        let qr = try PhonePairingQR(link: link)
        func decoded(_ image: CIImage) -> String? {
            let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: CIContext(), options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
            return (detector?.features(in: image.transformed(by: CGAffineTransform(scaleX: 6, y: 6))).first as? CIQRCodeFeature)?.messageString
        }
        XCTAssertEqual(decoded(CIImage(cgImage: qr.image)), link)
        let rows = qr.terminal.components(separatedBy: "\n").map {
            Array($0.replacingOccurrences(of: "\u{1b}[30;47m", with: "").replacingOccurrences(of: "\u{1b}[0m", with: ""))
        }
        let width = try XCTUnwrap(rows.first?.count), height = rows.count * 2
        var pixels = [UInt8]()
        for row in rows {
            pixels += row.map { ($0 == "█" || $0 == "▀") ? UInt8(0) : 255 }
            pixels += row.map { ($0 == "█" || $0 == "▄") ? UInt8(0) : 255 }
        }
        let terminalImage = CIImage(bitmapData: Data(pixels), bytesPerRow: width,
                                   size: CGSize(width: width, height: height), format: .L8, colorSpace: CGColorSpaceCreateDeviceGray())
        XCTAssertEqual(decoded(terminalImage), link)
    }
}
