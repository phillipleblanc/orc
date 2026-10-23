import XCTest
@testable import OrcKit

final class LiveRuntimeTests: XCTestCase {
    private func isolatedWorktree() throws -> String {
        let env = ProcessInfo.processInfo.environment
        guard env["ORC_LIVE_TESTS"] == "1", env["ORC_RUNTIME_DIR"] != nil,
              env["ORC_CONFIG_DIR"] != nil, let worktree = env["ORC_TEST_WORKTREE"] else {
            throw XCTSkip("Set ORC_LIVE_TESTS=1 with a disposable ORC_RUNTIME_DIR and ORC_CONFIG_DIR to run live integration tests.")
        }
        let daily = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/orc/runtime").standardizedFileURL
        guard RuntimeMetadata.directory.standardizedFileURL != daily else { throw OrcError("Live tests refuse the daily runtime profile.") }
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
    @MainActor func testCloseEndsTheSession() async throws {
        let worktree = try isolatedWorktree()
        let service = SessionService()
        let name = "orc-close-" + UUID().uuidString.prefix(8)
        let handle = try await service.create(name: name, worktree: "path:" + worktree, command: nil)
        do {
            try await service.close(handle: handle)
        } catch {
            _ = try? await LocalRPC.call("terminal.close", ["terminal": handle])
            throw error
        }
        let remaining = try await service.list().terminals
        XCTAssertFalse(remaining.contains { $0.handle == handle || $0.name == name })
        do {
            try await service.close(handle: handle)
            XCTFail("Closing an ended session should fail")
        } catch { XCTAssertTrue(error.localizedDescription.contains("no session"), error.localizedDescription) }
    }
    @MainActor func testChildSessionNameAppearsUnderParent() async throws {
        let worktree = try isolatedWorktree()
        let service = SessionService()
        // Session sockets live under the profile, so names stay short enough for macOS socket paths.
        let parentName = "orc-child-" + UUID().uuidString.prefix(8)
        var handles: [String] = []
        do {
            let parentHandle = try await service.create(name: parentName, worktree: "path:" + worktree, command: nil)
            handles.append(parentHandle)
            let initial = try await service.list().terminals
            let parent = try XCTUnwrap(initial.first { $0.handle == parentHandle })
            let childName = try SessionHierarchy.childName(parent: parent, suffix: "review")
            let childHandle = try await service.create(name: childName, worktree: "path:" + worktree, command: nil)
            handles.append(childHandle)
            let listing = try await service.list().terminals
            let child = try XCTUnwrap(listing.first { $0.handle == childHandle })
            let hierarchy = SessionHierarchy(sessions: listing)
            XCTAssertEqual(child.name, parentName + "-review")
            XCTAssertEqual(hierarchy.parent(of: child)?.handle, parentHandle)
            XCTAssertEqual(hierarchy.displayName(for: child), "review")
        } catch {
            for handle in handles { _ = try? await LocalRPC.call("terminal.close", ["terminal": handle]) }
            throw error
        }
        for handle in handles { _ = try await LocalRPC.call("terminal.close", ["terminal": handle]) }
    }
    /// The disposable runtime stands in for another Mac: Orc reaches it through the host its link saves, over its
    /// WebSocket, as Orc on that other Mac would.
    @MainActor func testAnotherMacsSessionsThroughTheHostItsLinkSaves() async throws {
        let worktree = try isolatedWorktree()
        let paired = try await LocalRPC.call("slim.pairing.create", ["scope": "runtime", "name": "Live test viewer"])
        let link = try XCTUnwrap(paired["link"] as? String), deviceId = try XCTUnwrap(paired["deviceId"] as? String)
        var tampered = try Pairing.parse(link)
        tampered = Pairing(endpoint: tampered.endpoint, deviceToken: tampered.deviceToken,
                           publicKeyB64: Data(repeating: 7, count: 32).base64EncodedString(), scope: "runtime")
        let wrongKey = RemoteHost(id: UUID().uuidString, name: "impostor", endpoint: tampered.endpoint,
                                  publicKeyB64: tampered.publicKeyB64, deviceToken: tampered.deviceToken)
        do {
            try await StreamConnection(host: wrongKey).connect()
            XCTFail("a Mac without the key the link pins was accepted")
        } catch {}

        let host = try await RemoteHosts.verify(link: link, name: "Live host")
        RuntimeHost.use(.remote(host))
        defer { RuntimeHost.use(.local) }
        let service = SessionService()
        let name = "orc-remote-" + UUID().uuidString.prefix(8)
        let handle = try await service.create(name: name, worktree: "path:" + worktree, command: nil)
        do {
            let listed = try await service.list().terminals
            XCTAssertTrue(listed.contains { $0.handle == handle })
            _ = try await RuntimeRPC.call("notes.set", ["name": name, "text": "from the other Mac"])
            try await service.rename(handle: handle, name: name + "-renamed")
            let notes = try await RuntimeRPC.call("notes.get", ["name": name + "-renamed"])
            XCTAssertEqual(notes["text"] as? String, "from the other Mac")
            try await service.close(handle: handle)
            let remaining = try await service.list().terminals
            XCTAssertFalse(remaining.contains { $0.handle == handle })
        } catch {
            _ = try? await LocalRPC.call("terminal.close", ["terminal": handle])
            throw error
        }
        // Revoking the grant drops the connection; a request already on it fails, and the next connection is refused.
        _ = try await LocalRPC.call("slim.pairing.revoke", ["deviceId": deviceId])
        _ = try? await service.list()
        do {
            _ = try await service.list()
            XCTFail("a revoked host still answered")
        } catch { XCTAssertTrue(error.localizedDescription.contains("refused this Mac"), error.localizedDescription) }
    }
}
