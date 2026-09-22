import XCTest
@testable import OrcKit

final class LiveAgentChatTests: XCTestCase {
    /// Requires an explicitly supplied, disposable, already-authenticated agent.
    /// The provider identity is a fixture so transport tests do not depend on
    /// whether that Orca version publishes hooks through session.tabs.
    @MainActor func testRealAgentReplyThroughChatWriter() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["ORC_LIVE_AGENT_TESTS"] == "1", env["ORCA_USER_DATA_PATH"] != nil, env["ORC_CONFIG_DIR"] != nil,
              let handle = env["ORC_CHAT_TEST_HANDLE"], let providerFile = env["ORC_CHAT_TEST_PROVIDER_FILE"] else {
            throw XCTSkip("Set isolated profiles and an owned agent fixture to test a real model reply.")
        }
        let daily = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/orca").standardizedFileURL
        guard RuntimeMetadata.directory.standardizedFileURL != daily else { throw OrcError("Live agent tests refuse the daily Orca profile.") }
        let listing = try await SessionService().list()
        let session = try XCTUnwrap(listing.terminals.first { $0.handle == handle })
        guard session.name.hasPrefix("orc-chat-e2e") else { throw OrcError("Use a disposable orc-chat-e2e session.") }
        let provider = try jsonObject(Data(contentsOf: URL(fileURLWithPath: providerFile)))
        let target = try XCTUnwrap(ChatTarget(tab: ["type": "terminal", "terminal": handle,
            "agentStatus": ["agentType": "codex", "state": "done", "providerSession": provider]]))
        let connection = try StreamConnection(pairing: Pairing.load())
        defer { connection.close() }
        try await connection.connect()
        let initial = expectation(description: "Read actual provider transcript")
        let reply = expectation(description: "Agent replied to native chat input")
        var gotInitial = false, gotReply = false
        let marker = "ORC_CHAT_SEND_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        connection.onStreamEvent = { _, event in
            if event["type"] as? String == "snapshot", event["error"] == nil, !gotInitial {
                gotInitial = true; initial.fulfill()
            }
            let messages = (event["messages"] as? [[String: Any]] ?? []).compactMap(ChatMessage.init)
            if !gotReply, messages.contains(where: { $0.role == "assistant" && $0.blocks.contains(where: { $0.body.contains(marker) }) }) {
                gotReply = true; reply.fulfill()
            }
        }
        try await connection.subscribe("nativeChat.subscribe", target.params, id: "agent-test")
        await fulfillment(of: [initial], timeout: 15)
        try await ChatWriter.send("This is a UI smoke test. Do not use tools, read files, or change anything. Reply exactly " + marker,
                                  target: target, connection: connection, clientID: "orc-chat-e2e")
        await fulfillment(of: [reply], timeout: 120)
        guard gotReply else { return }
        let interrupted = expectation(description: "Stop interrupts without closing the terminal")
        var gotInterrupted = false
        connection.onStreamEvent = { _, event in
            let lifecycle = event["lifecycle"] as? [String: Any]
            if !gotInterrupted, lifecycle?["state"] as? String == "interrupted" {
                gotInterrupted = true; interrupted.fulfill()
            }
        }
        try await ChatWriter.send("This is another UI test. Do not use tools or read files. Count upwards from one to five hundred, one number per line.",
                                  target: target, connection: connection, clientID: "orc-chat-e2e")
        try await Task.sleep(for: .milliseconds(1500))
        let working = try XCTUnwrap(ChatTarget(tab: ["type": "terminal", "terminal": handle,
            "agentStatus": ["agentType": "codex", "state": "working", "providerSession": provider]]))
        try await ChatWriter.stop(target: working, connection: connection, clientID: "orc-chat-e2e")
        await fulfillment(of: [interrupted], timeout: 15)
        let afterStop = try await connection.request("terminal.agentStatus", ["terminal": handle])
        XCTAssertEqual((afterStop["agentStatus"] as? [String: Any])?["isRunningAgent"] as? Bool, true)
    }
}
