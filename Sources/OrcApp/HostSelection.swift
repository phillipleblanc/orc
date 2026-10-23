import AppKit
import OrcKit

/// The Mac whose sessions Orc shows: this Mac, or another one paired from the Host menu. Orc shows one at a time, chosen
/// when it starts; choosing another reopens Orc on it.
enum HostSelection {
    private static let key = "host"

    /// Uses the chosen host, before anything asks a runtime. A host forgotten since falls back to this Mac.
    static func apply(defaults: UserDefaults = .standard) {
        guard let id = defaults.string(forKey: key) else { return }
        do { RuntimeHost.use(.remote(try RemoteHosts.load(id))) }
        catch { defaults.removeObject(forKey: key) }
    }

    static var current: RemoteHost? { RuntimeHost.current.remote }

    /// The name of the Mac Orc shows.
    static var name: String { current?.name ?? (Host.current().localizedName ?? "This Mac") }

    /// A preference of Orc's own about the shown Mac's sessions, kept apart for each host.
    static func defaultsKey(_ base: String) -> String {
        current.map { "host.\($0.id).\(base)" } ?? base
    }

    /// Reopens Orc on `host`, or on this Mac.
    static func switchTo(_ host: RemoteHost?, defaults: UserDefaults = .standard) {
        defaults.set(host?.id, forKey: key)
        relaunch()
    }

    /// Opens Orc again once this process has quit. Development overrides of Orc's folders carry over.
    private static func relaunch() {
        let pid = ProcessInfo.processInfo.processIdentifier
        let overrides = ProcessInfo.processInfo.environment.filter { $0.key.hasPrefix("ORC_") }.sorted { $0.key < $1.key }
        let environment = overrides.flatMap { ["--env", "\($0.key)=\($0.value)"] }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "while kill -0 \(pid) 2>/dev/null; do sleep 0.1; done; exec /usr/bin/open -n \"$@\"", "orc-relaunch"]
            + environment + [Bundle.main.bundlePath]
        try? process.run()
        NSApp.terminate(nil)
    }
}
