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
    private let sessionSwitching: Bool
    private let clientID = "orc-" + UUID().uuidString
    private var connection: StreamConnection?
    private var streamID: UInt32?
    private var snapshot = Data()
    private var collectingSnapshot = false
    private var snapshotUnavailable = false
    private var snapshotKeyboardFlags: Int?
    private var requestedScrollback = false
    private var scrollbackSnapshotPending = false
    private var replayingScrollbackSnapshot = false
    private var activeKeyboardFlags: Int?
    private var savedTermios = termios()
    private var raw = false
    private var stopping = false
    private var ended = false
    private var inputSource: DispatchSourceRead?
    private var signalSources: [DispatchSourceSignal] = []
    private var previousSignals: [(Int32, sig_t?)] = []
    private var decoder = InputDecoder()
    private var shortcuts: AttachInput
    private var inputDeadline: Task<Void, Never>?
    private var exitReason: AttachExit = .detached
    private var inputQueue: [String] = []
    private var inputBytes = 0
    private var drainingInput = false
    private var failure: Error?
    private var disconnect: CheckedContinuation<Void, Never>?
    private var connectedOnce = false
    private var ready = false
    private var snapshotDeadline: Task<Void, Never>?
    private var retryDelay: Task<Void, Never>?

    public init(terminal: Session, readOnly: Bool = false, reconnect: Bool = true, sessionSwitching: Bool = true) {
        self.terminal = terminal; self.readOnly = readOnly; self.reconnect = reconnect
        self.sessionSwitching = sessionSwitching; self.shortcuts = AttachInput(sessionSwitching: sessionSwitching)
    }
    public func run() async throws -> AttachExit {
        guard isatty(STDIN_FILENO) == 1, isatty(STDOUT_FILENO) == 1 else { throw OrcError("Attach needs an interactive terminal. Run it in Ghostty, or use `orc list --json`.") }
        let pairing = try Pairing.load()
        guard tcgetattr(STDIN_FILENO, &savedTermios) == 0 else { throw OrcError("Cannot read terminal settings.") }
        var settings = savedTermios
        cfmakeraw(&settings)
        guard tcsetattr(STDIN_FILENO, TCSANOW, &settings) == 0 else { throw OrcError("Cannot enter raw terminal mode.") }
        raw = true
        defer { restore() }
        // The remote application owns screen selection. An outer alternate
        // screen disables scrollback and makes Ghostty send arrow keys on scroll.
        output("\u{1b}[?1049l\u{1b}[2J\u{1b}[H")
        note("Attaching to \(terminal.name). " + (sessionSwitching ? "Ctrl-' switches sessions; " : "") + "Ctrl-] detaches. Sessions stay running.")
        installInput()
        var attempts = 0
        while !stopping && !ended {
            failure = nil; streamID = nil; ready = false; snapshot.removeAll(); collectingSnapshot = false
            requestedScrollback = false; scrollbackSnapshotPending = false
            replayingScrollbackSnapshot = false; activeKeyboardFlags = nil
            snapshotUnavailable = false; snapshotKeyboardFlags = nil
            do {
                let conn = try StreamConnection(pairing: pairing)
                connection = conn
                conn.onBinary = { [weak self] in self?.receive($0) }
                conn.onEvent = { [weak self] in self?.event($0) }
                conn.onClose = { [weak self] error in self?.disconnected(error) }
                try await conn.connect()
                let status = try await conn.request("status.get")
                let capabilities = status["capabilities"] as? [String] ?? (status["runtime"] as? [String: Any])?["capabilities"] as? [String] ?? []
                guard capabilities.contains("terminal.binary-stream.v1"), capabilities.contains("terminal.multiplex.v1") else {
                    throw OrcError("Orca does not advertise terminal streaming with scrollback support.")
                }
                // Reconnecting to a replaced process must require another explicit attach.
                let current = try await SessionService().list()
                guard let live = current.terminals.first(where: { $0.handle == terminal.handle }), live.connected,
                      terminal.incarnationId == nil || terminal.incarnationId == live.incarnationId else {
                    ended = true; throw OrcError("The original terminal exited or was replaced. Run `orc list` to choose a session.")
                }
                try await conn.subscribe("terminal.multiplex", [:])
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
        if ended, !stopping { note("Session ended."); return .ended }
        return exitReason
    }
    private var viewport: [String: Int] {
        var size = winsize(); _ = ioctl(STDOUT_FILENO, TIOCGWINSZ, &size)
        return ["cols": min(1000, max(1, Int(size.ws_col))), "rows": min(500, max(1, Int(size.ws_row)))]
    }
    private func installInput() {
        let source = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        source.setEventHandler { [weak self] in
            guard let self, !self.stopping else { return }
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
            guard count > 0 else { self.stop(); return }
            self.inputDeadline?.cancel()
            let input = self.shortcuts.append(Data(bytes.prefix(count)))
            if let exit = input.exit { self.stop(exit); return }
            self.forwardInput(input.bytes)
            if self.shortcuts.hasPending {
                // A lone Escape must still reach applications that use it to cancel.
                self.inputDeadline = Task { [weak self] in
                    try? await Task.sleep(nanoseconds: 150_000_000)
                    guard !Task.isCancelled, let self, !self.stopping else { return }
                    self.forwardInput(self.shortcuts.flushPending())
                }
            }
        }
        source.resume(); inputSource = source
        for number in [SIGWINCH, SIGTERM, SIGHUP, SIGINT, SIGQUIT] {
            previousSignals.append((number, signal(number, SIG_IGN)))
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in
                guard let self else { return }
                if number == SIGWINCH { Task { await self.resize() } }
                else { self.stop() }
            }
            source.resume(); signalSources.append(source)
        }
    }
    private func forwardInput(_ data: Data) {
        guard !readOnly, ready, !stopping else { return }
        let text = decoder.append(data)
        guard !text.isEmpty else { return }
        guard inputBytes + text.utf8.count <= 256 * 1024 else { note("Input buffer full; detached to avoid losing input silently."); stop(); return }
        inputQueue.append(text); inputBytes += text.utf8.count
        Task { await self.drainInput() }
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
            } catch {
                guard !stopping else { return }
                note("Input delivery uncertain; it was not retried. \(error.localizedDescription)"); disconnected(error); return
            }
        }
    }
    private func resize() async {
        guard !readOnly, let connection, let streamID else { return }
        // Resize alone records viewer dimensions. ClaimViewport applies them to the PTY.
        do { try await connection.send(TerminalFrame(opcode: 14, streamID: streamID, payload: jsonData(viewport))) }
        catch { disconnected(error) }
    }
    private func event(_ value: [String: Any]) {
        guard !stopping else { return }
        let event = value["event"] as? [String: Any] ?? value
        switch event["type"] as? String {
        case "ready":
            guard streamID == nil, let connection else { return }
            streamID = 1
            Task {
                do {
                    try await connection.send(TerminalFrame(opcode: 9, streamID: 0, payload: jsonData([
                        "streamId": 1, "terminal": terminal.handle,
                        "client": ["id": clientID, "type": "desktop"], "viewport": viewport,
                        "capabilities": ["desktopViewportClaims": 1, "writeUnavailable": 1]])))
                } catch {
                    if self.connection === connection { disconnected(error); connection.close() }
                }
            }
        case "subscribed":
            if let id = event["streamId"] as? NSNumber { streamID = id.uint32Value }
        case "end": ended = true; disconnected(nil)
        default: break
        }
    }
    private func receive(_ data: Data) {
        guard !stopping else { return }
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
                replayingScrollbackSnapshot = scrollbackSnapshotPending
                scrollbackSnapshotPending = false
                let metadata = try jsonObject(frame.payload)
                snapshotUnavailable = metadata["unavailable"] != nil
                snapshotKeyboardFlags = (metadata["kittyKeyboardFlags"] as? Int).flatMap {
                    (0...31).contains($0) ? $0 : nil
                }
            case 3:
                guard collectingSnapshot, snapshot.count + frame.payload.count <= 8 * 1024 * 1024 else { throw OrcError("Invalid or oversized terminal snapshot.") }
                snapshot += frame.payload
            case 4:
                guard collectingSnapshot else { throw OrcError("Unexpected snapshot end.") }
                if snapshotUnavailable {
                    snapshot.removeAll(); collectingSnapshot = false
                    note("Orca could not provide retained scrollback; keeping the live screen.")
                    return
                }
                // A fresh snapshot may follow an alternate-screen application
                // that exited during a disconnect. Its replay selects the screen.
                output("\u{1b}[?2026h\u{1b}[?1049l\u{1b}[0m\u{1b}[2J\u{1b}[H")
                try writeAll(STDOUT_FILENO, snapshot)
                // Scrollback replay is historical: its keyboard metadata can
                // be zero even while the live agent is still in Kitty mode.
                // Keep the current mode rather than letting history turn
                // Shift+Enter into plain Enter in a nested terminal.
                if !replayingScrollbackSnapshot || activeKeyboardFlags == nil {
                    activeKeyboardFlags = snapshotKeyboardFlags
                }
                if let flags = activeKeyboardFlags { output("\u{1b}[=\(flags)u") }
                output("\u{1b}[?2026l")
                snapshot.removeAll(); collectingSnapshot = false; ready = true
                snapshotDeadline?.cancel(); snapshotDeadline = nil
                Task { await resize() }
                if !requestedScrollback, let connection, let streamID {
                    requestedScrollback = true
                    scrollbackSnapshotPending = true
                    // Desktop subscriptions initially contain only the viewport.
                    // An untagged request replaces it with history and lets Orca
                    // discard buffered live output already covered by the snapshot.
                    Task {
                        do { try await connection.send(TerminalFrame(opcode: 11, streamID: streamID,
                            payload: jsonData(["scrollbackRows": 5000]))) }
                        catch { if self.connection === connection { disconnected(error); connection.close() } }
                    }
                }
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
    private func stop(_ reason: AttachExit = .detached) {
        guard !stopping else { return }
        exitReason = reason; stopping = true
        inputQueue.removeAll(); inputBytes = 0
        inputDeadline?.cancel(); retryDelay?.cancel(); connection?.close(); disconnected(nil)
    }
    private func output(_ text: String) { try? writeAll(STDOUT_FILENO, Data(text.utf8)) }
    private func note(_ text: String) { try? writeAll(STDERR_FILENO, Data(("\r\n[orc] " + text + "\r\n").utf8)) }
    private func restore() {
        stopping = true
        inputDeadline?.cancel(); snapshotDeadline?.cancel(); retryDelay?.cancel()
        inputSource?.cancel(); inputSource = nil
        signalSources.forEach { $0.cancel() }; signalSources.removeAll()
        previousSignals.forEach { _ = signal($0.0, $0.1) }; previousSignals.removeAll()
        connection?.close(); connection = nil
        // Keyboard modes are per screen; neither the picker nor the shell
        // should inherit the attached application's extended key encoding.
        output("\u{1b}[?2026l\u{1b}[<u\u{1b}[=0u\u{1b}[?2004l\u{1b}[?1000l\u{1b}[?1002l\u{1b}[?1003l\u{1b}[?1006l\u{1b}[?1004l\u{1b}[0m\u{1b}[?25h\u{1b}[?1049l\u{1b}[=0u\u{1b}[r\u{1b}[?6l\u{1b}[999;1H\r\n")
        if raw { _ = tcsetattr(STDIN_FILENO, TCSANOW, &savedTermios); raw = false }
    }
}
