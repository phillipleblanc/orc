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
            guard index + 1 < options.count, !options[index + 1].hasPrefix("--") else { throw OrcError("Missing value after \(name).") }
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
                print("SESSION\tSTATE\tHANDLE\tPROJECT")
                for s in result.terminals { print("\(safe(s.name))\t\(s.connected ? "running" : "offline")\t\(s.handle)\t\(safe(s.worktreePath))") }
                if result.truncated { FileHandle.standardError.write(Data("Warning: Orca returned a truncated session list.\n".utf8)) }
            }
        case "projects", "workspaces":
            guard options.isEmpty else { throw OrcError("Usage: orc projects [--json]") }
            let projects = try await service.workspaces()
            if json { try emit(try JSONSerialization.jsonObject(with: JSONEncoder().encode(projects))) }
            else { for project in projects { print("\(safe(project.name))\t\(safe(project.path))\t\(project.id)") } }
        case "new", "create":
            let requestedProject = try value("--project")
            let legacyProject = try value("--worktree")
            let requestedName = try value("--name")
            let customCommand = try value("--command")
            guard options.count <= 1, options.first?.hasPrefix("--") != true else {
                throw OrcError("Usage: orc new [codex|claude|pi|terminal] [--name NAME] [--project SELECTOR] [--json]")
            }
            guard requestedProject == nil || legacyProject == nil else { throw OrcError("Specify --project only once.") }
            let type: SessionType?
            if let requestedType = options.first {
                guard let parsed = SessionType(rawValue: requestedType) else {
                    throw OrcError("Unknown session type '\(requestedType)'. Choose codex, claude, pi, or terminal; use --name NAME to name it.")
                }
                guard customCommand == nil else { throw OrcError("Choose a session type or --command, not both.") }
                type = parsed
            } else { type = nil }
            if let customCommand, customCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                throw OrcError("--command requires a non-empty command.")
            }
            let created = try await createSession(using: service, type: type, name: requestedName,
                project: requestedProject ?? legacyProject, command: customCommand)
            if json { try emit(["handle": created.handle, "name": created.name, "type": created.type, "project": created.project,
                               "attachCommand": "orc attach \(shellQuote(created.handle))"]) }
            else { print("Created \(created.name) (\(created.type), \(created.project))\norc attach \(shellQuote(created.handle))") }
        case "attach":
            let readOnly = flag("--read-only"), noReconnect = flag("--no-reconnect")
            let sessionSwitching = !flag("--no-session-switch")
            guard options.count <= 1, !json else { throw OrcError("Usage: orc attach [NAME-OR-HANDLE] [--read-only] [--no-reconnect]") }
            var selector = options.first
            var selectedHandle: String?
            while true {
                let listing = try await service.list()
                let terminal: Session
                if let selector { terminal = try resolveSession(selector, in: listing.terminals) }
                else {
                    guard let picked = try await SessionPicker(sessions: listing.terminals, selectedHandle: selectedHandle).run() else { return }
                    switch picked {
                    case .session(let session): terminal = session
                    case .create:
                        print("[orc] Creating a session…")
                        let created = try await createSession(using: service)
                        print("Created \(created.name) (\(created.type), \(created.project))\norc attach \(shellQuote(created.handle))")
                        selector = created.handle
                        continue
                    }
                }
                guard terminal.connected else { throw OrcError("This session is offline.") }
                let result = try await TerminalAttach(terminal: terminal, readOnly: readOnly, reconnect: !noReconnect, sessionSwitching: sessionSwitching).run()
                guard result == .picker || (sessionSwitching && result == .ended) else { return }
                selector = nil; selectedHandle = terminal.handle
            }
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
    @MainActor private static func createSession(using service: SessionService, type requestedType: SessionType? = nil,
        name requestedName: String? = nil, project requestedProject: String? = nil, command: String? = nil
    ) async throws -> (handle: String, name: String, type: String, project: String) {
        let config = try requestedType == nil || requestedProject == nil ? OrcConfiguration.load() : OrcConfiguration()
        let type = requestedType ?? config.defaultSessionType
        let project = try SessionCreationDefaults.project(requestedProject ?? config.defaultProject, in: await service.workspaces())
        let name: String
        if let requestedName { name = requestedName.trimmingCharacters(in: .whitespacesAndNewlines) }
        else {
            let listing = try await service.list()
            guard !listing.truncated else { throw OrcError("Orca returned an incomplete session list. Supply a name with `orc new --name NAME`.") }
            name = try SessionCreationDefaults.name(excluding: Set(listing.terminals.map(\.name)))
        }
        let handle = try await service.create(name: name, worktree: "id:" + project.id, command: command ?? type.command)
        return (handle, name, command == nil ? type.rawValue : "custom", project.name)
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
    orc projects [--json]                    List available projects
    orc new [codex|claude|pi|terminal]        Create a session (default: codex)
            [--name NAME]                   Otherwise choose a short verb-noun name
            [--project SELECTOR] [--json]    Override the configured project
    orc new --command 'COMMAND'              Run a custom command instead
    orc attach [NAME-OR-HANDLE]              Choose a session, or attach by name
                 [--read-only]              Watch without sending input or resizing
                 [--no-reconnect]           Exit on connection loss
    orc connect                             Save a runtime access link from stdin
    orc status [--json]                      Connect to or start the Orca runtime

    Press Ctrl-' to switch sessions; Ctrl-] to detach. Sessions keep running.
    When a session ends, attach returns to the picker. Esc closes the picker.
    In the picker, n creates and attaches using the same defaults as orc new.
    Type to filter; / starts a search (including names beginning with n).
    Orc reuses Orca when running, or starts its installed backend headlessly.
    Project selectors accept a name, absolute path, path:/absolute/path, or id:ID.
    Set defaultSessionType and defaultProject in ~/.config/orc/config.json.
    When unset, defaults are codex and spiceai-project.
    Use terminal for a session without an agent.
    ORCA_USER_DATA_PATH selects an Orca profile; ORC_CONFIG_DIR selects Orc settings and credentials.
    """
}
