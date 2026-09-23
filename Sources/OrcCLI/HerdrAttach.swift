import Foundation
import Darwin
import OrcKit

/// An Orca agent is visible to Herdr only while its terminal is attached in a Herdr pane.
struct HerdrAttach {
    static let pickerExitCode: Int32 = 74
    static let endedExitCode: Int32 = 75
    let pane: String
    let binary: String

    static var current: HerdrAttach? {
        let env = ProcessInfo.processInfo.environment
        guard env["HERDR_ENV"] == "1", let pane = env["HERDR_PANE_ID"], !pane.isEmpty,
              let binary = env["HERDR_BIN_PATH"], binary.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: binary) else { return nil }
        return HerdrAttach(pane: pane, binary: binary)
    }

    func attach(_ session: Session, readOnly: Bool, noReconnect: Bool, sessionSwitching: Bool) async throws -> AttachExit {
        guard let executable = Bundle.main.executableURL else { throw OrcError("Cannot locate the Orc executable.") }
        let process = Process()
        process.executableURL = executable
        process.arguments = Self.arguments(selector: session.handle, readOnly: readOnly,
                                           noReconnect: noReconnect, sessionSwitching: sessionSwitching)
        var environment = ProcessInfo.processInfo.environment
        environment["ORC_HERDR_ATTACH_CHILD"] = "1"
        environment["ORC_HERDR_EXPECTED_INCAR"] = session.incarnationId ?? ""
        environment["HERDR_AGENT"] = Self.manifestAgent(session.agentIdentity)
        process.environment = environment
        process.standardInput = FileHandle.standardInput
        process.standardOutput = FileHandle.standardOutput
        process.standardError = FileHandle.standardError
        guard isatty(STDIN_FILENO) == 1, let foreground = Self.foregroundGroup() else {
            throw OrcError("Herdr attachment needs an interactive terminal.")
        }
        let signals = [SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGTTOU]
        let previous = signals.map { ($0, signal($0, SIG_IGN)) }
        defer { previous.forEach { _ = signal($0.0, $0.1) } }
        do { try process.run() }
        catch { throw OrcError("Cannot start the Orc Herdr attachment: \(error.localizedDescription)") }
        let childGroup = getpgid(process.processIdentifier)
        guard childGroup > 0, tcsetpgrp(STDIN_FILENO, childGroup) == 0 else {
            process.terminate()
            process.waitUntilExit()
            throw OrcError("Cannot give the Herdr pane to the Orc attachment.")
        }
        // Foundation starts the child in a new process group. Herdr observes the
        // foreground group, and the child must own the TTY while it is attached.
        defer { _ = tcsetpgrp(STDIN_FILENO, foreground) }
        _ = kill(-childGroup, SIGCONT)
        let exitCode = await Task.detached {
            process.waitUntilExit()
            return process.terminationStatus
        }.value
        guard tcsetpgrp(STDIN_FILENO, foreground) == 0 else {
            throw OrcError("Cannot return the Herdr pane to Orc's session picker.")
        }
        if session.agentIdentity != nil { await clearAgent() }
        switch exitCode {
        case Self.pickerExitCode: return .picker
        case Self.endedExitCode: return .ended
        case 0: return .detached
        default: throw OrcError("Attachment exited with status \(exitCode).")
        }
    }

    private static func foregroundGroup() -> pid_t? {
        let group = tcgetpgrp(STDIN_FILENO)
        return group > 0 ? group : nil
    }

    private func clearAgent() async {
        // Herdr retains a wrapper's detected agent until a new pane occupant is
        // reported. Replace it with a short-lived picker marker, then release it.
        let marker = ["pane", "report-agent", pane, "--source", "custom:orc-picker",
                      "--agent", "orc-picker", "--state", "unknown"]
        if await Self.command(binary: binary, arguments: marker) {
            _ = await Self.command(binary: binary, arguments: ["pane", "release-agent", pane,
                                                          "--source", "custom:orc-picker", "--agent", "orc-picker"])
        }
        _ = await Self.command(binary: binary, arguments: ["pane", "report-metadata", pane,
                                                       "--source", "custom:orc", "--clear-title",
                                                       "--clear-display-agent", "--clear-token", "orc_session",
                                                       "--clear-token", "orc_project"])
    }

    static func command(binary: String, arguments: [String]) async -> Bool {
        await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: binary)
            process.arguments = arguments
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
                process.waitUntilExit()
                return process.terminationStatus == 0
            } catch { return false }
        }.value
    }

    private static func arguments(selector: String?, readOnly: Bool, noReconnect: Bool, sessionSwitching: Bool) -> [String] {
        var args = ["attach"]
        if let selector { args.append(selector) }
        if readOnly { args.append("--read-only") }
        if noReconnect { args.append("--no-reconnect") }
        if !sessionSwitching { args.append("--no-session-switch") }
        return args
    }

    private static func manifestAgent(_ identity: String?) -> String? {
        switch identity?.lowercased() {
        case "codex": return "codex"
        case "claude", "claude-code": return "claude"
        case "pi": return "pi"
        default: return nil
        }
    }

}

