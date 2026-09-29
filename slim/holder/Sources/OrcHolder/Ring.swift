/// PTY output retained for replay, addressed by absolute byte offset since the session started.
/// Resizes are recorded at the output offset where they took effect; replaying a resize that a
/// consumer already applied is harmless because resizing to the current size changes nothing.
struct Ring {
    enum Entry {
        case output(offset: UInt64, bytes: [UInt8])
        case resize(offset: UInt64, cols: UInt16, rows: UInt16)
    }

    let limit: Int
    private var entries: [Entry] = []
    private var first = 0
    /// Offset of the oldest retained byte. Bytes before it were trimmed or dropped for space.
    private(set) var baseOffset: UInt64 = 0
    /// Offset of the next byte the PTY produces.
    private(set) var headOffset: UInt64 = 0
    private(set) var retainedBytes = 0

    init(limit: Int) { self.limit = limit }

    mutating func append(_ bytes: [UInt8]) {
        entries.append(.output(offset: headOffset, bytes: bytes))
        headOffset += UInt64(bytes.count)
        retainedBytes += bytes.count
        while retainedBytes > limit, first < entries.count { dropFirst() }
        compact()
    }

    mutating func recordResize(cols: UInt16, rows: UInt16) {
        entries.append(.resize(offset: headOffset, cols: cols, rows: rows))
    }

    /// Discards output before `offset`, which a consumer has saved elsewhere.
    mutating func trim(to offset: UInt64) {
        let target = min(offset, headOffset)
        while first < entries.count {
            switch entries[first] {
            case let .output(start, bytes):
                let end = start + UInt64(bytes.count)
                if end <= target {
                    dropFirst()
                } else {
                    if start < target {
                        let skipped = Int(target - start)
                        entries[first] = .output(offset: target, bytes: Array(bytes[skipped...]))
                        retainedBytes -= skipped
                    }
                    baseOffset = max(baseOffset, target)
                    compact()
                    return
                }
            case let .resize(at, _, _):
                if at < target { dropFirst() } else {
                    baseOffset = max(baseOffset, target)
                    compact()
                    return
                }
            }
        }
        baseOffset = max(baseOffset, target)
        compact()
    }

    /// Output at or after `offset` and the resizes recorded at or after it, in order.
    func entries(from offset: UInt64) -> [Entry] {
        var result: [Entry] = []
        for entry in entries[first...] {
            switch entry {
            case let .output(start, bytes):
                let end = start + UInt64(bytes.count)
                guard end > offset else { continue }
                result.append(start >= offset ? entry : .output(offset: offset, bytes: Array(bytes[Int(offset - start)...])))
            case let .resize(at, _, _):
                if at >= offset { result.append(entry) }
            }
        }
        return result
    }

    private mutating func dropFirst() {
        switch entries[first] {
        case let .output(start, bytes):
            retainedBytes -= bytes.count
            baseOffset = max(baseOffset, start + UInt64(bytes.count))
        case .resize:
            break
        }
        first += 1
    }

    private mutating func compact() {
        if first > 1024, first * 2 > entries.count {
            entries.removeFirst(first)
            first = 0
        }
    }
}
