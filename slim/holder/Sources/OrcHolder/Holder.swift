import CHolder
import Darwin
import Foundation

let holderProtocol = 1
let holderVersion = "0.1.0"

private let lingerTimer: UInt = 1
private let forceKillTimer: UInt = 2
private let clientOutputLimit = 32 << 20
private let inputLimit = 4 << 20

final class Client {
    let fd: Int32
    var input: [UInt8] = []
    var inputStart = 0
    var output: [UInt8] = []
    var outputStart = 0
    var attached = false
    var writeArmed = false

    init(fd: Int32) { self.fd = fd }
    var pendingOutput: Int { output.count - outputStart }
}

struct HolderOptions {
    var directory: String
    var argv: [String]
    var cwd: String?
    var cols: UInt16
    var rows: UInt16
    var ringLimit: Int
    var lingerSeconds: Int
}

/// Owns one PTY and its child process for the life of the session. Everything that interprets
/// terminal output lives in clients; the holder only retains bytes and forwards them.
final class Holder {
    let options: HolderOptions
    let socketPath: String
    let childPid: pid_t
    let startedAt = Date()
    private var master: Int32
    private var masterOpen = true
    private var masterWriteArmed = false
    private var pendingInput: [UInt8] = []
    private var pendingInputStart = 0
    /// The session directory can be renamed while the holder runs; records are written relative to it.
    private let directoryFD: Int32
    private var kq: Int32 = -1
    private var listener: Int32 = -1
    private var clients: [Int32: Client] = [:]
    private var ring: Ring
    private var cols: UInt16
    private var rows: UInt16
    private var exitCode: Int32?
    private var exitSignal: Int32?
    private var exited = false
    private var closing = false

    init(options: HolderOptions) throws {
        self.options = options
        socketPath = options.directory + "/sock"
        guard socketPath.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) else {
            throw HolderError("socket path is too long: \(socketPath)")
        }
        directoryFD = open(options.directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard directoryFD >= 0 else { throw HolderError("cannot open \(options.directory): \(String(cString: strerror(errno)))") }
        ring = Ring(limit: options.ringLimit)
        cols = options.cols
        rows = options.rows
        // Spawn before creating any other descriptor so the child inherits only its terminal.
        var cArgs = options.argv.map { strdup($0) } + [nil]
        defer { cArgs.forEach { free($0) } }
        var master: Int32 = -1
        var error: Int32 = 0
        let pid = holder_spawn(&cArgs, environ, options.cwd, options.cols, options.rows, &master, &error)
        guard pid > 0 else { throw HolderError("cannot start \(options.argv[0]): \(String(cString: strerror(error)))") }
        childPid = pid
        self.master = master
    }

    func run() throws -> Never {
        kq = kqueue()
        guard kq >= 0 else { throw HolderError("kqueue: \(String(cString: strerror(errno)))") }
        _ = fcntl(kq, F_SETFD, FD_CLOEXEC)
        try listen()
        watch(UInt(master), EVFILT_READ, EV_ADD)
        watch(UInt(childPid), EVFILT_PROC, EV_ADD | EV_ONESHOT, fflags: UInt32(truncatingIfNeeded: NOTE_EXIT))
        var earlyStatus: Int32 = 0
        if waitpid(childPid, &earlyStatus, WNOHANG) == childPid { childExited(status: earlyStatus) }
        for signalNumber in [SIGTERM, SIGINT] {
            signal(signalNumber, SIG_IGN)
            watch(UInt(signalNumber), EVFILT_SIGNAL, EV_ADD)
        }
        writeRecord("holder.json", [
            "protocol": holderProtocol, "holderVersion": holderVersion, "pid": Int(getpid()),
            "childPid": Int(childPid), "startedAt": ISO8601DateFormatter().string(from: startedAt),
        ])
        var events = [holder_event](repeating: holder_event(), count: 64)
        while true {
            let count = holder_wait(kq, &events, Int32(events.count))
            if count < 0 {
                if errno == EINTR { continue }
                throw HolderError("kevent: \(String(cString: strerror(errno)))")
            }
            for event in events[0..<Int(count)] { handle(event) }
        }
    }

    // MARK: Events

    private func handle(_ event: holder_event) {
        let ident = event.ident
        switch Int32(event.filter) {
        case EVFILT_READ where ident == UInt(listener): acceptClients()
        case EVFILT_READ where masterOpen && ident == UInt(master): readMaster()
        case EVFILT_READ: if let client = clients[Int32(ident)] { readClient(client) }
        case EVFILT_WRITE where masterOpen && ident == UInt(master): flushInput()
        case EVFILT_WRITE: if let client = clients[Int32(ident)] { flush(client) }
        case EVFILT_PROC where !exited:
            var status: Int32 = 0
            while waitpid(childPid, &status, 0) < 0 && errno == EINTR {}
            childExited(status: status)
        case EVFILT_TIMER where ident == lingerTimer: shutdown()
        case EVFILT_TIMER where ident == forceKillTimer: kill(-childPid, SIGKILL)
        case EVFILT_SIGNAL: close(signalNumber: SIGHUP)
        default: break
        }
    }

