import AppKit
import CGhostty
import XCTest
import OrcKit
@testable import OrcApp

final class GhosttySettingsTests: XCTestCase {
    private var root: URL!
    private var previous: [String: String?] = [:]

    /// The developer's own Ghostty configuration would load after the fixture, so both the
    /// configuration directory and the home directory point into the fixture.
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("orc-ghostty-settings-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("ghostty"), withIntermediateDirectories: true)
        for key in ["XDG_CONFIG_HOME", "HOME"] { previous[key] = ProcessInfo.processInfo.environment[key] }
        setenv("XDG_CONFIG_HOME", root.path, 1)
        setenv("HOME", root.path, 1)
    }

    override func tearDownWithError() throws {
        for (key, value) in previous { if let value { setenv(key, value, 1) } else { unsetenv(key) } }
        try? FileManager.default.removeItem(at: root)
    }

    private func writeGhosttyConfig(_ text: String) throws {
        try Data(text.utf8).write(to: root.appendingPathComponent("ghostty/config"))
    }

    private func string(_ key: String, in config: ghostty_config_t) -> String? {
        var value: UnsafePointer<CChar>?
        guard ghostty_config_get(config, &value, key, UInt(key.utf8.count)), let value else { return nil }
        return String(cString: value)
    }

    @MainActor func testUserGhosttySettingsApplyAndOrcsRequiredSettingsWin() throws {
        _ = GhosttyEngine.shared
        try writeGhosttyConfig("font-size = 17\nconfirm-close-surface = always\nshell-integration = zsh\n")
        let config = try XCTUnwrap(GhosttyEngine.makeConfig(usingGhosttySettings: true))
        defer { ghostty_config_free(config) }
        var fontSize: Float = 0
        XCTAssertTrue(ghostty_config_get(config, &fontSize, "font-size", UInt("font-size".utf8.count)))
        XCTAssertEqual(fontSize, 17)
        XCTAssertEqual(string("confirm-close-surface", in: config), "false")
        XCTAssertEqual(string("shell-integration", in: config), "none")
    }

    /// Ghostty 1.3.1 rebuilds a new terminal's configuration from the files when its light/dark theme
    /// does not match the app's appearance, which drops the command the terminal was given. The
    /// appearance changes after the configuration was applied, and only then is a terminal created.
    @MainActor func testLightDarkThemeKeepsTheTerminalsCommandAcrossAnAppearanceChange() async throws {
        _ = NSApplication.shared
        let engine = GhosttyEngine.shared
        // Themes given by absolute path, so the test does not depend on where libghostty looks for themes.
        let light = root.appendingPathComponent("light-theme"), dark = root.appendingPathComponent("dark-theme")
        try Data("background = ffffff\nforeground = 000000\n".utf8).write(to: light)
        try Data("background = 000000\nforeground = ffffff\n".utf8).write(to: dark)
        try writeGhosttyConfig("theme = light:\(light.path),dark:\(dark.path)\n")
        let probe = try XCTUnwrap(GhosttyEngine.makeConfig(usingGhosttySettings: true))
        XCTAssertEqual(ghostty_config_diagnostics_count(probe), 0, "the light and dark themes must load for this test to mean anything")
        ghostty_config_free(probe)
        // Start light, whatever the system appearance, then load the configuration.
        NSApp.appearance = NSAppearance(named: .aqua)
        engine.applyColorScheme()
        engine.reload(using: GhosttyEngine.makeConfig(usingGhosttySettings: true))
        defer { NSApp.appearance = nil; engine.reload() }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        engine.applyColorScheme()

        let marker = root.appendingPathComponent("ran")
        let session: Session = try decode(["handle": "theme-fixture", "worktreeId": "fixture", "worktreePath": root.path,
                                           "connected": false, "writable": false])
        let terminal = GhosttyView(session: session, command: "printf ran > " + shellQuote(marker.path) + "; sleep 30")
        let window = NSWindow(contentRect: NSRect(x: 150, y: 150, width: 600, height: 360), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = terminal
        window.makeKeyAndOrderFront(nil)
        defer { terminal.detach(); window.close() }
        let deadline = Date().addingTimeInterval(10)
        while !FileManager.default.fileExists(atPath: marker.path), Date() < deadline { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path), "The terminal ran a shell instead of its command")
    }

    @MainActor func testWindowIsTranslucentOnlyWhileShowingATranslucentTerminal() throws {
        _ = NSApplication.shared
        let engine = GhosttyEngine.shared
        defer { engine.reload() }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }

        try writeGhosttyConfig("background-opacity = 0.8\nbackground-blur = 20\n")
        engine.reload(using: GhosttyEngine.makeConfig(usingGhosttySettings: true))
        XCTAssertEqual(engine.backgroundOpacity, 0.8, accuracy: 0.0001)
        engine.applyWindowBackground(window, showingTerminal: true)
        XCTAssertFalse(window.isOpaque)
        XCTAssertLessThan(window.backgroundColor.alphaComponent, 0.01)
        engine.applyWindowBackground(window, showingTerminal: false)
        XCTAssertTrue(window.isOpaque)
        XCTAssertEqual(window.backgroundColor, .windowBackgroundColor)

        try writeGhosttyConfig("background-opacity = 1\n")
        engine.reload(using: GhosttyEngine.makeConfig(usingGhosttySettings: true))
        XCTAssertEqual(engine.backgroundOpacity, 1)
        engine.applyWindowBackground(window, showingTerminal: true)
        XCTAssertTrue(window.isOpaque)
    }
}
