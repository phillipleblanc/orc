import AppKit
import SwiftUI
import WebKit
import XCTest
import OrcKit
@testable import OrcApp

final class RemoteWorkbenchTests: XCTestCase {
    @MainActor func testWorkbenchFilesComeFromItsFoldersOnly() {
        let frontend = URL(fileURLWithPath: "/Orc.app/Contents/Resources/Runtime/frontend")
        func file(_ path: String) -> String? { WorkbenchFiles.file(for: path, in: frontend)?.path }
        XCTAssertEqual(file("/chat/workbench/"), frontend.path + "/src/chat/workbench/index.html")
        XCTAssertEqual(file("/chat/shared/agent.js"), frontend.path + "/src/chat/shared/agent.js")
        XCTAssertEqual(file("/chat/vendor/marked.js"), frontend.path + "/build/chat-vendor/marked.js")
        XCTAssertEqual(file("/chat/vendor/diffs/chunks/swift.js"), frontend.path + "/build/chat-vendor/chunks/swift.js")
        for outside in ["/chat/../src/main.ts", "/chat/vendor/../../src/main.ts", "/chat/vendor/diffs/../../../package.json", "/main.ts"] {
            XCTAssertNil(file(outside), outside)
        }
    }

    /// The disposable runtime stands in for another Mac, with a durable agent on the worker's scripted model.
    @MainActor func testAnotherMacsDurableAgentOpensInThisMacsWorkbench() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["ORC_LIVE_TESTS"] == "1", env["ORC_RUNTIME_DIR"] != nil, env["ORC_CONFIG_DIR"] != nil, let worktree = env["ORC_TEST_WORKTREE"] else {
            throw XCTSkip("Set ORC_LIVE_TESTS=1 with a disposable ORC_RUNTIME_DIR and ORC_CONFIG_DIR to run live integration tests.")
        }
        let daily = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/orc/runtime").standardizedFileURL
        guard RuntimeMetadata.directory.standardizedFileURL != daily else { throw OrcError("Live tests refuse the daily runtime profile.") }
        guard WorkbenchFiles.frontend != nil else { throw XCTSkip("The runtime's frontend is not beside this build.") }
        _ = NSApplication.shared

        let name = "orc-dur-" + UUID().uuidString.prefix(8)
        _ = try await LocalRPC.call("agent.spawn", ["agent": "durable", "name": name, "cwd": worktree, "prompt": "markdown", "args": ["--faux"]], timeout: 60)
        do { try await converse(with: name) } catch {
            RuntimeHost.use(.local)
            _ = try? await LocalRPC.call("terminal.close", ["terminal": name])
            throw error
        }
        RuntimeHost.use(.local)
        _ = try await LocalRPC.call("terminal.close", ["terminal": name])
    }

    @MainActor private func converse(with name: String) async throws {
        _ = try await LocalRPC.call("agent.wait", ["name": name, "timeoutMs": 20_000], timeout: 30)
        let paired = try await LocalRPC.call("slim.pairing.create", ["scope": "runtime", "name": "Workbench test viewer"])
        let link = try XCTUnwrap(paired["link"] as? String)
        let host = try await RemoteHosts.verify(link: link, name: "Live host")
        RuntimeHost.use(.remote(host))

        let model = DurableChatModel()
        await model.load(name)
        let url = try XCTUnwrap(model.url, model.error ?? "no Workbench address")
        XCTAssertEqual(url.scheme, WorkbenchFiles.scheme)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: DurableChatWebView(url: url) {})
        // On screen and above other windows: WebKit pauses the Workbench's animation frames, which draw its updates, in a
        // window nobody can see.
        window.level = .floating
        window.center()
        window.orderFrontRegardless()
        defer { window.close() }
        func web() -> WKWebView? { descendant(WKWebView.self, in: window.contentView) }
        func log() async -> String { ((try? await web()?.evaluateJavaScript("document.getElementById('log')?.textContent ?? ''")) as? String) ?? "" }
        func until(_ label: String, _ condition: () async -> Bool) async throws {
            let deadline = Date().addingTimeInterval(20)
            while !(await condition()) {
                guard Date() < deadline else {
                    let page = try? await web()?.evaluateJavaScript("JSON.stringify({ relay: typeof window.orcRelay, name: document.getElementById('tb-name')?.textContent, state: document.getElementById('tb-state')?.textContent, banner: document.getElementById('banner')?.hidden ? '' : document.getElementById('banner-text')?.textContent, location: location.href, input: document.getElementById('input')?.value, sendDisabled: document.getElementById('send')?.disabled, toasts: document.getElementById('toasts')?.textContent, log: (document.getElementById('log')?.textContent ?? '').slice(-300) })")
                    XCTFail("Timed out waiting for \(label); the page: \(page as? String ?? "unreadable")")
                    throw OrcError("Timed out")
                }
                try await Task.sleep(for: .milliseconds(100))
            }
        }
        try await until("the conversation") { await log().contains("Summary") }
        _ = try await web()?.evaluateJavaScript("""
            const input = document.getElementById('input'); input.value = 'from the other Mac';
            input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('send').click(); true
            """)
        // The agent on the other Mac answers the message sent here. Updates draw on animation frames, which WebKit
        // pauses while the display sleeps, so the answer is read back by loading the page again.
        try await until("the agent's answer") {
            (try? await LocalRPC.call("agent.status", ["name": name]))?["lastAssistantMessage"] as? String == "echo: from the other Mac"
        }
        web()?.reload()
        try await until("the answer, shown") { await log().contains("echo: from the other Mac") }
    }

    @MainActor private func descendant<T: NSView>(_ type: T.Type, in view: NSView?) -> T? {
        guard let view else { return nil }
        if let found = view as? T { return found }
        return view.subviews.lazy.compactMap { self.descendant(type, in: $0) }.first
    }
}
