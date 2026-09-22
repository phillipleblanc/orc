import XCTest
@testable import OrcKit
import COrcSupport

final class ProtocolTests: XCTestCase {
    func testBinaryFrameUsesSplitLittleEndianSequence() throws {
        let source = TerminalFrame(opcode: 7, streamID: 0x1020304, sequence: 0x123456789abcdef0, payload: Data("한글🐳".utf8))
        let bytes = [UInt8](source.encoded)
        XCTAssertEqual(Array(bytes.prefix(16)), [0x74, 1, 7, 0, 4, 3, 2, 1, 0x78, 0x56, 0x34, 0x12, 0xf0, 0xde, 0xbc, 0x9a])
        let decoded = try TerminalFrame(data: source.encoded)
        XCTAssertEqual(decoded.sequence, source.sequence)
        XCTAssertEqual(decoded.payload, source.payload)
        XCTAssertThrowsError(try TerminalFrame(data: Data([0x74, 1])))
    }
    func testUTF8AtEveryByteBoundary() {
        let text = "hello 한글 🐳 é\u{1b}[A"
        let bytes = Data(text.utf8)
        for split in 0...bytes.count {
            var decoder = InputDecoder()
            XCTAssertEqual(decoder.append(bytes.prefix(split)) + decoder.append(bytes.dropFirst(split)), text)
        }
    }
    func testNaClInteroperatesWithBoxEasyAndRejectsTampering() throws {
        var pk = [UInt8](repeating: 0, count: 32), sk = pk, shared = pk
        XCTAssertEqual(orc_crypto_keypair(&pk, &sk), 0)
        let client = try NaClChannel(peerKey: Data(pk))
        XCTAssertEqual(orc_crypto_shared(&shared, [UInt8](client.publicKey), sk), 0)
        let message = Data("encrypted terminal data\u{1b}[31m".utf8)
        let sealed = try client.seal(message)
        var plaintext = [UInt8](repeating: 0, count: message.count)
        XCTAssertEqual(orc_crypto_open(&plaintext, [UInt8](sealed), sealed.count, shared), 0)
        XCTAssertEqual(Data(plaintext), message)
        var reply = [UInt8](repeating: 0, count: message.count + 40)
        XCTAssertEqual(orc_crypto_seal(&reply, [UInt8](message), message.count, shared), 0)
        XCTAssertEqual(try client.open(Data(reply)), message)
        reply[reply.count - 1] ^= 1
        XCTAssertThrowsError(try client.open(Data(reply)))
        XCTAssertThrowsError(try client.open(Data(repeating: 0, count: 39)))
    }
    func testShellQuoteDoesNotExecuteSessionNames() {
        XCTAssertEqual(shellQuote("a'b; $(echo secret)"), "'a'\"'\"'b; $(echo secret)'")
    }
    func testAmbiguousNamesNeverPickArbitrarily() throws {
        let data = Data("""
        [{"handle":"term_1","title":"same","worktreeId":"w","worktreePath":"/tmp","connected":true,"writable":true},
         {"handle":"term_2","title":"same","worktreeId":"w","worktreePath":"/tmp","connected":true,"writable":true}]
        """.utf8)
        let sessions = try JSONDecoder().decode([Session].self, from: data)
        XCTAssertThrowsError(try resolveSession("same", in: sessions))
        XCTAssertThrowsError(try resolveSession("term_", in: sessions))
        XCTAssertEqual(try resolveSession("term_1", in: sessions).handle, "term_1")
    }
    func testPairingRejectsMobileScopeAndInvalidKey() throws {
        func link(_ scope: String, _ key: String) throws -> String {
            "orca://pair?code=" + (try jsonData(["endpoint": "ws://127.0.0.1:6768", "deviceToken": "fixture", "publicKeyB64": key, "scope": scope])).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        let key = Data(repeating: 1, count: 32).base64EncodedString()
        XCTAssertNoThrow(try Pairing.parse(link("runtime", key)))
        XCTAssertThrowsError(try Pairing.parse(link("mobile", key)))
        XCTAssertThrowsError(try Pairing.parse(link("runtime", "bad")))
    }
}