    private func readMaster() {
        var buffer = [UInt8](repeating: 0, count: 65536)
        while masterOpen {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(master, $0.baseAddress, $0.count) }
            if count > 0 {
                let bytes = Array(buffer[0..<count])
                let offset = ring.headOffset
                ring.append(bytes)
                broadcast(Frame.output(offset: offset, bytes: bytes))
            } else if count < 0 && errno == EINTR {
                continue
            } else if count < 0 && errno == EAGAIN {
                return
            } else {
                // EOF or EIO: every process holding the terminal has closed it.
                masterOpen = false
                Darwin.close(master)
            }
        }
    }

    private func childExited(status: Int32) {
        exited = true
        let low = status & 0x7f
        if low == 0 { exitCode = (status >> 8) & 0xff } else { exitSignal = low }
        if masterOpen { readMaster() }
        var record: [String: Any] = ["exitedAt": ISO8601DateFormatter().string(from: Date()), "headOffset": ring.headOffset]
        if let exitCode { record["exitCode"] = Int(exitCode) }
        if let exitSignal { record["exitSignal"] = Int(exitSignal) }
        writeRecord("exit.json", record)
        broadcast(Frame.json(exitEvent()))
        if closing { shutdown() }
        watch(lingerTimer, EVFILT_TIMER, EV_ADD | EV_ONESHOT, fflags: UInt32(truncatingIfNeeded: NOTE_SECONDS), data: options.lingerSeconds)
    }

    // MARK: Clients

    private func listen() throws {
        if FileManager.default.fileExists(atPath: socketPath) {
            if canConnect(socketPath) { throw HolderError("another holder is serving \(socketPath)") }
            unlink(socketPath)
        }
        listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw HolderError("socket: \(String(cString: strerror(errno)))") }
        _ = fcntl(listener, F_SETFD, FD_CLOEXEC)
        _ = fcntl(listener, F_SETFL, O_NONBLOCK)
        var address = unixAddress(socketPath)
        let previousMask = umask(0o077)
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        umask(previousMask)
        guard bound == 0, Darwin.listen(listener, 16) == 0 else {
            throw HolderError("cannot listen on \(socketPath): \(String(cString: strerror(errno)))")
        }
        watch(UInt(listener), EVFILT_READ, EV_ADD)
    }

    private func acceptClients() {
        while true {
            let fd = accept(listener, nil, nil)
            if fd < 0 { return }
            var uid: uid_t = 0
            var gid: gid_t = 0
            guard getpeereid(fd, &uid, &gid) == 0, uid == getuid() else {
                Darwin.close(fd)
                continue
            }
            _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
            _ = fcntl(fd, F_SETFL, O_NONBLOCK)
            var one: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            clients[fd] = Client(fd: fd)
            watch(UInt(fd), EVFILT_READ, EV_ADD)
        }
    }

    private func readClient(_ client: Client) {
        var buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let count = buffer.withUnsafeMutableBytes { Darwin.read(client.fd, $0.baseAddress, $0.count) }
            if count > 0 {
                client.input.append(contentsOf: buffer[0..<count])
            } else if count < 0 && errno == EINTR {
                continue
            } else if count < 0 && errno == EAGAIN {
                break
            } else {
                disconnect(client)
                return
            }
        }
        while client.input.count - client.inputStart >= 5 {
            let length = Int(Frame.readUInt32(client.input, at: client.inputStart))
            guard length >= 1, length <= Frame.maximumLength else { disconnect(client); return }
            guard client.input.count - client.inputStart >= 4 + length else { break }
            let type = client.input[client.inputStart + 4]
            let payload = Array(client.input[(client.inputStart + 5)..<(client.inputStart + 4 + length)])
            client.inputStart += 4 + length
            handleFrame(type, payload, from: client)
            if clients[client.fd] == nil { return }
        }
        if client.inputStart > 0 {
            client.input.removeFirst(client.inputStart)
            client.inputStart = 0
        }
    }

    private func handleFrame(_ type: UInt8, _ payload: [UInt8], from client: Client) {
        switch type {
        case Frame.input:
            write(input: payload, from: client)
        case Frame.request:
            guard let object = try? JSONSerialization.jsonObject(with: Data(payload)) as? [String: Any],
                  let op = object["op"] as? String else {
                send(Frame.json(["ok": false, "error": "malformed request"]), to: client)
                return
            }
            let id = object["id"] ?? NSNull()
            do {
                var reply = try perform(op, object, for: client)
                reply["id"] = id
                reply["ok"] = true
                send(Frame.json(reply), to: client)
                if op == "attach" { replay(from: reply["from"] as? UInt64 ?? 0, to: client) }
                if op == "close", exited { shutdown() }
            } catch {
                send(Frame.json(["id": id, "ok": false, "error": "\(error)"]), to: client)
            }
        default:
            send(Frame.json(["ok": false, "error": "unknown frame type \(type)"]), to: client)
        }
    }

    private func perform(_ op: String, _ request: [String: Any], for client: Client) throws -> [String: Any] {
        switch op {
        case "hello":
            guard (request["protocol"] as? Int) == holderProtocol else {
                throw HolderError("holder speaks protocol \(holderProtocol)")
            }
            return info().merging(["capabilities": ["attach", "input", "resize", "signal", "trim", "close"]]) { $1 }
        case "info":
            return info()
        case "attach":
            let requested = (request["from"] as? NSNumber)?.uint64Value ?? ring.baseOffset
            let from = max(requested, ring.baseOffset)
            client.attached = true
            return info().merging(["from": from, "gap": requested < ring.baseOffset]) { $1 }
        case "detach":
            client.attached = false
            return [:]
        case "resize":
            guard let newCols = request["cols"] as? Int, let newRows = request["rows"] as? Int,
                  (1...1000).contains(newCols), (1...500).contains(newRows) else { throw HolderError("invalid size") }
            if (UInt16(newCols), UInt16(newRows)) != (cols, rows) {
                cols = UInt16(newCols)
                rows = UInt16(newRows)
                if masterOpen { _ = holder_resize(master, cols, rows) }
                let offset = ring.headOffset
                ring.recordResize(cols: cols, rows: rows)
                broadcast(Frame.resize(offset: offset, cols: cols, rows: rows))
            }
            return ["cols": Int(cols), "rows": Int(rows)]
        case "signal":
            guard let name = request["signal"] as? String, let number = signalNumbers[name] else {
                throw HolderError("unknown signal")
            }
            let target: pid_t
            if request["target"] as? String == "child" { target = childPid } else {
                let group = masterOpen ? holder_foreground_group(master) : -1
                target = group > 0 ? -group : -childPid
            }
            guard !exited, kill(target, number) == 0 else { throw HolderError("cannot signal: \(String(cString: strerror(errno)))") }
            return [:]
        case "trim":
            guard let offset = (request["offset"] as? NSNumber)?.uint64Value else { throw HolderError("offset is required") }
            ring.trim(to: offset)
            return ["baseOffset": ring.baseOffset, "headOffset": ring.headOffset]
        case "close":
            if !exited { close(signalNumber: SIGHUP) }
            return [:]
        default:
            throw HolderError("unknown op \(op)")
        }
    }

    private func info() -> [String: Any] {
        var result: [String: Any] = [
            "protocol": holderProtocol, "holderVersion": holderVersion, "pid": Int(getpid()), "childPid": Int(childPid),
            "cols": Int(cols), "rows": Int(rows), "baseOffset": ring.baseOffset, "headOffset": ring.headOffset,
            "retainedBytes": ring.retainedBytes, "exited": exited,
            "startedAt": ISO8601DateFormatter().string(from: startedAt),
        ]
        if masterOpen { result["foregroundGroup"] = Int(holder_foreground_group(master)) }
        return result.merging(exitFields()) { $1 }
    }

    private func exitEvent() -> [String: Any] {
        exitFields().merging(["event": "exit", "headOffset": ring.headOffset]) { $1 }
    }

    private func exitFields() -> [String: Any] {
        var fields: [String: Any] = [:]
        if let exitCode { fields["exitCode"] = Int(exitCode) }
        if let exitSignal { fields["exitSignal"] = Int(exitSignal) }
        return fields
    }

    private func replay(from offset: UInt64, to client: Client) {
        for entry in ring.entries(from: offset) {
            switch entry {
            case let .output(start, bytes): send(Frame.output(offset: start, bytes: bytes), to: client)
            case let .resize(at, entryCols, entryRows): send(Frame.resize(offset: at, cols: entryCols, rows: entryRows), to: client)
            }
            if clients[client.fd] == nil { return }
        }
        if exited { send(Frame.json(exitEvent()), to: client) }
    }

    private func broadcast(_ frame: [UInt8]) {
        for client in clients.values where client.attached { send(frame, to: client) }
    }

    private func send(_ frame: [UInt8], to client: Client) {
        // A client that falls this far behind reattaches from its last offset instead.
        guard client.pendingOutput + frame.count <= clientOutputLimit else {
            disconnect(client)
            return
        }
        client.output.append(contentsOf: frame)
        flush(client)
    }

    private func flush(_ client: Client) {
        while client.pendingOutput > 0 {
            let count = client.output.withUnsafeBytes {
                Darwin.write(client.fd, $0.baseAddress! + client.outputStart, client.pendingOutput)
            }
            if count > 0 {
                client.outputStart += count
            } else if count < 0 && errno == EINTR {
                continue
            } else if count < 0 && errno == EAGAIN {
                if !client.writeArmed {
                    client.writeArmed = true
                    watch(UInt(client.fd), EVFILT_WRITE, EV_ADD)
                }
                compact(client)
                return
            } else {
                disconnect(client)
                return
            }
        }
        client.output.removeAll(keepingCapacity: client.output.count < 1 << 20)
        client.outputStart = 0
        if client.writeArmed {
            client.writeArmed = false
            watch(UInt(client.fd), EVFILT_WRITE, EV_DELETE)
        }
    }

    private func compact(_ client: Client) {
        if client.outputStart > 1 << 20 {
            client.output.removeFirst(client.outputStart)
            client.outputStart = 0
        }
    }

    private func disconnect(_ client: Client) {
        clients.removeValue(forKey: client.fd)
        Darwin.close(client.fd)
    }

    // MARK: Input

    private func write(input bytes: [UInt8], from client: Client) {
        guard masterOpen, !exited else { return }
        guard pendingInput.count - pendingInputStart + bytes.count <= inputLimit else {
            send(Frame.json(["event": "inputDropped", "bytes": bytes.count]), to: client)
            return
        }
        pendingInput.append(contentsOf: bytes)
        flushInput()
    }

    private func flushInput() {
        while masterOpen, pendingInput.count > pendingInputStart {
            let count = pendingInput.withUnsafeBytes {
                Darwin.write(master, $0.baseAddress! + pendingInputStart, pendingInput.count - pendingInputStart)
            }
            if count > 0 {
                pendingInputStart += count
            } else if count < 0 && errno == EINTR {
                continue
            } else if count < 0 && errno == EAGAIN {
                if !masterWriteArmed {
                    masterWriteArmed = true
                    watch(UInt(master), EVFILT_WRITE, EV_ADD)
                }
                return
            } else {
                pendingInput.removeAll()
                pendingInputStart = 0
                return
            }
        }
        pendingInput.removeAll(keepingCapacity: true)
        pendingInputStart = 0
        if masterWriteArmed, masterOpen {
            masterWriteArmed = false
            watch(UInt(master), EVFILT_WRITE, EV_DELETE)
        }
    }

    // MARK: Lifecycle

    private func close(signalNumber: Int32) {
        if exited { shutdown() }
        guard !closing else { return }
        closing = true
        kill(-childPid, signalNumber)
        if masterOpen {
            let group = holder_foreground_group(master)
            if group > 0, group != childPid { kill(-group, signalNumber) }
        }
        watch(forceKillTimer, EVFILT_TIMER, EV_ADD | EV_ONESHOT, fflags: UInt32(truncatingIfNeeded: NOTE_SECONDS), data: 5)
    }

    private func shutdown() -> Never {
        for client in clients.values {
            // Best effort: deliver queued replies and events before closing.
            _ = fcntl(client.fd, F_SETFL, 0)
            var timeout = timeval(tv_sec: 1, tv_usec: 0)
            setsockopt(client.fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            if client.pendingOutput > 0 {
                _ = client.output.withUnsafeBytes { Darwin.write(client.fd, $0.baseAddress! + client.outputStart, client.pendingOutput) }
            }
            Darwin.close(client.fd)
        }
        unlinkat(directoryFD, "sock", 0)
        exit(0)
    }

    private func watch(_ ident: UInt, _ filter: Int32, _ flags: Int32, fflags: UInt32 = 0, data: Int = 0) {
        _ = holder_watch(kq, ident, Int16(filter), UInt16(flags), fflags, data)
    }

    private func writeRecord(_ name: String, _ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        let temporary = name + ".tmp"
        let fd = openat(directoryFD, temporary, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return }
        let written = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        Darwin.close(fd)
        if written == data.count { renameat(directoryFD, temporary, directoryFD, name) }
    }
}

let signalNumbers: [String: Int32] = [
    "HUP": SIGHUP, "INT": SIGINT, "QUIT": SIGQUIT, "KILL": SIGKILL, "TERM": SIGTERM, "TSTP": SIGTSTP,
    "CONT": SIGCONT, "STOP": SIGSTOP, "WINCH": SIGWINCH, "USR1": SIGUSR1, "USR2": SIGUSR2,
]

struct HolderError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

func unixAddress(_ path: String) -> sockaddr_un {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
        let bytes = Array(path.utf8)
        raw.copyBytes(from: bytes.prefix(raw.count - 1))
    }
    return address
}

func canConnect(_ path: String) -> Bool {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { Darwin.close(fd) }
    var address = unixAddress(path)
    return withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    } == 0
}
