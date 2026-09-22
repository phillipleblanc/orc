import XCTest
@testable import OrcKit

final class LiveRuntimeTests: XCTestCase {
    /// Run only against a disposable Orca --serve profile, never the daily driver.
    @MainActor func testMobileControlAndDesktopCoexistence() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["ORC_LIVE_TESTS"] == "1", env["ORCA_USER_DATA_PATH"] != nil,
              env["ORC_CONFIG_DIR"] != nil, let worktree = env["ORC_TEST_WORKTREE"] else {
            throw XCTSkip("Set ORC_LIVE_TESTS=1 and isolated Orca/Orc profiles to run live integration tests.")
        }
        let daily = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/orca").standardizedFileURL
        guard RuntimeMetadata.directory.standardizedFileURL != daily else { throw OrcError("Live tests refuse the daily Orca profile.") }
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
