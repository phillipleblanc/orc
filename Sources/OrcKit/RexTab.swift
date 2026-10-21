import Foundation

/// The Rex tab a command runs in, as Rex's own CLI describes it.
public struct RexTab {
    public let session: String
    public let window: String
    public let label: String
    public let server: String?

    /// Rex's `rex` command: the one a Rex terminal names in REX_BIN_DIR, else the first on PATH.
    public static func command(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> String? {
        let directories = [environment["REX_BIN_DIR"]].compactMap { $0 } + (environment["PATH"] ?? "").split(separator: ":").map(String.init)
        return directories.map { URL(fileURLWithPath: $0).appendingPathComponent("rex").path }
            .first { $0.hasPrefix("/") && FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// The tab this process runs in, or nil outside a Rex terminal or when Rex does not answer.
    public static func current(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> RexTab? {
        guard environment["REX_BLOCK"] != nil, let rex = command(environment) else { return nil }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: rex)
        process.arguments = ["--autostart=false", "--timeout", "3s"] + (environment["REX_SERVER"].map { ["-S", $0] } ?? []) + ["window", "inspect", "--json"]
        let output = Pipe()
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0, let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let session = object["session_id"] as? String, let window = object["window_id"] as? String else { return nil }
        return RexTab(session: session, window: window, label: object["label"] as? String ?? "", server: environment["REX_SERVER"])
    }

    /// The name someone gave the tab, or nil for Rex's own (`Window` and eight hex digits).
    public var name: String? {
        let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.range(of: "^Window [0-9a-f]{8}$", options: .regularExpression) == nil else { return nil }
        return trimmed
    }

    var parameters: [String: Any] { ["session": session, "window": window, "server": server ?? NSNull()] }
}
