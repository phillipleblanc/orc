import Foundation
import Darwin
import OrcKit
import COrcSupport

@main struct OrcCLI {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        if args == ["hook", "claude-session-name"] {
            let response = ClaudeSessionNameHook.response(to: FileHandle.standardInput.readDataToEndOfFile())
            let data = (try? JSONSerialization.data(withJSONObject: response)) ?? Data("{}".utf8)
            print(String(decoding: data, as: UTF8.self))
            return
        }
        Task { @MainActor in
            do { try await run(args); exit(0) }
            catch { FileHandle.standardError.write(Data(("orc: \(error.localizedDescription)\n").utf8)); exit(1) }
        }
        dispatchMain()
    }
    @MainActor static func run(_ args: [String]) async throws {
        guard let command = args.first, command != "--help", command != "help" else { print(help); return }
        if command == "agent" {
            let arguments = Array(args.dropFirst())
            if arguments.isEmpty || arguments == ["--help"] || arguments == ["help"] { print(SessionAgentCommand.help); return }
            let command = try SessionAgentCommand(arguments)
            let result = try await SessionAgentService.execute(command)
            if command.json {
                print(String(decoding: try JSONSerialization.data(withJSONObject: result.body, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
            } else {
                print(SessionAgentService.describe(command, result.body))
            }
            if !result.succeeded { exit(2) }
            return
        }
        if command == "wake" {
            let arguments = Array(args.dropFirst())
            if arguments.isEmpty || arguments == ["--help"] || arguments == ["help"] { print(SessionWakeCommand.help); return }
            let command = try SessionWakeCommand(arguments)
            let result = try await SessionWakeService.execute(command)
            if command.json {
                print(String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]), as: UTF8.self))
            } else {
                print(SessionWakeService.describe(command, result))
            }
            return
        }
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
                print("SESSION\tSTATE\tPROJECT")
                for s in result.terminals { print("\(safe(s.name))\t\(s.connected ? "running" : "offline")\t\(safe(s.worktreePath))") }
                if result.truncated { FileHandle.standardError.write(Data("Warning: the runtime returned a truncated session list.\n".utf8)) }
            }
        case "projects", "workspaces":
            if options.first == "add" {
                options.removeFirst()
                let makeDefault = flag("--default")
                guard options.count == 1, !options[0].hasPrefix("--") else {
                    throw OrcError("Usage: orc projects add PATH [--default] [--json]")
                }
                let project = try await service.registerProject(at: URL(fileURLWithPath: options[0]))
                if makeDefault { try OrcConfiguration.setDefaultProject("id:" + project.id) }
                if json { try emit(try JSONSerialization.jsonObject(with: JSONEncoder().encode(project))) }
                else { print("Registered \(safe(project.name))\(makeDefault ? " as the default project" : "").") }
                return
            }
            guard options.isEmpty else { throw OrcError("Usage: orc projects [--json]") }
            let projects = try await service.workspaces()
            if json { try emit(try JSONSerialization.jsonObject(with: JSONEncoder().encode(projects))) }
            else { for project in projects { print("\(safe(project.name))\t\(safe(project.path))\t\(project.id)") } }
        case "new", "create":
            let requestedProject = try value("--project")
            let requestedName = try value("--name")
            let customCommand = try value("--command")
            guard options.count <= 1, options.first?.hasPrefix("--") != true else {
                throw OrcError("Usage: orc new [codex|claude|pi|durable|terminal] [--name NAME] [--project SELECTOR] [--json]")
            }
            let type: SessionType?
            if let requestedType = options.first {
                guard let parsed = SessionType(rawValue: requestedType) else {
                    throw OrcError("Unknown session type '\(requestedType)'. Choose codex, claude, pi, durable, or terminal; use --name NAME to name it.")
                }
                guard customCommand == nil else { throw OrcError("Choose a session type or --command, not both.") }
                type = parsed
            } else { type = nil }
            if let customCommand, customCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                throw OrcError("--command requires a non-empty command.")
            }
            let created = try await createSession(using: service, type: type, name: requestedName,
                project: requestedProject, command: customCommand)
            if json { try emit(["handle": created.handle, "name": created.name, "type": created.type, "project": created.project,
                               "attachCommand": "orc attach \(shellQuote(created.name))"]) }
            else {
                print("Created \(created.name) (\(created.type), \(created.project))\norc attach \(shellQuote(created.name))")
                if isatty(STDIN_FILENO) == 1, isatty(STDOUT_FILENO) == 1 {
                    try await run(["attach", created.handle])
                }
            }
        case "history":
            let allProjects = flag("--all")
            guard options.count <= 1, options.first?.hasPrefix("--") != true else { throw OrcError("Usage: orc history [QUERY] [--all] [--json]") }
            let query = options.first ?? ""
            let terms = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
            let closed = try await service.closedSessions().filter { session in
                let words = [session.name, session.agent, session.cwd, session.lastMessage ?? ""].joined(separator: "\n").lowercased()
                return terms.allSatisfy { words.contains($0) }
            }
            let conversations = try await service.conversations(query: query, allProjects: allProjects, limit: 20)
            if json {
                try emit(["sessions": try JSONSerialization.jsonObject(with: JSONEncoder().encode(closed)),
                          "conversations": try JSONSerialization.jsonObject(with: JSONEncoder().encode(conversations))])
                return
            }
            print("Recently closed")
            if closed.isEmpty { print("  No recently closed agent sessions\(query.isEmpty ? "" : " match").") }
            else {
                print("SESSION\tAGENT\tCLOSED\tPROJECT")
                for session in closed { print("\(safe(session.name))\t\(session.agent)\t\(session.age())\t\(safe(session.cwd))") }
            }
            print("\nConversations\(allProjects ? "" : " in registered projects")")
            if conversations.isEmpty { print("  No conversations\(query.isEmpty ? "" : " match").") }
            else {
                print("ID\tAGENT\tUPDATED\tPROJECT\tTITLE")
                for conversation in conversations {
                    let title = safe(conversation.displayTitle.split(whereSeparator: \.isNewline).first.map(String.init) ?? "")
                    print("\(conversation.id.prefix(12))\t\(conversation.agent)\t\(conversation.age())\t\(safe(URL(fileURLWithPath: conversation.cwd).lastPathComponent))\t\(title.prefix(60))\(conversation.openIn.map { " (open in \(safe($0)))" } ?? "")")
                }
            }
        case "reopen":
            let newName = try value("--name")
            guard options.count == 1 else { throw OrcError("Usage: orc reopen NAME|ID [--name NEW] [--json]") }
            let reopened = try await service.reopen(name: options[0], as: newName)
            if json {
                try emit(["handle": reopened.handle, "name": reopened.name, "alreadyOpen": reopened.alreadyOpen,
                          "attachCommand": "orc attach \(shellQuote(reopened.name))"])
            } else {
                print("\(reopened.alreadyOpen ? "Already open as" : "Reopened") \(safe(reopened.name))\norc attach \(shellQuote(reopened.name))")
                if isatty(STDIN_FILENO) == 1, isatty(STDOUT_FILENO) == 1 { try await run(["attach", reopened.handle]) }
            }
        case "brief":
            let refresh = flag("--refresh")
            guard options.count == 1, !options[0].hasPrefix("--") else { throw OrcError("Usage: orc brief NAME [--refresh] [--json]") }
            // Writing a brief takes a model a minute or more on a long transcript.
            let record = refresh
                ? try await LocalRPC.call("brief.refresh", ["name": options[0], "wait": true], timeout: 360)
                : (try await LocalRPC.call("brief.list")["briefs"] as? [[String: Any]] ?? []).first { $0["name"] as? String == options[0] }
            guard let record else { throw OrcError("\(options[0]) is not a running agent session. Run `orc agent list` for their names.") }
            if json { try emit(record) } else { print(try AgentBrief(record: record).text()) }
        case "close":
            guard options.count == 1, !options[0].hasPrefix("--") else { throw OrcError("Usage: orc close NAME [--json]") }
            let result = try await LocalRPC.call("terminal.close", ["terminal": options[0]])
            if json { try emit(["name": options[0], "handle": (result["close"] as? [String: Any])?["handle"] ?? NSNull()]) }
            else { print("Closed \(safe(options[0])).") }
        case "attach":
            let readOnly = flag("--read-only"), noReconnect = flag("--no-reconnect")
            let sessionSwitching = !flag("--no-session-switch")
            guard options.count <= 1, !json else { throw OrcError("Usage: orc attach [NAME] [--read-only] [--no-reconnect]") }
            let herdr = HerdrAttach.current
            let herdrChild = ProcessInfo.processInfo.environment["ORC_HERDR_ATTACH_CHILD"] == "1"
            if herdrChild, options.count != 1 { throw OrcError("An Orc Herdr attachment needs a session handle.") }
            var selector = options.first
            var selectedHandle: String?
            while true {
                let listing = try await service.list()
                let terminal: Session
                if let selector { terminal = try resolveSession(selector, in: listing.terminals) }
                else {
                    let closed = (try? await service.closedSessions()) ?? []
                    guard let picked = try await SessionPicker(sessions: listing.terminals, closed: closed, selectedHandle: selectedHandle).run() else { return }
                    switch picked {
                    case .session(let session): terminal = session
                    case .reopen(let closed):
                        print("[orc] Reopening \(safe(closed.name))…")
                        selector = try await service.reopen(entry: closed.entry).handle
                        continue
                    case .create:
                        print("[orc] Creating a session…")
                        let created = try await createSession(using: service)
                        print("Created \(created.name) (\(created.type), \(created.project))\norc attach \(shellQuote(created.name))")
                        selector = created.handle
                        continue
                    }
                }
                guard terminal.connected else { throw OrcError("This session is offline.") }
                if herdrChild {
                    let expected = ProcessInfo.processInfo.environment["ORC_HERDR_EXPECTED_INCAR"] ?? ""
                    guard terminal.incarnationId ?? "" == expected else {
                        throw OrcError("The selected session was replaced before attachment. Choose it again.")
                    }
                } else if let herdr {
                    let result = try await herdr.attach(terminal, readOnly: readOnly, noReconnect: noReconnect,
                                                        sessionSwitching: sessionSwitching)
                    guard result == .picker || (sessionSwitching && result == .ended) else { return }
                    selector = nil; selectedHandle = terminal.handle
                    continue
                }
                let bridge = herdrChild ? herdr.flatMap { HerdrAgentBridge(context: $0, session: terminal) } : nil
                bridge?.start()
                let result: AttachExit
                do {
                    result = try await TerminalAttach(terminal: terminal, readOnly: readOnly, reconnect: !noReconnect, sessionSwitching: sessionSwitching).run()
                } catch {
                    await bridge?.stop()
                    throw error
                }
                await bridge?.stop()
                if herdrChild {
                    if result == .picker { Darwin.exit(HerdrAttach.pickerExitCode) }
                    if result == .ended { Darwin.exit(HerdrAttach.endedExitCode) }
                    return
                }
                guard result == .picker || (sessionSwitching && result == .ended) else { return }
                selector = nil; selectedHandle = terminal.handle
            }
        case "pair-phone":
            let requestedAddress = try value("--address")
            let rotate = flag("--rotate"), linkOnly = flag("--link")
            guard options.isEmpty, !(json && linkOnly) else {
                throw OrcError("Usage: orc pair-phone [--address IP] [--rotate] [--link | --json]")
            }
            let status = try await PhonePairingService.status()
            guard let address = requestedAddress ?? status.defaultAddress,
                  status.interfaces.contains(where: { $0.address == address }) else {
                throw OrcError("Choose a reachable address with --address IP. Run `orc phones` to list this Mac's addresses.")
            }
            let offer = try await PhonePairingService.create(address: address, rotate: rotate)
            if json { try emit(try JSONSerialization.jsonObject(with: JSONEncoder().encode(offer))) }
            else if linkOnly { print(offer.pairingUrl) }
            else {
                print("On the same Wi-Fi or Tailscale network, open Orca Mobile → Pair and scan this private QR code.")
                let qr = try PhonePairingQR(link: offer.pairingUrl)
                var dimensions = winsize()
                if isatty(STDOUT_FILENO) == 1, ioctl(STDOUT_FILENO, TIOCGWINSZ, &dimensions) == 0,
                   dimensions.ws_col > 0, Int(dimensions.ws_col) < qr.minimumTerminalColumns {
                    print("The QR code needs \(qr.minimumTerminalColumns) columns. Widen the terminal, or paste this private link into Orca Mobile:")
                    print(offer.pairingUrl)
                } else { print(qr.terminal) }
                print("Server: \(offer.endpoint)\nFor a link to paste into the phone, run orc pair-phone --address \(address) --link.")
            }
        case "phones":
            if options.first == "revoke" {
                options.removeFirst()
                guard options.count == 1 else { throw OrcError("Usage: orc phones revoke DEVICE_ID [--json]") }
                try await PhonePairingService.revoke(deviceId: options[0])
                if json { try emit(["revoked": true]) } else { print("Phone access revoked.") }
            } else {
                guard options.isEmpty else { throw OrcError("Usage: orc phones [--json]") }
                let status = try await PhonePairingService.status()
                if json {
                    try emit(["runtimeId": status.runtimeId,
                              "addresses": status.interfaces.map { ["interface": $0.name, "address": $0.address] },
                              "defaultAddress": status.defaultAddress as Any? ?? NSNull(),
                              "devices": try JSONSerialization.jsonObject(with: JSONEncoder().encode(status.devices))])
                } else {
                    print("NETWORK ADDRESSES")
                    for item in status.interfaces { print("\(safe(item.name))\t\(safe(item.address))") }
                    print("\nPHONE\tSTATE\tDEVICE ID")
                    for phone in status.devices { print("\(safe(phone.name))\t\(phone.isPaired ? "paired" : "awaiting pairing")\t\(phone.deviceId)") }
                }
            }
        case "status":
            guard options.isEmpty else { throw OrcError("Usage: orc status [--json]") }
            let result = try await LocalRPC.call("status.get")
            if json { try emit(result) }
            else { print("The runtime is running (\(RuntimeMetadata.directory.path)).") }
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
            guard !listing.truncated else { throw OrcError("The runtime returned an incomplete session list. Supply a name with `orc new --name NAME`.") }
            name = try SessionCreationDefaults.name(excluding: Set(listing.terminals.map(\.name)))
        }
        let handle = try await service.create(name: name, worktree: "id:" + project.id, command: command ?? type.command)
        return (handle, name, command == nil ? type.rawValue : "custom", project.name)
    }
    static func safe(_ text: String) -> String { String(text.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }) }
    static let help = """
    orc — sessions for agents and shells that keep running in the background

    orc list [--json]                         List sessions
    orc projects [--json]                    List projects
    orc projects add PATH [--default]        Register a project folder
    orc new [codex|claude|pi|durable|terminal] Create and attach (default: codex)
            [--name NAME]                   Otherwise choose a short verb-noun name
            [--project SELECTOR] [--json]    Override the configured project
    orc new --command 'COMMAND'              Run a custom command instead
    orc attach [NAME]                        Choose a session, or attach by name
                 [--read-only]              Watch without sending input or resizing
                 [--no-reconnect]           Exit on connection loss
    orc agent                               Spawn agents and message them by name (orc agent --help)
    orc history [QUERY] [--all] [--json]     Recently closed agent sessions and agent conversations
    orc reopen NAME|ID [--name NEW] [--json] Reopen one, resuming its conversation, and attach
    orc close NAME [--json]                  End a session; a closed agent session can be reopened
    orc brief NAME [--refresh] [--json]      Where an agent's work stands: goal, progress, now, next
    orc wake DURATION|pid PID|SCRIPT [MSG]  Message this agent session later (orc wake --help)
    orc pair-phone [--address IP]            Show a phone pairing QR (LAN/Tailscale)
                   [--rotate] [--link | --json]
    orc phones [--json]                      List phone grants and network addresses
    orc phones revoke DEVICE_ID [--json]     Revoke a phone's access
    orc status [--json]                      Start the runtime if needed and report it

    Press Ctrl-' to switch sessions; Ctrl-] to detach. Sessions keep running.
    Inside Herdr, the attached agent appears in Herdr's Agents view.
    When a session ends, attach returns to the picker. Esc closes the picker.
    The picker also lists recently closed agent sessions; Enter reopens one.
    In the picker, n creates and attaches using the same defaults as orc new.
    orc new --json creates without attaching for scripts and automation.
    Type to filter; / starts a search (including names beginning with n).
    Project selectors accept a name, absolute path, path:/absolute/path, or id:ID.
    Set defaultSessionType and defaultProject in ~/.config/orc/config.json, or in Orc's Settings.
    Use terminal for a session without an agent.
    ORC_CONFIG_DIR selects Orc's settings; ORC_RUNTIME_DIR selects the runtime profile.
    """
}