@MainActor final class HerdrAgentBridge {
    private let context: HerdrAttach
    private let session: Session
    private let agent: String
    private var monitor: Task<Void, Never>?
    private var reported: String?

    init?(context: HerdrAttach, session: Session) {
        guard let identity = session.agentIdentity?.lowercased(), !identity.isEmpty else { return nil }
        self.context = context; self.session = session
        agent = identity == "claude-code" ? "claude" : identity
    }

    func start() {
        monitor = Task { [weak self] in await self?.run() }
    }

    func stop() async {
        monitor?.cancel()
        await monitor?.value
        monitor = nil
        if reported != nil { await release() }
        _ = await command(["pane", "report-metadata", context.pane, "--source", "custom:orc",
                           "--clear-title", "--clear-display-agent", "--clear-token", "orc_session",
                           "--clear-token", "orc_project"])
    }

    private func run() async {
        var lastMetadata = Date.distantPast
        while !Task.isCancelled {
            if Date().timeIntervalSince(lastMetadata) >= 5 {
                await metadata()
                lastMetadata = Date()
            }
            await updateStatus()
            if Task.isCancelled { break }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    private func metadata() async {
        let project = URL(fileURLWithPath: session.worktreePath).lastPathComponent
        _ = await command(["pane", "report-metadata", context.pane, "--source", "custom:orc",
                           "--agent", agent, "--title", session.name,
                           "--display-agent", "\(agent) · \(session.name)",
                           "--token", "orc_session=\(session.name)", "--token", "orc_project=\(project)",
                           "--ttl-ms", "15000"])
    }

    private func updateStatus() async {
        let state: String?
        if let response = try? await LocalRPC.call("terminal.agentStatus", ["terminal": session.handle], timeout: 3),
           let status = response["agentStatus"] as? [String: Any],
           status["handle"] as? String == session.handle {
            let activity = AgentActivity(isRunningAgent: status["isRunningAgent"] as? Bool,
                                         state: status["status"] as? String)
            switch activity {
            case .active: state = "working"
            case .idle: state = "idle"
            case .needsAttention: state = "blocked"
            default: state = nil
            }
        } else { state = nil }
        if state == reported { return }
        if let state {
            if await command(["pane", "report-agent", context.pane, "--source", "custom:orc",
                              "--agent", agent, "--state", state]) { reported = state }
        } else if reported != nil { await release() }
    }

    private func release() async {
        if await command(["pane", "release-agent", context.pane, "--source", "custom:orc", "--agent", agent]) {
            reported = nil
        }
    }

    private func command(_ args: [String]) async -> Bool {
        await HerdrAttach.command(binary: context.binary, arguments: args)
    }
}
