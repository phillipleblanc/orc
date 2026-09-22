import Foundation
import Darwin
import OrcKit
import COrcSupport

@main struct OrcCLI {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        // Read on the initial thread so readpassphrase's signal handlers can
        // interrupt its blocking read and restore echo before the process exits.
        var pairingLink: String?
        if args == ["connect"] {
            if isatty(STDIN_FILENO) == 1 { print("Paste a runtime access link from Orca → Settings → Remote Orca Servers:") }
            pairingLink = readPairingLink()
        }
        Task { @MainActor in
            do { try await run(args, pairingLink: pairingLink); exit(0) }
            catch { FileHandle.standardError.write(Data(("orc: \(error.localizedDescription)\n").utf8)); exit(1) }
        }
        dispatchMain()
    }
    @MainActor static func run(_ args: [String], pairingLink: String?) async throws {
        guard let command = args.first, command != "--help", command != "help" else { print(help); return }
        var options = Array(args.dropFirst())
        func flag(_ name: String) -> Bool {
            guard let index = options.firstIndex(of: name) else { return false }; options.remove(at: index); return true
        }
        func value(_ name: String) throws -> String? {
            guard let index = options.firstIndex(of: name) else { return nil }
            guard index + 1 < options.count else { throw OrcError("Missing value after \(name).") }
            options.remove(at: index); return options.remove(at: index)
        }
        let json = flag("--json")
        let service = SessionService()
        func emit(_ object: Any) throws { print(String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self)) }
        switch command {
        case "list", "ls":
            guard options.isEmpty else { throw OrcError("Usage: orc list [--json]") }
            let result = try await service.list()
            if json { try emit(try JSONSerialization.jsonObject(with: JSONEncoder().encode(result.terminals))) }
            else {
                print("SESSION\tSTATE\tHANDLE\tWORKSPACE")
                for s in result.terminals { print("\(safe(s.name))\t\(s.connected ? "running" : "offline")\t\(s.handle)\t\(safe(s.worktreePath))") }
                if result.truncated { FileHandle.standardError.write(Data("Warning: Orca returned a truncated session list.\n".utf8)) }
            }
        case "workspaces":
            guard options.isEmpty else { throw OrcError("Usage: orc workspaces [--json]") }
            let workspaces = try await service.workspaces()
            if json { try emit(try JSONSerialization.jsonObject(with: JSONEncoder().encode(workspaces))) }
            else { for workspace in workspaces { print("\(safe(workspace.name))\t\(safe(workspace.path))\t\(workspace.id)") } }
        case "new", "create":
            let worktree = try value("--worktree") ?? "path:\(FileManager.default.currentDirectoryPath)"
            let startup = try value("--command")
            guard options.count == 1 else { throw OrcError("Usage: orc new NAME [--worktree SELECTOR] [--command 'pi'] [--json]") }
            let handle = try await service.create(name: options[0], worktree: worktree, command: startup)
            if json { try emit(["handle": handle, "name": options[0], "attachCommand": "orc attach \(shellQuote(handle))"]) }
            else { print("Created \(options[0])\norc attach \(shellQuote(handle))") }
        case "attach":
            let readOnly = flag("--read-only"), noReconnect = flag("--no-reconnect")
            guard options.count == 1, !json else { throw OrcError("Usage: orc attach NAME-OR-HANDLE [--read-only] [--no-reconnect]") }
            let terminal = try resolveSession(options[0], in: await service.list().terminals)
            guard terminal.connected else { throw OrcError("This session is offline.") }
            try await TerminalAttach(terminal: terminal, readOnly: readOnly, reconnect: !noReconnect).run()
        case "connect":
            guard options.isEmpty, !json else { throw OrcError("Usage: orc connect < pairing-link-file (or paste the link at the prompt)") }
            guard let line = pairingLink else { throw OrcError("No pairing link supplied.") }
            let pairing = try Pairing.parse(line)
            let connection = try StreamConnection(pairing: pairing)
            try await connection.connect(); defer { connection.close() }
            _ = try await connection.request("status.get")
            try pairing.save()
            print("Connected. Orca and its mobile pairing remain available.")
        case "status":
            guard options.isEmpty else { throw OrcError("Usage: orc status [--json]") }
            let result = try await LocalRPC.call("status.get")
            if json { try emit(result) }
            else { print("Orca is reachable. Interactive attachment: \(Pairing.isConfigured ? "configured" : "run orc connect").") }
        default: throw OrcError("Unknown command '\(command)'. Run `orc --help`.")
        }
    }
    static func safe(_ text: String) -> String { String(text.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }) }
    static func readPairingLink() -> String? {
        var buffer = [CChar](repeating: 0, count: 32769)
        guard orc_read_pairing(&buffer, buffer.count) != nil else { return nil }
        return String(cString: buffer)
    }
    static let help = """
    orc — native clients for your running Orca sessions

    orc list [--json]                         List sessions and handles
    orc workspaces [--json]                   List available workspaces
    orc new NAME [--worktree SELECTOR]        Create a named session
                 [--command 'pi'] [--json]   Start an agent or command
    orc attach NAME-OR-HANDLE                Attach in this terminal
                 [--read-only]              Watch without sending input or resizing
                 [--no-reconnect]           Exit on connection loss
    orc connect                             Save a runtime access link from stdin
    orc status [--json]                      Check the existing Orca runtime

    Press Ctrl-] to detach. The Orca session keeps running.
    Workspace selectors include path:/absolute/path and id:<workspace-id>.
    The current directory is used when --worktree is omitted.
    ORCA_USER_DATA_PATH selects an Orca profile; ORC_CONFIG_DIR selects Orc credentials.
    """
}
