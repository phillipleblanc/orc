import XCTest
@testable import OrcKit

final class RexTabTests: XCTestCase {
    func testATabsNameIsWhatSomeoneNamedItNotRexsDefault() {
        let tab = { (label: String) in RexTab(session: "session:s", window: "window:w", label: label, server: nil).name }
        XCTAssertEqual(tab("fix-login-bug"), "fix-login-bug")
        XCTAssertEqual(tab("  review  "), "review")
        XCTAssertNil(tab("Window 82fe6476"))
        XCTAssertNil(tab(""))
        XCTAssertEqual(tab("Window 82fe647"), "Window 82fe647", "only Rex's own label pattern is unnamed")
    }

    func testTheCurrentTabComesFromRexsCLIInTheRexTerminal() throws {
        let root = URL(fileURLWithPath: "/tmp/orc-rex-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let rex = root.appendingPathComponent("rex"), calls = root.appendingPathComponent("calls")
        try """
        #!/bin/sh
        echo "$@" > '\(calls.path)'
        echo '{"session_id": "session:1", "window_id": "window:2", "label": "fix-login-bug"}'
        """.write(to: rex, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: rex.path)
        let environment = ["REX_BLOCK": "block:3", "REX_BIN_DIR": root.path, "REX_SERVER": "unix:///tmp/rex.sock", "PATH": "/usr/bin:/bin"]
        let tab = try XCTUnwrap(RexTab.current(environment))
        XCTAssertEqual([tab.session, tab.window, tab.name, tab.server], ["session:1", "window:2", "fix-login-bug", "unix:///tmp/rex.sock"])
        XCTAssertEqual(try String(contentsOf: calls, encoding: .utf8), "--autostart=false --timeout 3s -S unix:///tmp/rex.sock window inspect --json\n")
        XCTAssertNil(RexTab.current(environment.filter { $0.key != "REX_BLOCK" }), "outside a Rex terminal there is no tab")
    }
}
