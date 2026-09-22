import Foundation
import Darwin
import OrcKit

/// A terminal chooser that returns a stable session handle before attachment
/// takes ownership of the terminal. No input is sent to a session while choosing.
@MainActor final class SessionPicker {
    private let sessions: [Session]
    private var query = ""
    private var selected = 0
    private var offset = 0
    private var input: [UInt8] = []
    private var decoder = InputDecoder()
    private var pasting = false
    private var original = termios()
    private var reader: DispatchSourceRead?
    private var signals: [DispatchSourceSignal] = []
    private var previousSignals: [(Int32, sig_t?)] = []
    private var escapeTimeout: Task<Void, Never>?
    private var continuation: CheckedContinuation<Session?, Error>?
    private var finished = false

    init(sessions: [Session]) {
        self.sessions = sessions.filter(\.connected).sorted {
            let order = $0.name.localizedStandardCompare($1.name)
            return order == .orderedSame ? $0.handle < $1.handle : order == .orderedAscending
        }
    }
    private var matches: [Session] {
        sessions.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query)
            || $0.worktreePath.localizedCaseInsensitiveContains(query) || $0.handle.localizedCaseInsensitiveContains(query) }
    }
    func run() async throws -> Session? {
        guard isatty(STDIN_FILENO) == 1, isatty(STDOUT_FILENO) == 1 else {
            throw OrcError("The session picker needs an interactive terminal. Run `orc list --json` to list sessions.")
        }
        guard !sessions.isEmpty else { throw OrcError("No running sessions. Create one with `orc new NAME`.") }
        guard tcgetattr(STDIN_FILENO, &original) == 0 else { throw OrcError("Cannot read terminal settings.") }
        var raw = original; cfmakeraw(&raw)
        guard tcsetattr(STDIN_FILENO, TCSANOW, &raw) == 0 else { throw OrcError("Cannot enter raw terminal mode.") }
        defer { restore() }
        try writeAll(STDOUT_FILENO, Data("\u{1b}[?1049h\u{1b}[?25l\u{1b}[?2004h".utf8))
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            installInput()
            render()
        }
    }
    private func installInput() {
        let reader = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        reader.setEventHandler { [weak self] in
            guard let self, !self.finished else { return }
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
            if count < 0, errno == EINTR { return }
            guard count > 0 else { self.finish(nil); return }
            self.escapeTimeout?.cancel()
            self.input.append(contentsOf: bytes.prefix(count))
            self.consumeInput()
            if !self.finished { self.render() }
            if self.input.first == 0x1b, !self.pasting {
                self.escapeTimeout = Task { [weak self] in
                    try? await Task.sleep(nanoseconds: 150_000_000)
                    guard !Task.isCancelled else { return }
                    self?.finish(nil)
                }
            }
        }
        reader.resume(); self.reader = reader
        for number in [SIGWINCH, SIGINT, SIGTERM, SIGHUP, SIGQUIT] {
            previousSignals.append((number, signal(number, SIG_IGN)))
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in
                if number == SIGWINCH { self?.render() } else { self?.finish(nil) }
            }
            source.resume(); signals.append(source)
        }
    }
    private func consumeInput() {
        let pasteEnd: [UInt8] = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]
        while !input.isEmpty, !finished {
            if pasting {
                if input.starts(with: pasteEnd) { input.removeFirst(pasteEnd.count); pasting = false; continue }
                if pasteEnd.starts(with: input) { break }
                let byte = input.removeFirst()
                if byte >= 0x20, byte != 0x7f { appendText(byte) }
                else if byte == 10 || byte == 13 { appendText(32) }
                continue
            }
            let byte = input[0]
            if byte == 0x1b {
                guard input.count > 1 else { break }
                guard input[1] == 0x5b || input[1] == 0x4f else { finish(nil); return }
                var end = 2
                while end < input.count, !(0x40...0x7e).contains(input[end]) { end += 1 }
                guard end < input.count else { break }
                let sequence = String(decoding: input[2...end], as: UTF8.self)
                input.removeFirst(end + 1)
                switch sequence {
                case "A": move(-1)
                case "B": move(1)
                case "5~": move(-pageSize)
                case "6~": move(pageSize)
                case "H", "1~": selected = 0
                case "F", "4~": selected = max(0, matches.count - 1)
                case "200~": pasting = true
                default: break
                }
                continue
            }
            input.removeFirst()
            switch byte {
            case 3, 4, 0x1d: finish(nil)
            case 10, 13:
                let list = matches
                if list.indices.contains(selected) { finish(list[selected]) }
            case 8, 0x7f:
                decoder = InputDecoder()
                if !query.isEmpty { query.removeLast(); selected = 0; offset = 0 }
            case 0x15: query = ""; decoder = InputDecoder(); selected = 0; offset = 0
            case 0x10: move(-1)
            case 0x0e, 9: move(1)
            case 0x20...0xff: appendText(byte)
            default: break
            }
        }
    }
    private func appendText(_ byte: UInt8) {
        let text = decoder.append(Data([byte]))
        guard query.utf8.count + text.utf8.count <= 512 else { return }
        query += String(text.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
        selected = 0; offset = 0
    }
    private func move(_ amount: Int) { selected = min(max(0, matches.count - 1), max(0, selected + amount)) }
    private var size: (cols: Int, rows: Int) {
        var size = winsize(); _ = ioctl(STDOUT_FILENO, TIOCGWINSZ, &size)
        return (max(1, Int(size.ws_col)), max(1, Int(size.ws_row)))
    }
    private var pageSize: Int { max(1, (size.rows - 7) / 2) }
    private func fit(_ text: String, width: Int) -> String {
        let clean = String(text.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
        // UTF-8 length bounds terminal cell width, including wide characters.
        // Leave a spare cell so autowrap cannot scroll the chooser.
        let limit = max(0, width - 1)
        if clean.utf8.count <= limit { return clean }
        var result = ""
        for character in clean {
            if result.utf8.count + String(character).utf8.count > max(0, limit - 3) { break }
            result.append(character)
        }
        return limit >= 3 ? result + "..." : ""
    }
    private func render() {
        guard !finished else { return }
        let (cols, rows) = size
        let list = matches
        selected = min(selected, max(0, list.count - 1))
        if selected < offset { offset = selected }
        if selected >= offset + pageSize { offset = selected - pageSize + 1 }
        var lines = ["\u{1b}[1;36m" + fit("Orc — Attach to a session", width: cols) + "\u{1b}[0m", "",
                     fit("Filter: " + (query.isEmpty ? "type to search…" : query), width: cols),
                     "\u{1b}[2m" + fit("↑/↓ Move · Enter Attach · Esc Cancel · Ctrl-U Clear", width: cols) + "\u{1b}[0m", ""]
        if list.isEmpty { lines.append(fit("No matching sessions.", width: cols)) }
        else {
            for index in offset..<min(list.count, offset + pageSize) {
                let session = list[index]
                let marker = index == selected ? "> " : "  "
                let title = fit(marker + session.name, width: cols)
                lines.append(index == selected ? "\u{1b}[1;7m" + title + "\u{1b}[0m" : title)
                lines.append("\u{1b}[2m" + fit("  " + session.worktreePath, width: cols) + "\u{1b}[0m")
            }
        }
        lines.append("")
        let status = list.indices.contains(selected) ? "\(selected + 1)/\(list.count) · \(list[selected].handle)" : "0/\(sessions.count) sessions"
        lines.append("\u{1b}[2m" + fit(status, width: cols) + "\u{1b}[0m")
        if rows < 8 { lines = [fit("Resize terminal to at least 8 rows. Esc cancels.", width: cols)] }
        do { try writeAll(STDOUT_FILENO, Data(("\u{1b}[?2026h\u{1b}[H\u{1b}[2J" + lines.joined(separator: "\r\n") + "\u{1b}[?2026l").utf8)) }
        catch { finished = true; continuation?.resume(throwing: error); continuation = nil }
    }
    private func finish(_ session: Session?) {
        guard !finished else { return }; finished = true
        continuation?.resume(returning: session); continuation = nil
    }
    private func restore() {
        escapeTimeout?.cancel(); reader?.cancel(); reader = nil
        signals.forEach { $0.cancel() }; signals.removeAll()
        previousSignals.forEach { _ = signal($0.0, $0.1) }; previousSignals.removeAll()
        try? writeAll(STDOUT_FILENO, Data("\u{1b}[?2026l\u{1b}[?2004l\u{1b}[0m\u{1b}[?25h\u{1b}[?1049l".utf8))
        _ = tcsetattr(STDIN_FILENO, TCSANOW, &original)
    }
}
