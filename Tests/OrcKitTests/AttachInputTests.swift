import XCTest
@testable import OrcKit

final class AttachInputTests: XCTestCase {
    func testSwitchShortcutAcrossEveryReadBoundary() {
        for sequence in ["\u{1b}[39;5u", "\u{1b}[39;5:1u", "\u{1b}[39;5:2u",
                         "\u{1b}[39:34:39;5u", "\u{1b}[39;69u", "\u{1b}[39;197u", "\u{1b}[27;5;39~"] {
            let bytes = Data(sequence.utf8)
            for split in 0..<bytes.count {
                var parser = AttachInput()
                let first = parser.append(bytes.prefix(split))
                XCTAssertNil(first.exit)
                XCTAssertTrue(first.bytes.isEmpty)
                let second = parser.append(bytes.dropFirst(split))
                XCTAssertEqual(second.exit, .picker, sequence)
                XCTAssertTrue(second.bytes.isEmpty)
                XCTAssertFalse(parser.hasPending)
            }
        }
    }
    func testDetachWithLegacyAndExtendedKeysAndConsumeRelease() {
        for sequence in ["\u{1d}", "\u{1b}[93;5u", "\u{1b}[93;5:1u", "\u{1b}[27;5;93~"] {
            var parser = AttachInput()
            XCTAssertEqual(parser.append(Data(sequence.utf8)).exit, .detached)
        }
        for sequence in ["\u{1b}[39;5:3u", "\u{1b}[93;5:3u"] {
            var parser = AttachInput()
            let result = parser.append(Data(sequence.utf8))
            XCTAssertNil(result.exit)
            XCTAssertTrue(result.bytes.isEmpty)
        }
    }
    func testPastedShortcutsAreLiteralEvenWithOneByteReads() {
        let paste = "\u{1b}[200~'한글\u{1b}[39;5u\u{1d}\u{1b}[27;5;39~\u{1b}[201~"
        var parser = AttachInput(), output = Data()
        for byte in paste.utf8 {
            let result = parser.append(Data([byte]))
            XCTAssertNil(result.exit)
            output += result.bytes
        }
        XCTAssertEqual(output, Data(paste.utf8))
        XCTAssertEqual(parser.append(Data("\u{1b}[39;5u".utf8)).exit, .picker)
    }
    func testOtherInputIsUnchangedAndBareEscapeCanBeFlushed() {
        let text = "'한글🐳\u{3}\u{1b}[A\u{1b}x\u{1b}[39;6u\u{1b}[39;3u\u{1b}[97;5u\u{1b}[1;2R"
        var parser = AttachInput(), output = Data()
        for byte in text.utf8 {
            let result = parser.append(Data([byte]))
            XCTAssertNil(result.exit)
            output += result.bytes
        }
        XCTAssertEqual(output, Data(text.utf8))
        XCTAssertTrue(parser.append(Data([0x1b])).bytes.isEmpty)
        XCTAssertEqual(parser.flushPending(), Data([0x1b]))
        XCTAssertEqual(parser.append(Data("'".utf8)).bytes, Data("'".utf8))
    }
    func testMalformedSequencesRemainBoundedAndShortcutTailIsDiscarded() {
        var parser = AttachInput()
        let malformed = Data(("\u{1b}[" + String(repeating: "9", count: 1024)).utf8)
        XCTAssertEqual(parser.append(malformed).bytes, malformed)
        XCTAssertFalse(parser.hasPending)
        let result = parser.append(Data("before\u{1b}[39;5uafter".utf8))
        XCTAssertEqual(result.bytes, Data("before".utf8))
        XCTAssertEqual(result.exit, .picker)
        XCTAssertTrue(parser.flushPending().isEmpty)
    }
    func testEmbeddedAttachmentForwardsSwitchKeyAndStillDetaches() {
        var parser = AttachInput(sessionSwitching: false)
        let key = Data("\u{1b}[39;5u".utf8)
        let result = parser.append(key)
        XCTAssertNil(result.exit)
        XCTAssertEqual(result.bytes, key)
        XCTAssertEqual(parser.append(Data([0x1d])).exit, .detached)
    }
    func testOptionKeysPassThroughAttach() {
        for sequence in ["\u{1b}[13;3u", "\u{1b}[98;3u", "\u{1b}b"] {
            var parser = AttachInput()
            let bytes = Data(sequence.utf8)
            let result = parser.append(bytes)
            XCTAssertNil(result.exit)
            XCTAssertEqual(result.bytes, bytes)
        }
    }
}
