import XCTest
@testable import OrcKit

final class RemoteHostsTests: XCTestCase {
    private var config: URL!
    private var previous: String?

    override func setUpWithError() throws {
        previous = ProcessInfo.processInfo.environment["ORC_CONFIG_DIR"]
        config = FileManager.default.temporaryDirectory.appendingPathComponent("orc-hosts-" + UUID().uuidString)
        setenv("ORC_CONFIG_DIR", config.path, 1)
    }

    override func tearDownWithError() throws {
        RuntimeHost.use(.local)
        if let previous { setenv("ORC_CONFIG_DIR", previous, 1) } else { unsetenv("ORC_CONFIG_DIR") }
        try? FileManager.default.removeItem(at: config)
    }

    private func host(_ name: String, key: UInt8, token: String = "token", endpoint: String = "ws://studio.local:6768") -> RemoteHost {
        RemoteHost(id: UUID().uuidString, name: name, endpoint: endpoint,
                   publicKeyB64: Data(repeating: key, count: 32).base64EncodedString(), deviceToken: token)
    }

    func testHostsAreSavedForTheirOwnerAndFoundByIdOrName() throws {
        let studio = try RemoteHosts.save(host("Studio", key: 1))
        let air = try RemoteHosts.save(host("Air", key: 2))
        XCTAssertEqual(try RemoteHosts.list().map(\.name), ["Air", "Studio"])
        XCTAssertEqual(try RemoteHosts.load(studio.id), studio)
        XCTAssertEqual(try RemoteHosts.load("Air"), air)
        XCTAssertThrowsError(try RemoteHosts.load("Mini"))
        let file = config.appendingPathComponent("hosts/\(studio.id).json")
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int, 0o600)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: file.deletingLastPathComponent().path)[.posixPermissions] as? Int, 0o700)
    }

    func testPairingTheSameMacAgainKeepsItsId() throws {
        let first = try RemoteHosts.save(host("Studio", key: 1))
        let again = try RemoteHosts.save(host("Studio Mac", key: 1, token: "new", endpoint: "ws://192.168.1.5:6768"))
        XCTAssertEqual(again.id, first.id)
        XCTAssertEqual(try RemoteHosts.list().map { [$0.id, $0.name, $0.deviceToken, $0.endpoint] }, [[first.id, "Studio Mac", "new", "ws://192.168.1.5:6768"]])
    }

    func testEachHostKeepsItsOwnRecordOfItsSessionsUntilItIsForgotten() throws {
        XCTAssertEqual(AgentReviewStore.file, config.appendingPathComponent("agent-review.json"))
        let studio = try RemoteHosts.save(host("Studio", key: 1))
        RuntimeHost.use(.remote(studio))
        let state = config.appendingPathComponent("hosts/\(studio.id)")
        XCTAssertEqual(AgentReviewStore.file, state.appendingPathComponent("agent-review.json"))
        XCTAssertEqual(SessionMuteStore.file, state.appendingPathComponent("muted-sessions.json"))
        XCTAssertEqual(SessionSidebarOrderStore.file, state.appendingPathComponent("sidebar-order.json"))
        var mutes = SessionMutes()
        mutes.set(true, for: "build")
        try SessionMuteStore.save(mutes)
        XCTAssertTrue(try SessionMuteStore.load().isMuted("build"))
        RuntimeHost.use(.local)
        XCTAssertFalse(try SessionMuteStore.load().isMuted("build"), "this Mac's sessions keep their own record")
        try RemoteHosts.remove(studio.id)
        XCTAssertEqual(try RemoteHosts.list(), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: state.path))
    }

    func testAHostIsNamedAfterItsAddress() {
        XCTAssertEqual(RemoteHost.suggestedName(endpoint: "ws://studio.local:6768"), "studio")
        XCTAssertEqual(RemoteHost.suggestedName(endpoint: "ws://192.168.1.5:6768"), "192.168.1.5")
    }

    @MainActor func testAPhoneLinkIsNotAHost() async {
        do {
            _ = try await RemoteHosts.verify(link: "https://example.com", name: "x")
            XCTFail("a link that is not Orc's was accepted")
        } catch { XCTAssertTrue(error.localizedDescription.contains("Pair Device"), error.localizedDescription) }
    }
}
