import XCTest
@testable import OrcKit

final class SessionListingTests: XCTestCase {
    private func terminal(_ handle: String, title: String?) -> [String: Any] {
        ["handle": handle, "title": title as Any? ?? NSNull(), "worktreeId": "workspace", "worktreePath": "/tmp",
         "connected": true, "writable": true, "agentIdentity": "pi", "incarnationId": "process-1"]
    }
    private func pane(_ handle: String) -> [String: Any] { ["type": "terminal", "handle": handle] }
    private func group(_ title: Any, panes: [String: Any]) -> [String: Any] {
        ["type": "group", "tabs": [["title": title, "panes": panes]]]
    }
    private func listing(_ terminals: [[String: Any]], root: [String: Any]? = nil, savedNames: [SessionTab: String] = [:],
                         paneIdentities: [String: PaneIdentity] = [:]) throws -> SessionListing {
        var response: [String: Any] = ["terminals": terminals, "totalCount": terminals.count, "truncated": false]
        if let root { response["visualLayouts"] = [["root": root]] }
        return try SessionListing(response: response, savedNames: savedNames, paneIdentities: paneIdentities)
    }
    func testSavedRenameSurvivesAgentTitleChangesAndResolvesForAttach() throws {
        for title in ["Pi ready", "⠋ Pi working", "Shell"] {
            let sessions = try listing([terminal("term_pi", title: title)],
                                       root: group("Index work 한글", panes: pane("term_pi"))).terminals
            let session = try resolveSession("Index work 한글", in: sessions)
            XCTAssertEqual(session.handle, "term_pi")
            XCTAssertEqual(session.incarnationId, "process-1")
            XCTAssertEqual(session.agentIdentity, "pi")
            XCTAssertEqual(session.attachCommand, "orc attach 'term_pi'")
            let json = try jsonObject(JSONEncoder().encode(session))
            XCTAssertEqual(json["title"] as? String, "Index work 한글", "CLI JSON must use the same saved name")
        }
    }
    func testSplitTabsUseSavedNamesWithoutPickingAnAmbiguousPane() throws {
        let root: [String: Any] = ["type": "split",
            "first": group("Shared", panes: ["type": "pane-split", "first": pane("term_1"), "second": pane("term_2")]),
            "second": group("Separate", panes: pane("term_3"))]
        let sessions = try listing((1...3).map { terminal("term_\($0)", title: "Pi ready") }, root: root).terminals
        XCTAssertEqual(sessions.map(\.name), ["Shared", "Shared", "Separate"])
        XCTAssertThrowsError(try resolveSession("Shared", in: sessions))
        XCTAssertEqual(try resolveSession("term_2", in: sessions).handle, "term_2")
        XCTAssertEqual(try resolveSession("Separate", in: sessions).handle, "term_3")
    }
    func testMissingOrEmptyTabNamesKeepTerminalTitles() throws {
        let terminals = [terminal("term_1", title: "Background session")]
        let original = try listing(terminals).terminals
        XCTAssertEqual(original.first?.name, "Background session")
        for root in [group(NSNull(), panes: pane("term_1")), group("   ", panes: pane("term_1")),
                     group("Unrelated", panes: pane("term_other")), ["type": "future-layout"]] {
            XCTAssertEqual(try listing(terminals, root: root).terminals, original)
        }
    }
    func testHeadlessRestorationUsesSavedTabsWhenTerminalTitlesAreMissingOrTransient() throws {
        for title in [nil, "⠋ Pi working"] {
            var root = group("Saved before quitting Orca", panes: pane("term_headless"))
            root["groupId"] = "headless-terminals:workspace"
            let sessions = try listing([terminal("term_headless", title: title)], root: root).terminals
            XCTAssertEqual(try resolveSession("Saved before quitting Orca", in: sessions).handle, "term_headless")
        }
    }
    func testHeadlessRenameUsesPersistedCustomNameUntilLayoutCatchesUp() throws {
        var renamed = terminal("term_headless", title: "⠋ Pi working")
        renamed["tabId"] = "tab-1"
        var root = group("Old tab name", panes: pane("term_headless"))
        root["groupId"] = "headless-terminals:workspace"
        let key = SessionTab(host: "local", worktree: "workspace", tab: "tab-1")
        XCTAssertEqual(try listing([renamed], root: root, savedNames: [key: "Renamed background session"]).terminals.first?.name,
                       "Renamed background session")
        for other in [SessionTab(host: "ssh:other", worktree: "workspace", tab: "tab-1"),
                      SessionTab(host: "local", worktree: "other", tab: "tab-1"),
                      SessionTab(host: "local", worktree: "workspace", tab: "other")] {
            XCTAssertEqual(try listing([renamed], root: root, savedNames: [other: "Wrong name"]).terminals.first?.name, "Old tab name")
        }
    }

    func testBackgroundTerminalUsesPersistedPaneInsteadOfPtyPlaceholder() throws {
        var background = terminal("term_background", title: "Pi ready")
        background["ptyId"] = "project@@7f514adc"
        background["tabId"] = "pty:project@@7f514adc"
        background["leafId"] = "pty:project@@7f514adc"
        let tabs: [String: Any] = ["snapshots": [["tabs": [["type": "terminal", "terminal": "term_background",
            "parentTabId": "tab-stable", "leafId": "leaf-stable", "ptyId": "project@@7f514adc"]]]]]
        let identities = PaneIdentity.byHandle(in: tabs)
        let key = SessionTab(host: "local", worktree: "workspace", tab: "tab-stable")
        let sessions = try listing([background], savedNames: [key: "Persistent title"], paneIdentities: identities).terminals
        XCTAssertEqual(sessions.first?.name, "Persistent title")
        XCTAssertEqual(sessions.first?.notesKey, "pane_tab-stable_leaf-stable")
        XCTAssertEqual(try listing([background]).terminals.first?.notesKey, "term_background",
                       "A pty: placeholder must not become a note filename")
    }
}
