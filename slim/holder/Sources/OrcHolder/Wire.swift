import Foundation

/// Holder socket framing: `u32le length` of everything after it, then a `u8` frame type and its
/// payload. Integers are little-endian. See slim/README.md for the operations.
enum Frame {
    static let request: UInt8 = 0x01
    static let input: UInt8 = 0x02
    static let reply: UInt8 = 0x81
    static let output: UInt8 = 0x82
    static let resize: UInt8 = 0x84

    static let maximumLength = 16 << 20

    static func encode(_ type: UInt8, _ payload: [UInt8]) -> [UInt8] {
        var frame = [UInt8]()
        frame.reserveCapacity(5 + payload.count)
        append(UInt32(1 + payload.count), to: &frame)
        frame.append(type)
        frame.append(contentsOf: payload)
        return frame
    }

    static func json(_ object: [String: Any]) -> [UInt8] {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
        return encode(reply, [UInt8](data))
    }

    static func output(offset: UInt64, bytes: [UInt8]) -> [UInt8] {
        var payload = [UInt8]()
        payload.reserveCapacity(8 + bytes.count)
        append(offset, to: &payload)
        payload.append(contentsOf: bytes)
        return encode(output, payload)
    }

    static func resize(offset: UInt64, cols: UInt16, rows: UInt16) -> [UInt8] {
        var payload = [UInt8]()
        append(offset, to: &payload)
        append(cols, to: &payload)
        append(rows, to: &payload)
        return encode(resize, payload)
    }

    static func append<T: FixedWidthInteger>(_ value: T, to bytes: inout [UInt8]) {
        withUnsafeBytes(of: value.littleEndian) { bytes.append(contentsOf: $0) }
    }

    static func readUInt32(_ bytes: [UInt8], at index: Int) -> UInt32 {
        UInt32(bytes[index]) | UInt32(bytes[index + 1]) << 8 | UInt32(bytes[index + 2]) << 16 | UInt32(bytes[index + 3]) << 24
    }
}
