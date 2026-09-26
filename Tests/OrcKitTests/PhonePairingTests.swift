import XCTest
import CoreImage
@testable import OrcKit

final class PhonePairingTests: XCTestCase {
    private let key = Data(repeating: 7, count: 32).base64EncodedString()
    private func fixture(scope: String = "mobile", endpoint: String = "ws://100.64.1.2:6767", device: String = "phone", key: String? = nil) throws -> [String: Any] {
        let claims = try jsonData(["v": 2, "scope": scope, "endpoint": endpoint, "deviceToken": "private-test-credential",
                                  "publicKeyB64": key ?? self.key, "pairedDeviceId": device])
        let code = claims.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        return ["runtimeId": "runtime", "scope": "mobile", "deviceId": "phone", "endpoint": endpoint,
                "pairingUrl": "orca://pair?code=" + code]
    }
    private func validate(_ response: [String: Any]) throws -> PhonePairingOffer {
        let metadata: RuntimeMetadata = try decode(["runtimeId": "runtime", "authToken": "local-secret",
            "transports": [["kind": "websocket", "endpoint": "ws://0.0.0.0:6767"]]])
        return try PhonePairingOffer.validated(response, metadata: metadata, publicKey: key, address: "100.64.1.2")
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
