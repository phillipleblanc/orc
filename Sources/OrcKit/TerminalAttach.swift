import Foundation
import Darwin

/// A UTF-8 decoder which retains a code point split across reads.
public struct InputDecoder {
    private var pending = Data()
    public init() {}
    public mutating func append(_ data: Data) -> String {
        pending += data
        for suffix in 0...min(3, pending.count) {
            let prefix = pending.prefix(pending.count - suffix)
            if let text = String(data: prefix, encoding: .utf8) {
                pending.removeFirst(prefix.count)
                return text
            }
        }
        let text = String(decoding: pending, as: UTF8.self); pending.removeAll(); return text
    }
}

@MainActor public final class TerminalAttach {
    private let terminal: Session
    private let readOnly: Bool
    private let reconnect: Bool
    private let clientID = "orc-" + UUID().uuidString
    private var connection: StreamConnection?
    private var streamID: UInt32?
    private var snapshot = Data()
    private var collectingSnapshot = false
    private var savedTermios = termios()
    private var raw = false
    private var stopping = false
    private var ended = false
    private var inputSource: DispatchSourceRead?
    private var signalSources: [DispatchSourceSignal] = []
    private var decoder = InputDecoder()
    private var inputQueue: [String] = []
    private var inputBytes = 0
    private var drainingInput = false
    private var failure: Error?
    private var disconnect: CheckedContinuation<Void, Never>?
    private var connectedOnce = false
    private var ready = false
    private var snapshotDeadline: Task<Void, Never>?
    private var retryDelay: Task<Void, Never>?

