import XCTest
@testable import OrcKit

final class LiveRuntimeTests: XCTestCase {
    private func isolatedWorktree() throws -> String {
        let env = ProcessInfo.processInfo.environment
        guard env["ORC_LIVE_TESTS"] == "1", env["ORCA_USER_DATA_PATH"] != nil,
              env["ORC_CONFIG_DIR"] != nil, let worktree = env["ORC_TEST_WORKTREE"] else {
            throw XCTSkip("Set ORC_LIVE_TESTS=1 and isolated Orca/Orc profiles to run live integration tests.")
        }
        let daily = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/orca").standardizedFileURL
        guard RuntimeMetadata.directory.standardizedFileURL != daily else { throw OrcError("Live tests refuse the daily Orca profile.") }
        return worktree
    }
    @MainActor func testRenamePreservesSessionAndRejectsDuplicates() async throws {
        let worktree = try isolatedWorktree()
        let service = SessionService()
        let suffix = UUID().uuidString
        var handles: [String] = []
        do {
            let first = try await service.create(name: "rename-first-" + suffix, worktree: "path:" + worktree, command: nil)
            handles.append(first)
            let second = try await service.create(name: "rename-second-" + suffix, worktree: "path:" + worktree, command: nil)
            handles.append(second)
            let before = try await service.list().terminals.first { $0.handle == first }
            let name = "renamed-한글-" + suffix
            try await service.rename(handle: first, name: name)
            let after = try await service.list().terminals.first { $0.name == name }
            XCTAssertEqual(after?.handle, first)
            XCTAssertEqual(after?.incarnationId, before?.incarnationId)
            XCTAssertEqual(after?.attachCommand, before?.attachCommand)
            XCTAssertEqual(after?.connected, true)
            do {
                try await service.rename(handle: first, name: "rename-second-" + suffix)
                XCTFail("Duplicate name should be rejected")
            } catch { XCTAssertTrue(error.localizedDescription.contains("already exists")) }
            do {
                try await service.rename(handle: first, name: "bad\u{1b}[31m")
                XCTFail("Control characters should be rejected")
            } catch { XCTAssertTrue(error.localizedDescription.contains("control characters")) }
            let unchanged = try await service.list().terminals.first { $0.handle == first }
            XCTAssertEqual(unchanged?.name, name)
        } catch {
            for handle in handles { _ = try? await LocalRPC.call("terminal.close", ["terminal": handle]) }
            throw error
        }
        for handle in handles { _ = try await LocalRPC.call("terminal.close", ["terminal": handle]) }
    }
    @MainActor func testNativeChatTranscriptStreamingAndGuardedInput() async throws {
        let worktree = try isolatedWorktree()
        let sessionID = UUID().uuidString
        let file = RuntimeMetadata.directory.appendingPathComponent("orc-chat-test-" + sessionID + ".jsonl")
        defer { try? FileManager.default.removeItem(at: file) }
        func record(_ id: String, _ role: String, _ text: String) throws -> Data {
            var data = try jsonData(["type": role, "uuid": id, "sessionId": sessionID,
                "timestamp": "2026-01-01T00:00:00Z", "message": ["role": role, "content": [["type": "text", "text": text]]]])
            data.append(10); return data
        }
        var bytes = try record("user-1", "user", "Hello")
        bytes += try record("assistant-1", "assistant", "First reply")
        try bytes.write(to: file)
        let params: [String: Any] = ["agent": "claude", "sessionId": sessionID, "transcriptPath": file.path, "limit": 1]
        let page = try await LocalRPC.call("nativeChat.readSession", params)
        XCTAssertNil(page["error"])
        XCTAssertEqual((page["messages"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual(page["hasMore"] as? Bool, true)
        var earlierParams = params
        earlierParams["beforeOffset"] = try XCTUnwrap(page["beforeOffset"])
        let earlier = try await LocalRPC.call("nativeChat.readSession", earlierParams)
        XCTAssertEqual((earlier["messages"] as? [[String: Any]])?.first?["role"] as? String, "user")

        let connection = try StreamConnection(pairing: Pairing.load())
        defer { connection.close() }
        try await connection.connect()
        let tabs = expectation(description: "Session inventory stream")
        let initial = expectation(description: "Native chat snapshot")
        let appended = expectation(description: "Live transcript append")
        var gotTabs = false, gotInitial = false, gotAppend = false
        connection.onStreamEvent = { id, event in
            if id == "test-tabs", !gotTabs { gotTabs = true; tabs.fulfill() }
            if id == "test-chat", event["type"] as? String == "snapshot", !gotInitial {
                gotInitial = true; initial.fulfill()
            }
            if id == "test-chat", event["type"] as? String == "appended",
               (event["messages"] as? [[String: Any]])?.contains(where: { $0["id"] as? String == "assistant-2" }) == true,
               !gotAppend { gotAppend = true; appended.fulfill() }
        }
        try await connection.subscribe("session.tabs.subscribe", ["worktree": "path:" + worktree], id: "test-tabs")
        var streamingParams = params; streamingParams["subscriptionId"] = "test-chat"
        try await connection.subscribe("nativeChat.subscribe", streamingParams, id: "test-chat")
        await fulfillment(of: [tabs, initial], timeout: 15)
        let output = try FileHandle(forWritingTo: file)
        try output.seekToEnd()
        try output.write(contentsOf: record("assistant-2", "assistant", "Streamed reply"))
        try output.close()
        await fulfillment(of: [appended], timeout: 15)
        _ = try await connection.request("nativeChat.unsubscribe", ["subscriptionId": "test-chat"])

        let handle = try await SessionService().create(name: "orc-chat-guard-" + sessionID, worktree: "path:" + worktree, command: nil)
        do {
            let target = try XCTUnwrap(ChatTarget(tab: ["type": "terminal", "terminal": handle,
                "agentStatus": ["agentType": "codex", "state": "done", "providerSession": ["id": "stale-provider"]]]))
            do {
                try await ChatWriter.send("echo ORC_MUST_NOT_EXECUTE", target: target, connection: connection, clientID: "orc-test-chat")
                XCTFail("A shell must refuse input even when a cached agent status says it is sendable")
            } catch { XCTAssertTrue(error.localizedDescription.contains("refused")) }
            let terminal = try await LocalRPC.call("terminal.read", ["terminal": handle, "lines": 30])
            XCTAssertFalse(String(decoding: try jsonData(terminal), as: UTF8.self).contains("ORC_MUST_NOT_EXECUTE"))
        } catch { _ = try? await LocalRPC.call("terminal.close", ["terminal": handle]); throw error }
        _ = try await LocalRPC.call("terminal.close", ["terminal": handle])
    }
    /// Run only against a disposable Orca --serve profile, never the daily driver.
    @MainActor func testPiTranscriptThroughOmpDecoder() async throws {
        _ = try isolatedWorktree()
        let sessionID = UUID().uuidString
        let file = RuntimeMetadata.directory.appendingPathComponent("orc-pi-test-" + sessionID + ".jsonl")
        defer { try? FileManager.default.removeItem(at: file) }
        func record(_ value: [String: Any]) throws -> Data {
            var bytes = try jsonData(value); bytes.append(10); return bytes
        }
        func message(_ id: String, _ parent: String?, _ role: String, _ content: Any, isError: Bool = false) throws -> Data {
            try record(["type": "message", "id": id, "parentId": parent as Any? ?? NSNull(),
                        "timestamp": "2026-01-01T00:00:00Z",
                        "message": ["role": role, "content": content, "isError": isError]])
        }
        var bytes = try record(["type": "session", "version": 3, "id": sessionID, "cwd": "/test"])
        bytes += try message("pi-user", nil, "user", [["type": "text", "text": "Read 한글.txt"]])
        bytes += try message("pi-call", "pi-user", "assistant", [
            ["type": "thinking", "thinking": "Inspect the file"],
            ["type": "toolCall", "id": "call-1", "name": "read", "arguments": ["path": "한글.txt"]]])
        bytes += try message("pi-result", "pi-call", "toolResult", [["type": "text", "text": "File unavailable"]], isError: true)
        bytes += try record(["type": "compaction", "id": "bookkeeping", "summary": "Hidden bookkeeping"])
        try bytes.write(to: file)

        let target = try XCTUnwrap(ChatTarget(tab: ["type": "terminal", "terminal": "term_pi_fixture", "agentStatus": [
            "agentType": "pi", "state": "done", "providerSession": ["id": sessionID, "transcriptPath": file.path]]]))
        XCTAssertEqual(target.agent, "pi")
        var params = target.params; params["limit"] = 2
        let page = try await LocalRPC.call("nativeChat.readSession", params)
        XCTAssertNil(page["error"])
        let messages = (page["messages"] as? [[String: Any]] ?? []).compactMap(ChatMessage.init)
        XCTAssertEqual(messages.map(\.id), ["pi-call", "pi-result"])
        XCTAssertEqual(messages.first?.blocks.map(\.type), ["text", "tool-call"])
        XCTAssertTrue(messages.first?.blocks.last?.body.contains("한글.txt") == true)
        XCTAssertEqual(messages.last?.role, "tool")
        XCTAssertEqual(messages.last?.blocks.first?.isError, true)
        XCTAssertEqual(page["hasMore"] as? Bool, true)
        var earlier = params; earlier["beforeOffset"] = try XCTUnwrap(page["beforeOffset"])
        let previous = try await LocalRPC.call("nativeChat.readSession", earlier)
        XCTAssertEqual((previous["messages"] as? [[String: Any]])?.map { $0["id"] as? String }, ["pi-user"])

        let connection = try StreamConnection(pairing: Pairing.load())
        defer { connection.close() }
        try await connection.connect()
        let initial = expectation(description: "Pi history arrives through the OMP subscription")
        let appended = expectation(description: "Pi reply arrives as a live transcript append")
        var gotInitial = false, gotAppend = false
        connection.onStreamEvent = { id, event in
            guard id == "pi-chat" else { return }
            let messages = (event["messages"] as? [[String: Any]] ?? []).compactMap(ChatMessage.init)
            if event["type"] as? String == "snapshot", !gotInitial {
                XCTAssertNil(event["error"])
                XCTAssertEqual(messages.map(\.id), ["pi-call", "pi-result"])
                gotInitial = true; initial.fulfill()
            }
            if event["type"] as? String == "appended", messages.contains(where: { $0.id == "pi-reply" }), !gotAppend {
                XCTAssertEqual(messages.last?.blocks.last?.body, "Pi live reply")
                gotAppend = true; appended.fulfill()
            }
        }
        params["subscriptionId"] = "pi-chat"
        try await connection.subscribe("nativeChat.subscribe", params, id: "pi-chat")
        await fulfillment(of: [initial], timeout: 15)
        guard gotInitial else { return }
        let output = try FileHandle(forWritingTo: file)
        try output.seekToEnd()
        try output.write(contentsOf: message("pi-reply", "pi-result", "assistant", [["type": "text", "text": "Pi live reply"]]))
        try output.close()
        await fulfillment(of: [appended], timeout: 15)
        _ = try await connection.request("nativeChat.unsubscribe", ["subscriptionId": "pi-chat"])
    }

    /// Run only against a disposable Orca --serve profile, never the daily driver.
    @MainActor func testMobileControlAndDesktopCoexistence() async throws {
        let worktree = try isolatedWorktree()
        let pairing = try Pairing.load()
        let handle = try await SessionService().create(name: "orc-mobile-test-" + UUID().uuidString,
                                                       worktree: "path:" + worktree, command: nil)
        do {
            let desktop = try StreamConnection(pairing: pairing)
            let mobile = try StreamConnection(pairing: pairing)
            defer { desktop.close(); mobile.close() }
            try await desktop.connect(); try await mobile.connect()
            let desktopReady = expectation(description: "Desktop receives a complete snapshot")
            let mobileReady = expectation(description: "Mobile receives a complete snapshot")
            let desktopOutput = expectation(description: "Desktop sees mobile input")
            let mobileOutput = expectation(description: "Mobile sees its own input")
            var desktopSnapshot = false, mobileSnapshot = false
            var desktopStream: UInt32?
            var desktopBytes = Data(), mobileBytes = Data()
            var desktopSawOutput = false, mobileSawOutput = false
            func content(_ data: Data) -> Data {
                guard let frame = try? TerminalFrame(data: data) else { return Data() }
                if frame.opcode == 15, let value = try? jsonObject(frame.payload), let text = value["data"] as? String { return Data(text.utf8) }
                return [1, 3].contains(frame.opcode) ? frame.payload : Data()
            }
            desktop.onBinary = { data in
                desktopStream = try? TerminalFrame(data: data).streamID
                if (try? TerminalFrame(data: data).opcode) == 4 && !desktopSnapshot { desktopSnapshot = true; desktopReady.fulfill() }
                desktopBytes += content(data)
                let text = String(decoding: desktopBytes, as: UTF8.self)
                if !desktopSawOutput, text.contains("__MOBILE_CONTROL__"), text.contains("__PHONE_SIZE_15 50") { desktopSawOutput = true; desktopOutput.fulfill() }
            }
            mobile.onBinary = { data in
                if (try? TerminalFrame(data: data).opcode) == 4 && !mobileSnapshot { mobileSnapshot = true; mobileReady.fulfill() }
                mobileBytes += content(data)
                let text = String(decoding: mobileBytes, as: UTF8.self)
                if !mobileSawOutput, text.contains("__MOBILE_CONTROL__"), text.contains("__PHONE_SIZE_15 50") { mobileSawOutput = true; mobileOutput.fulfill() }
            }
            let desktopClient: [String: String] = ["id": "orc-test-desktop-" + UUID().uuidString, "type": "desktop"]
            let mobileClient: [String: String] = ["id": pairing.deviceToken, "type": "mobile"]
            try await desktop.subscribe("terminal.subscribe", ["terminal": handle, "client": desktopClient,
                "viewport": ["cols": 100, "rows": 30], "capabilities": ["terminalBinaryStream": 1, "desktopViewportClaims": 1]])
            await fulfillment(of: [desktopReady], timeout: 15)
            try await mobile.subscribe("terminal.subscribe", ["terminal": handle, "client": mobileClient,
                "viewport": ["cols": 50, "rows": 15], "capabilities": ["terminalBinaryStream": 1]])
            await fulfillment(of: [mobileReady], timeout: 15)
            try await desktop.send(TerminalFrame(opcode: 14, streamID: XCTUnwrap(desktopStream), payload: jsonData(["cols": 110, "rows": 40])))
            let refused = try await desktop.request("terminal.send", ["terminal": handle, "client": desktopClient,
                "viewport": ["cols": 100, "rows": 30], "claimViewport": true, "text": "SHOULD_NOT_REACH_SHELL", "enter": false])
            XCTAssertEqual((refused["send"] as? [String: Any])?["accepted"] as? Bool, false)
            let accepted = try await mobile.request("terminal.send", ["terminal": handle, "client": mobileClient,
                "text": "printf '__MOBILE_%s__\\n' CONTROL; printf '__PHONE_SIZE_'; stty size", "enter": true])
            XCTAssertEqual((accepted["send"] as? [String: Any])?["accepted"] as? Bool, true)
            await fulfillment(of: [desktopOutput, mobileOutput], timeout: 15)
            XCTAssertFalse(String(decoding: mobileBytes, as: UTF8.self).contains("SHOULD_NOT_REACH_SHELL"))
        } catch {
            _ = try? await LocalRPC.call("terminal.close", ["terminal": handle]); throw error
        }
        _ = try await LocalRPC.call("terminal.close", ["terminal": handle])
    }
}
