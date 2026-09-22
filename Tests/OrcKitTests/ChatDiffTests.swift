import XCTest
@testable import OrcKit

final class ChatDiffTests: XCTestCase {
    func testPiAndClaudeEditsPreserveWhitespaceAndEmptySides() throws {
        let pi = ChatBlock(["type": "tool-call", "name": "edit", "input": [
            "path": "Sources/한글.swift", "oldText": "    let value = 1\n", "newText": "    let value = 2\n"]])
        let edit = try XCTUnwrap(pi.diff?.edits.first)
        XCTAssertEqual(edit.path, "Sources/한글.swift")
        XCTAssertEqual(edit.before, "    let value = 1\n")
        XCTAssertEqual(edit.after, "    let value = 2\n")
        let claude = ChatBlock(["type": "tool-call", "name": "Edit", "input": [
            "file_path": "empty.txt", "old_string": "", "new_string": "inserted"]])
        XCTAssertEqual(claude.diff?.edits.first?.before, "")
        XCTAssertTrue(claude.body.contains("old_string"), "Keep the original input available")
    }
    func testMultiEditAndStringEncodedArguments() throws {
        let input: [String: Any] = ["file_path": "file.rs", "edits": [
            ["old_string": "old", "new_string": "new"], ["old_string": "remove", "new_string": ""]]]
        let encoded = String(decoding: try jsonData(input), as: UTF8.self)
        let diff = try XCTUnwrap(ChatDiff(toolName: "functions.MultiEdit", input: encoded))
        XCTAssertEqual(diff.edits.map(\.path), ["file.rs", "file.rs"])
        XCTAssertEqual(diff.edits.map(\.after), ["new", ""])
    }
    func testCodexPatchIsPreservedAsData() throws {
        let patch = "*** Begin Patch\n*** Update File: app.html\n@@\n-old\n+<script>window.evil = true</script>\n*** End Patch"
        let diff = try XCTUnwrap(ChatDiff(toolName: "functions.apply_patch", input: ["input": patch]))
        XCTAssertEqual(diff.patch, patch)
        let json = try jsonObject(JSONEncoder().encode(diff))
        XCTAssertEqual(json["patch"] as? String, patch)
        XCTAssertNotNil(ChatDiff(toolName: "apply_patch", input: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n"))
    }
    func testUnsupportedOrIncompleteInputsKeepTheirRawRepresentation() {
        let cases: [(String, Any)] = [
            ("read", ["path": "file", "oldText": "a", "newText": "b"]),
            ("write", ["path": "file", "content": "Cannot infer previous contents"]),
            ("edit", ["path": "file", "newText": "Missing before"]),
            ("edit", ["oldText": "a", "newText": "b"]),
            ("MultiEdit", ["file_path": "file", "edits": [["old_string": "a", "new_string": "b"], ["new_string": "c"]]]),
            ("apply_patch", "Not a patch"),
            ("edit", ["path": "file", "oldText": "", "newText": String(repeating: "a", count: 1_048_577)])]
        for (name, input) in cases {
            let block = ChatBlock(["type": "tool-call", "name": name, "input": input])
            XCTAssertNil(block.diff, name)
            XCTAssertFalse(block.body.isEmpty)
        }
        XCTAssertNil(ChatBlock(["type": "tool-result", "name": "edit", "output": "failed", "isError": true]).diff)
    }
}