    public init(terminal: Session, readOnly: Bool = false, reconnect: Bool = true) {
        self.terminal = terminal; self.readOnly = readOnly; self.reconnect = reconnect
    }
    public func run() async throws {
        guard isatty(STDIN_FILENO) == 1, isatty(STDOUT_FILENO) == 1 else { throw OrcError("Attach needs an interactive terminal. Run it in Ghostty, or use `orc list --json`.") }
        let pairing = try Pairing.load()
        guard tcgetattr(STDIN_FILENO, &savedTermios) == 0 else { throw OrcError("Cannot read terminal settings.") }
        var settings = savedTermios
        cfmakeraw(&settings)
        guard tcsetattr(STDIN_FILENO, TCSANOW, &settings) == 0 else { throw OrcError("Cannot enter raw terminal mode.") }
        raw = true
        defer { restore() }
        output("\u{1b}[?1049h\u{1b}[2J\u{1b}[H")
        note("Attaching to \(terminal.name). Ctrl-] detaches; the session stays running.")
        installInput()
        var attempts = 0
        while !stopping && !ended {
            failure = nil; streamID = nil; ready = false; snapshot.removeAll(); collectingSnapshot = false
            do {
                let conn = try StreamConnection(pairing: pairing)
                connection = conn
                conn.onBinary = { [weak self] in self?.receive($0) }
                conn.onEvent = { [weak self] in self?.event($0) }
                conn.onClose = { [weak self] error in self?.disconnected(error) }
                try await conn.connect()
                let status = try await conn.request("status.get")
                let capabilities = status["capabilities"] as? [String] ?? (status["runtime"] as? [String: Any])?["capabilities"] as? [String] ?? []
                guard capabilities.contains("terminal.binary-stream.v1") else { throw OrcError("Orca does not advertise binary terminal streaming.") }
                // Reconnecting to a replaced process must require another explicit attach.
                let current = try await SessionService().list()
                guard let live = current.terminals.first(where: { $0.handle == terminal.handle }), live.connected,
                      terminal.incarnationId == nil || terminal.incarnationId == live.incarnationId else {
                    ended = true; throw OrcError("The original terminal exited or was replaced. Run `orc list` to choose a session.")
                }
                try await conn.subscribe("terminal.subscribe", ["terminal": terminal.handle,
                    "client": ["id": clientID, "type": "desktop"], "viewport": viewport,
                    "capabilities": ["terminalBinaryStream": 1, "desktopViewportClaims": 1, "writeUnavailable": 1]])
                snapshotDeadline = Task { [weak self, weak conn] in
                    try? await Task.sleep(nanoseconds: 15_000_000_000)
                    guard !Task.isCancelled, let self, !self.ready else { return }
                    self.disconnected(OrcError("Orca did not send a terminal snapshot.")); conn?.close()
                }
                connectedOnce = true
                await withCheckedContinuation { continuation in
                    if stopping || ended || failure != nil { continuation.resume() }
                    else { disconnect = continuation }
                }
                conn.close()
            } catch { failure = error; connection?.close() }
            snapshotDeadline?.cancel(); snapshotDeadline = nil
            if stopping || ended { break }
            guard reconnect && connectedOnce && attempts < 5 else { throw failure ?? OrcError("Orca disconnected.") }
            attempts += 1
            inputQueue.removeAll(); inputBytes = 0
            note("Connection lost. Reconnecting (\(attempts)/5); input is paused.")
            retryDelay = Task { try? await Task.sleep(nanoseconds: UInt64(min(8, attempts * 2)) * 1_000_000_000) }
            await retryDelay?.value; retryDelay = nil
        }
        if ended { note("Session ended.") }
    }
    private var viewport: [String: Int] {
        var size = winsize(); _ = ioctl(STDOUT_FILENO, TIOCGWINSZ, &size)
        return ["cols": min(1000, max(1, Int(size.ws_col))), "rows": min(500, max(1, Int(size.ws_row)))]
    }
    private func installInput() {
        let source = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
            guard count > 0 else { self.stop(); return }
            let data = Data(bytes.prefix(count))
            if data.contains(0x1d) { self.stop(); return }
            guard !self.readOnly, self.ready else { return }
            let text = self.decoder.append(data)
            if !text.isEmpty {
                guard self.inputBytes + text.utf8.count <= 256 * 1024 else { self.note("Input buffer full; detached to avoid losing input silently."); self.stop(); return }
                self.inputQueue.append(text); self.inputBytes += text.utf8.count
                Task { await self.drainInput() }
            }
        }
        source.resume(); inputSource = source
        for number in [SIGWINCH, SIGTERM, SIGHUP, SIGINT, SIGQUIT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in
                guard let self else { return }
                if number == SIGWINCH { Task { await self.resize() } }
                else { self.stop() }
            }
            source.resume(); signalSources.append(source)
        }
    }
    private func drainInput() async {
        guard !drainingInput else { return }; drainingInput = true
        defer { drainingInput = false }
        while !inputQueue.isEmpty, ready, !stopping, let connection {
            let text = inputQueue.removeFirst(); inputBytes -= text.utf8.count
            do {
                let result = try await connection.request("terminal.send", ["terminal": terminal.handle,
                    "text": text, "enter": false, "client": ["id": clientID, "type": "desktop"],
                    "viewport": viewport, "claimViewport": true])
                let send = result["send"] as? [String: Any] ?? result
                if send["accepted"] as? Bool == false { note("Input not accepted: another client may control this session. Close the phone’s live terminal, then retry.") }
            } catch { note("Input delivery uncertain; it was not retried. \(error.localizedDescription)"); disconnected(error); return }
        }
    }
    private func resize() async {
        guard !readOnly, let connection, let streamID else { return }
        // Resize alone records viewer dimensions. ClaimViewport applies them to the PTY.
        do { try await connection.send(TerminalFrame(opcode: 14, streamID: streamID, payload: jsonData(viewport))) }
        catch { disconnected(error) }
    }
    private func event(_ value: [String: Any]) {
        let event = value["event"] as? [String: Any] ?? value
        switch event["type"] as? String {
        case "subscribed":
            if let id = event["streamId"] as? NSNumber { streamID = id.uint32Value }
        case "end": ended = true; disconnected(nil)
        default: break
        }
    }
    private func receive(_ data: Data) {
        do {
            let frame = try TerminalFrame(data: data)
            if let streamID, frame.streamID != streamID { throw OrcError("Mismatched terminal stream.") }
            streamID = frame.streamID
            switch frame.opcode {
            case 1: try writeAll(STDOUT_FILENO, frame.payload)
            case 15:
                guard let text = try jsonObject(frame.payload)["data"] as? String else { throw OrcError("Invalid terminal output span.") }
                try writeAll(STDOUT_FILENO, Data(text.utf8))
            case 2:
                collectingSnapshot = true; snapshot.removeAll()
            case 3:
                guard collectingSnapshot, snapshot.count + frame.payload.count <= 8 * 1024 * 1024 else { throw OrcError("Invalid or oversized terminal snapshot.") }
                snapshot += frame.payload
            case 4:
                guard collectingSnapshot else { throw OrcError("Unexpected snapshot end.") }
                output("\u{1b}[?2026h\u{1b}[0m\u{1b}[2J\u{1b}[H")
                try writeAll(STDOUT_FILENO, snapshot)
                output("\u{1b}[?2026l")
                snapshot.removeAll(); collectingSnapshot = false; ready = true
                snapshotDeadline?.cancel(); snapshotDeadline = nil
                Task { await resize() }
            case 5, 12: break
            case 6: throw OrcError("Orca reported a terminal stream error.")
            case 17: note("Orca refused terminal input.")
            default: throw OrcError("Unsupported terminal opcode \(frame.opcode); detach and update Orc.")
            }
        } catch { disconnected(error); connection?.close() }
    }
    private func disconnected(_ error: Error?) {
        failure = error; ready = false
        disconnect?.resume(); disconnect = nil
    }
    private func stop() { stopping = true; retryDelay?.cancel(); connection?.close(); disconnected(nil) }
    private func output(_ text: String) { try? writeAll(STDOUT_FILENO, Data(text.utf8)) }
    private func note(_ text: String) { try? writeAll(STDERR_FILENO, Data(("\r\n[orc] " + text + "\r\n").utf8)) }
    private func restore() {
        snapshotDeadline?.cancel(); retryDelay?.cancel()
        inputSource?.cancel(); inputSource = nil
        signalSources.forEach { $0.cancel() }; signalSources.removeAll()
        connection?.close(); connection = nil
        output("\u{1b}[?2026l\u{1b}[<u\u{1b}[?2004l\u{1b}[?1000l\u{1b}[?1002l\u{1b}[?1003l\u{1b}[?1006l\u{1b}[?1004l\u{1b}[0m\u{1b}[?25h\u{1b}[?1049l")
        if raw { _ = tcsetattr(STDIN_FILENO, TCSANOW, &savedTermios); raw = false }
    }
}
