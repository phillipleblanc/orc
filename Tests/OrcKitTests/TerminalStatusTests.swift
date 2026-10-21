import XCTest
@testable import OrcKit

final class TerminalStatusTests: XCTestCase {
    private let report = "\u{1b}]7501;state=working:app=build\u{1b}\\"

    /// Filters `text` split into two chunks at every byte, and checks each split gives the same output.
    private func filtered(_ text: String, file: StaticString = #filePath, line: UInt = #line) -> String {
        let bytes = Array(text.utf8)
        var outputs = Set<Data>()
        for split in 0...bytes.count {
            var filter = TerminalOutputFilter()
            outputs.insert(filter.filter(Data(bytes[..<split])) + filter.filter(Data(bytes[split...])))
        }
        XCTAssertEqual(outputs.count, 1, "every split gives the same output", file: file, line: line)
        return String(decoding: outputs.first!, as: UTF8.self)
    }

    func testTheSessionsOwnProgramStatusIsRemovedAndEverythingElseKept() {
        XCTAssertEqual(filtered("a" + report + "b"), "ab")
        XCTAssertEqual(filtered("\u{1b}]7501;state=done\u{07}x\u{1b}]7501;?\u{1b}\\y"), "xy", "BEL ends a report too, and queries go")
        let kept = ["\u{1b}]0;title\u{07}", "\u{1b}]8;;https://example.com\u{1b}\\link\u{1b}]8;;\u{1b}\\", "\u{1b}]750;x\u{07}",
                    "\u{1b}]75011;x\u{07}", "\u{1b}[31mred\u{1b}[0m", "\u{1b}P1$r0m\u{1b}\\", "\u{1b}(B", "é✓🙂", "\u{1b}]7501\u{07}"]
        for text in kept { XCTAssertEqual(filtered("<" + text + ">"), "<" + text + ">", text.debugDescription) }
        // An escape that is not a string terminator ends a report and starts a sequence of its own.
        XCTAssertEqual(filtered("\u{1b}]7501;state=done\u{1b}[1mbold"), "\u{1b}[1mbold")
    }

    func testReportsWaitForTheOutputToEndBetweenSequencesAndCharacters() {
        var filter = TerminalOutputFilter()
        XCTAssertTrue(filter.atBoundary)
        for (chunk, boundary) in [("\u{1b}", false), ("[1;", false), ("31m", true), ("\u{e2}\u{9c}", false), ("\u{93}", true), ("\u{1b}]0;ti", false),
                                  ("tle\u{07}", true), ("\u{1b}]7501;state=w", false), ("orking\u{1b}", false), ("\\", true)] {
            _ = filter.filter(Data(chunk.unicodeScalars.map { UInt8(truncatingIfNeeded: $0.value) }))
            XCTAssertEqual(filter.atBoundary, boundary, chunk.debugDescription)
        }
    }

    func testRecordsAreReportedOnceEachChangeAndRemovalsClear() {
        var reporter = ProgramStatusReporter()
        let root: [String: Any] = ["id": "", "state": "working", "app": "claude-code", "msg": "Reading files"]
        let step: [String: Any] = ["id": "tests/unit", "state": "blocked", "kind": "question", "progress": 40, "title": "Unit"]
        XCTAssertEqual(reporter.update([root, step]),
                       "\u{1b}]7501;state=working:app=claude-code:msg=UmVhZGluZyBmaWxlcw==\u{1b}\\"
                       + "\u{1b}]7501;state=blocked:id=tests/unit:kind=question:progress=40:title=VW5pdA==\u{1b}\\")
        XCTAssertEqual(reporter.update([root, step]), "", "unchanged records are not reported again")
        XCTAssertEqual(reporter.update([["id": "", "state": "done", "app": "claude-code"], step]), "\u{1b}]7501;state=done:app=claude-code\u{1b}\\")
        XCTAssertEqual(reporter.update([step]), ProgramStatusReporter.clearAll + "\u{1b}]7501;state=blocked:id=tests/unit:kind=question:progress=40:title=VW5pdA==\u{1b}\\",
                       "removing the root record clears everything and reports the rest again")
        XCTAssertEqual(reporter.update([step, ["id": "bad id", "state": "idle"], ["id": "x", "state": "sleeping"]]), "", "invalid records are skipped")
        XCTAssertEqual(reporter.clear(), ProgramStatusReporter.clearAll)
        XCTAssertEqual(reporter.clear(), "")
    }
}
