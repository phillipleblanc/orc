import XCTest
@testable import OrcKit

final class SessionListingTests: XCTestCase {
    private func terminal(_ handle: String, title: String) -> [String: Any] {
        ["handle": handle, "title": title, "worktreeId": "project::/tmp", "worktreePath": "/tmp",
         "connected": true, "writable": true, "agentIdentity": "pi", "incarnationId": "process-1"]
    }

    func testSessionsResolveByNameOrHandle() throws {
        let listing: SessionListing = try decode(["terminals": [terminal("term_a1", title: "Index work 한글"), terminal("term_b2", title: "review")],
                                                  "totalCount": 2, "truncated": false])
        XCTAssertEqual(try resolveSession("Index work 한글", in: listing.terminals).handle, "term_a1")
        XCTAssertEqual(try resolveSession("term_b2", in: listing.terminals).name, "review")
        XCTAssertEqual(try resolveSession("term_b", in: listing.terminals).name, "review")
        XCTAssertThrowsError(try resolveSession("term_", in: listing.terminals))
        XCTAssertThrowsError(try resolveSession("missing", in: listing.terminals))
        let json = try jsonObject(JSONEncoder().encode(listing.terminals[0]))
        XCTAssertEqual(json["title"] as? String, "Index work 한글")
    }

    func testNamesFollowTheRuntimesRules() {
        for name in ["review", "Index work 한글", "a-b_c.d", String(repeating: "x", count: 64)] {
            XCTAssertTrue(Session.isValidName(name), name)
        }
        for name in ["", " padded", "trailing ", ".hidden", "a/b", "tab\there", String(repeating: "x", count: 65), "e\u{301}"] {
            XCTAssertFalse(Session.isValidName(name), name)
        }
    }
}
