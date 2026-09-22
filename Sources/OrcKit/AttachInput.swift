import Foundation

public enum AttachExit: Equatable { case detached, picker }

/// Recognizes local shortcuts without forwarding them to an agent. CSI keys and
/// bracketed paste delimiters can span reads; pasted bytes are always literal.
struct AttachInput {
    private let sessionSwitching: Bool
    private var pending: [UInt8] = []
    private var pasting = false
    var hasPending: Bool { !pending.isEmpty }
    init(sessionSwitching: Bool = true) { self.sessionSwitching = sessionSwitching }

    mutating func append(_ data: Data) -> (bytes: Data, exit: AttachExit?) {
        pending.append(contentsOf: data)
        var output = Data(), index = 0
        let pasteEnd = Array("\u{1b}[201~".utf8)
        while index < pending.count {
            let byte = pending[index]
            if pasting {
                if pending[index...].starts(with: pasteEnd) {
                    output.append(contentsOf: pasteEnd); index += pasteEnd.count; pasting = false
                } else if pasteEnd.starts(with: pending[index...]) { break }
                else { output.append(byte); index += 1 }
                continue
            }
            if byte == 0x1d { pending.removeAll(); return (output, .detached) }
            guard byte == 0x1b else { output.append(byte); index += 1; continue }
            guard index + 1 < pending.count else { break }
            guard pending[index + 1] == 0x5b else { output.append(byte); index += 1; continue }
            var end = index + 2
            while end < pending.count, end - index < 128, (0x20...0x3f).contains(pending[end]) { end += 1 }
            if end == pending.count, end - index < 128 { break }
            guard end < pending.count, (0x40...0x7e).contains(pending[end]) else {
                output.append(byte); index += 1; continue
            }
            let body = String(decoding: pending[(index + 2)..<end], as: UTF8.self)
            let final = pending[end]
            if let key = shortcut(body, final: final) {
                if key.pressed { pending.removeAll(); return (output, key.exit) }
                // Key-up events belong to the intercepted shortcut, not the agent.
            } else {
                if body == "200", final == 0x7e { pasting = true }
                output.append(contentsOf: pending[index...end])
            }
            index = end + 1
        }
        pending.removeFirst(index)
        return (output, nil)
    }

    mutating func flushPending() -> Data {
        defer { pending.removeAll() }
        return Data(pending)
    }

    private func shortcut(_ body: String, final: UInt8) -> (exit: AttachExit, pressed: Bool)? {
        let fields = body.split(separator: ";", omittingEmptySubsequences: false)
        let code: Int?, mods: Int?, event: Int?
        if final == 0x75, (2...3).contains(fields.count) { // CSI u / Kitty
            code = fields[0].split(separator: ":", omittingEmptySubsequences: false).first.flatMap { Int($0) }
            let modifiers = fields[1].split(separator: ":", omittingEmptySubsequences: false)
            mods = modifiers.first.flatMap { Int($0) }
            event = modifiers.count == 1 ? 1 : Int(modifiers[1])
        } else if final == 0x7e, fields.count == 3, fields[0] == "27" { // xterm modifyOtherKeys
            code = Int(fields[2]); mods = Int(fields[1]); event = 1
        } else { return nil }
        // Caps Lock and Num Lock do not change a Control shortcut.
        guard let mods, mods > 0, (mods - 1) & ~192 == 4,
              let event, (1...3).contains(event) else { return nil }
        switch code {
        case 39 where sessionSwitching: return (.picker, event != 3)
        case 93: return (.detached, event != 3)
        default: return nil
        }
    }
}
