import Foundation

/// Follows the escape sequences in a session's output on its way to the terminal `orc attach` runs in. It removes the
/// session's own OSC 7501 program-status sequences, which the attach reports from the runtime's records instead, and
/// says when the output so far ends between sequences and characters, where a report can be written.
public struct TerminalOutputFilter {
    private enum State { case ground, escape, intermediate, csi, osc, oscEscape, string, stringEscape }
    private static let report = Array("7501;".utf8)
    private var state = State.ground
    private var utf8Remaining = 0
    /// An escape, or the start of an OSC, held until the next bytes show whether it is a program-status sequence.
    private var held: [UInt8] = []
    private var dropping = false

    public init() {}

    public var atBoundary: Bool { state == .ground && utf8Remaining == 0 }

    public mutating func filter(_ data: Data) -> Data {
        var output = Data()
        output.reserveCapacity(data.count)
        for byte in data { consume(byte, into: &output) }
        return output
    }

    private mutating func consume(_ byte: UInt8, into output: inout Data) {
        switch state {
        case .ground:
            if byte == 0x1b { beginEscape(into: &output); return }
            if utf8Remaining > 0 && byte & 0xc0 == 0x80 { utf8Remaining -= 1 }
            else { utf8Remaining = byte >= 0xf0 && byte < 0xf8 ? 3 : byte >= 0xe0 && byte < 0xf0 ? 2 : byte >= 0xc0 && byte < 0xe0 ? 1 : 0 }
            output.append(byte)
        case .escape:
            if byte == 0x5d { held.append(byte); state = .osc; dropping = false; return }
            if byte == 0x1b { beginEscape(into: &output); return }
            output.append(contentsOf: held); held.removeAll()
            output.append(byte)
            switch byte {
            case 0x5b: state = .csi
            case 0x50, 0x58, 0x5e, 0x5f: state = .string
            case 0x20...0x2f: state = .intermediate
            default: state = .ground
            }
        case .intermediate, .csi:
            if byte == 0x1b { beginEscape(into: &output); return }
            output.append(byte)
            if byte == 0x18 || byte == 0x1a { state = .ground }
            else if state == .intermediate ? (0x30...0x7e).contains(byte) : (0x40...0x7e).contains(byte) { state = .ground }
        case .osc:
            switch byte {
            case 0x07: endOSC([byte], into: &output)
            case 0x1b: state = .oscEscape
            case 0x18, 0x1a: endOSC([byte], into: &output)
            default:
                if dropping { return }
                if held.isEmpty { output.append(byte); return }
                held.append(byte)
                let body = held.dropFirst(2)
                if !Self.report.starts(with: body) { output.append(contentsOf: held); held.removeAll() }
                else if body.count == Self.report.count { dropping = true; held.removeAll() }
            }
        case .oscEscape:
            if byte == 0x5c { endOSC([0x1b, byte], into: &output); return }
            // An escape that is not a string terminator ends the OSC and begins a sequence of its own.
            endOSC([], into: &output)
            beginEscape(into: &output)
            consume(byte, into: &output)
        case .string:
            if byte == 0x1b { state = .stringEscape; return }
            output.append(byte)
            if byte == 0x18 || byte == 0x1a { state = .ground }
        case .stringEscape:
            if byte == 0x5c { output.append(contentsOf: [0x1b, byte]); state = .ground; return }
            state = .ground
            beginEscape(into: &output)
            consume(byte, into: &output)
        }
    }

    private mutating func beginEscape(into output: inout Data) {
        output.append(contentsOf: held)
        held = [0x1b]
        utf8Remaining = 0
        state = .escape
    }

    private mutating func endOSC(_ terminator: [UInt8], into output: inout Data) {
        if !dropping {
            output.append(contentsOf: held)
            output.append(contentsOf: terminator)
        }
        held.removeAll()
        dropping = false
        state = .ground
    }
}

/// Reports a session's program-status records, as the runtime sends them, to the terminal `orc attach` runs in as
/// OSC 7501, writing only what changed since its last report.
public struct ProgramStatusReporter {
    static let clearAll = "\u{1b}]7501;state=clear\u{1b}\\"
    private static let states: Set<String> = ["idle", "working", "done", "blocked", "error"]
    private static let name = try! NSRegularExpression(pattern: "^[A-Za-z0-9_.+/-]{1,128}$")
    private var reported: [String: String] = [:]

    public init() {}

    /// The sequences that make the terminal's records `records`.
    public mutating func update(_ records: [[String: Any]]) -> String {
        let next = records.compactMap { record in (record["id"] as? String).flatMap { id in Self.sequence(record).map { (id, $0) } } }
        var text = ""
        // A clear removes a record with its children, and only clearing everything removes the root record alone.
        if reported.keys.contains(where: { id in !next.contains { $0.0 == id } }) {
            text = Self.clearAll
            reported.removeAll()
        }
        for (id, sequence) in next where reported[id] != sequence {
            text += sequence
            reported[id] = sequence
        }
        return text
    }

    /// Removes every record reported, as when the attach ends.
    public mutating func clear() -> String {
        guard !reported.isEmpty else { return "" }
        reported.removeAll()
        return Self.clearAll
    }

    static func sequence(_ record: [String: Any]) -> String? {
        guard let state = record["state"] as? String, states.contains(state) else { return nil }
        var pairs = ["state=" + state]
        if let id = record["id"] as? String, !id.isEmpty {
            guard isName(id) else { return nil }
            pairs.append("id=" + id)
        }
        if state == "blocked", let kind = record["kind"] as? String, isName(kind) { pairs.append("kind=" + kind) }
        if state == "working" || state == "blocked", let progress = record["progress"] as? Int, (0...100).contains(progress) {
            pairs.append("progress=\(progress)")
        }
        if let app = record["app"] as? String, isName(app) { pairs.append("app=" + app) }
        for key in ["title", "msg"] {
            if let text = record[key] as? String, !text.isEmpty { pairs.append(key + "=" + Data(text.utf8).base64EncodedString()) }
        }
        return "\u{1b}]7501;" + pairs.joined(separator: ":") + "\u{1b}\\"
    }

    private static func isName(_ value: String) -> Bool {
        name.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }
}
