import AppKit
import Foundation
import Darwin

// Run through probe-orca-runtime.py, which verifies the candidate before launch.
// Only a fresh private profile is used. Runtime output stays in its private log.
struct ProbeError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

func probe(app: URL, report: URL, python: URL, checker: String) throws -> Bool {
    let fm = FileManager.default
    let executable = app.appendingPathComponent("Contents/Helpers/Orca.app/Contents/MacOS/Orca").resolvingSymlinksInPath()
    let cli = app.appendingPathComponent("Contents/Resources/orc")
    let work = URL(fileURLWithPath: "/tmp/orc-spike-" + UUID().uuidString)
    try fm.createDirectory(at: work, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    let profile = work.appendingPathComponent("profile")
    let configuration = work.appendingPathComponent("client")
    let metadata = profile.appendingPathComponent("orca-runtime.json")
    let origin = try JSONSerialization.jsonObject(with: Data(contentsOf: app.appendingPathComponent("Contents/Resources/orca-runtime-origin.json"))) as? [String: Any]
    if origin?["kind"] as? String == "source" {
        let lock = try JSONSerialization.jsonObject(with: Data(contentsOf: app.appendingPathComponent("Contents/Resources/orca-runtime-lock.json"))) as? [String: Any]
        guard let sourceBuild = lock?["sourceBuild"] as? [String: Any], let bundle = sourceBuild["bundle"] as? [String: Any],
              let identifier = bundle["identifier"] as? String, let version = bundle["version"] as? String else {
            throw ProbeError("Missing source runtime identity.")
        }
        try fm.createDirectory(at: profile, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let marker = profile.appendingPathComponent("orc-runtime-profile.json")
        try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "bundleIdentifier": identifier, "runtimeVersion": version]).write(to: marker, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: marker.path)
    }
    let started = ProcessInfo.processInfo.systemUptime
    var policies = Set<Int>()
    var samples = 0
    var transitions: [[String: Any]] = []
    var observed: [pid_t: NSRunningApplication] = [:]
    var observations: [pid_t: NSKeyValueObservation] = [:]
    var probePassed = false

    func record(_ running: NSRunningApplication) {
        let policy = running.activationPolicy.rawValue
        policies.insert(policy)
        if transitions.last?["policy"] as? Int != policy {
            transitions.append(["seconds": ProcessInfo.processInfo.systemUptime - started, "policy": policy])
        }
    }
    func inspect(_ running: NSRunningApplication) {
        guard running.executableURL?.resolvingSymlinksInPath() == executable else { return }
        samples += 1
        record(running)
        let pid = running.processIdentifier
        if observed[pid] == nil {
            observed[pid] = running
            observations[pid] = running.observe(\.activationPolicy, options: [.new]) { changed, _ in
                record(changed)
            }
        }
    }
    guard !NSWorkspace.shared.runningApplications.contains(where: {
        $0.executableURL?.resolvingSymlinksInPath() == executable
    }) else { throw ProbeError("The candidate runtime is already running; use a fresh spike bundle.") }
    let notification = NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main
    ) { event in
        if let running = event.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { inspect(running) }
    }
    let timer = Timer.scheduledTimer(withTimeInterval: 0.005, repeats: true) { _ in
        NSWorkspace.shared.runningApplications.forEach(inspect)
    }
    func pump(until finished: () -> Bool, seconds: Double) -> Bool {
        let deadline = ProcessInfo.processInfo.systemUptime + seconds
        while !finished(), ProcessInfo.processInfo.systemUptime < deadline {
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.005))
        }
        return finished()
    }
    func ownedPIDs() -> Set<pid_t> {
        var records = [metadata]
        if let enumerator = fm.enumerator(at: configuration.appendingPathComponent("runtimes"), includingPropertiesForKeys: nil) {
            for case let file as URL in enumerator where file.lastPathComponent == "launch.json" { records.append(file) }
        }
        return Set(records.compactMap { file in
            guard let data = try? Data(contentsOf: file),
                  let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let pid = object["pid"] as? Int32, pid > 0 else { return nil }
            return pid
        })
    }
    // Only terminate processes recorded by this probe's fresh private profile.
    defer {
        timer.invalidate()
        NSWorkspace.shared.notificationCenter.removeObserver(notification)
        NSWorkspace.shared.runningApplications.forEach(inspect)
        observations.removeAll()
        let pids = ownedPIDs()
        let owned = observed.values.filter { pids.contains($0.processIdentifier) }
        for running in owned where !running.isTerminated {
            kill(running.processIdentifier, SIGTERM)
        }
        let stopped = pump(until: { owned.allSatisfy(\.isTerminated) }, seconds: 10)
        let hasUnobservedProcess = pids.contains { pid in kill(pid, 0) == 0 }
        if stopped && !hasUnobservedProcess && probePassed {
            try? fm.removeItem(at: work)
        } else {
            fputs("Probe failed or cleanup is incomplete; private diagnostics retained at \(work.path)\n", stderr)
        }
    }
    var environment = ProcessInfo.processInfo.environment.filter { key, _ in
        !key.hasPrefix("ORCA_") && !key.hasPrefix("ORC_") && !key.hasPrefix("ELECTRON_") &&
        key != "NODE_OPTIONS" && key != "NODE_REPL_EXTERNAL_MODULE"
    }
    environment["ORCA_APP_EXECUTABLE"] = executable.path
    environment["ORCA_USER_DATA_PATH"] = profile.path
    environment["ORC_CONFIG_DIR"] = configuration.path

    func invoke(_ environment: [String: String]) throws -> Bool {
        let process = Process()
        process.executableURL = cli
        process.arguments = ["status", "--json"]
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        guard pump(until: { !process.isRunning }, seconds: 55) else {
            process.terminate()
            _ = pump(until: { !process.isRunning }, seconds: 5)
            throw ProbeError("The startup CLI timed out.")
        }
        return process.terminationStatus == 0
    }
    func identity() -> (Int, String)? {
        guard let data = try? Data(contentsOf: metadata),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let pid = object["pid"] as? Int, let id = object["runtimeId"] as? String else { return nil }
        return (pid, id)
    }

    let ready = try invoke(environment)
    let startupSeconds = ProcessInfo.processInfo.systemUptime - started
    let initialIdentity = identity()
    let holdUntil = ProcessInfo.processInfo.systemUptime + 2
    _ = pump(until: { ProcessInfo.processInfo.systemUptime >= holdUntil }, seconds: 3)
    // An invalid override makes an accidental second launch fail instead of
    // making a dead runtime appear to have survived its first client.
    environment["ORCA_APP_EXECUTABLE"] = work.appendingPathComponent("missing-Orca").path
    let reconnected = ready ? try invoke(environment) : false
    var updatesDisabled = false
    if reconnected && origin?["kind"] as? String == "source" {
        let check = Process()
        check.executableURL = python
        check.arguments = [checker, "--check-updates", profile.path]
        check.standardInput = FileHandle.nullDevice
        check.standardOutput = FileHandle.nullDevice
        check.standardError = FileHandle.nullDevice
        try check.run()
        if pump(until: { !check.isRunning }, seconds: 25) {
            updatesDisabled = check.terminationStatus == 0
        } else {
            check.terminate()
        }
    }
    let finalIdentity = identity()
    let sameRuntime = initialIdentity != nil && initialIdentity?.0 == finalIdentity?.0 && initialIdentity?.1 == finalIdentity?.1
    let accessoryOnly = policies.contains(NSApplication.ActivationPolicy.accessory.rawValue) &&
        !policies.contains(NSApplication.ActivationPolicy.regular.rawValue)
    let passed = ready && reconnected && sameRuntime && accessoryOnly && observed.count == 1 &&
        (origin?["kind"] as? String != "source" || updatesDisabled)
    let result: [String: Any] = [
        "schemaVersion": 1, "passed": passed, "startupSeconds": startupSeconds,
        "authenticatedStatus": ready, "survivesCLIExit": reconnected && sameRuntime,
        "observedRuntimeCount": observed.count, "activationPolicySamples": samples,
        "activationPolicies": policies.sorted(), "activationTransitions": transitions,
        "regularActivationObserved": policies.contains(NSApplication.ActivationPolicy.regular.rawValue),
        "accessoryOnly": accessoryOnly,
        "runtimeUpdatesDisabled": updatesDisabled,
        "observation": "NSWorkspace launch notification, activationPolicy KVO and 5 ms polling; visual cold-start verification is also required."
    ]
    try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]).write(to: report, options: .atomic)
    probePassed = passed
    return passed
}

do {
    guard CommandLine.arguments.count == 5 else { throw ProbeError("Expected a staged Orc.app, report, Python executable and checker.") }
    let passed = try probe(app: URL(fileURLWithPath: CommandLine.arguments[1]), report: URL(fileURLWithPath: CommandLine.arguments[2]),
                           python: URL(fileURLWithPath: CommandLine.arguments[3]), checker: CommandLine.arguments[4])
    exit(passed ? 0 : 1)
} catch {
    fputs("Runtime probe: \(error)\n", stderr)
    exit(2)
}
