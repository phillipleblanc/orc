import Foundation
import CoreImage
import CoreGraphics

public struct PhonePairingQR {
    public let image: CGImage
    private let modules: [[Bool]]
    public var minimumTerminalColumns: Int { modules.count + 8 }

    public init(link: String) throws {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { throw OrcError("QR generation is unavailable.") }
        filter.setValue(Data(link.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        let context = CIContext(options: [.useSoftwareRenderer: true])
        guard let output = filter.outputImage, let image = context.createCGImage(output, from: output.extent) else {
            throw OrcError("Could not generate a QR code. Copy the pairing link instead.")
        }
        self.image = image
        let size = Int(output.extent.width)
        var pixels = [UInt8](repeating: 255, count: size * size * 4)
        context.render(output, toBitmap: &pixels, rowBytes: size * 4, bounds: output.extent,
                       format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        modules = (0..<size).map { y in (0..<size).map { x in pixels[(y * size + x) * 4] < 128 } }
    }

    /// Black modules on a white quiet zone, independent of terminal theme.
    public var terminal: String {
        let size = modules.count + 8
        func dark(_ x: Int, _ y: Int) -> Bool {
            x >= 4 && y >= 4 && x < size - 4 && y < size - 4 && modules[y - 4][x - 4]
        }
        return stride(from: 0, to: size, by: 2).map { y in
            "\u{1b}[30;47m" + (0..<size).map { x in
                switch (dark(x, y), dark(x, y + 1)) {
                case (true, true): return "█"
                case (true, false): return "▀"
                case (false, true): return "▄"
                default: return " "
                }
            }.joined() + "\u{1b}[0m"
        }.joined(separator: "\n")
    }
}
