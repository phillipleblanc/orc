import AppKit
import XCTest
@testable import OrcKit

final class TerminalFileDropTests: XCTestCase {
    private var directory: URL!
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("orc-drop-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func file(_ name: String) throws -> DroppedFile {
        let url = directory.appendingPathComponent(name)
        try Data("fixture".utf8).write(to: url)
        return try DroppedFile(url: url)
    }
    private func png() throws -> Data {
        let image = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8,
                                                  samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                                  bytesPerRow: 0, bitsPerPixel: 0))
        return try XCTUnwrap(image.representation(using: .png, properties: [:]))
    }
    func testPasteboardFilesBecomeShellSafeWritesThatDoNotSubmit() throws {
        let image = try file("screen shot.png"), document = try file("a'; echo unsafe; '.txt")
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        pasteboard.writeObjects([image.url as NSURL, document.url as NSURL])
        XCTAssertTrue(TerminalFileDrop.accepts(pasteboard))
        let files = try TerminalFileDrop.load(pasteboard)
        XCTAssertEqual(files, [image, document])
        let writes = try TerminalFileDrop.writes(files)
        XCTAssertEqual(writes, files.map { shellQuote($0.url.path) + " " })
        XCTAssertFalse(writes.contains { $0.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) },
                       "Ghostty supplies the paste framing; drop text must not contain escape sequences or Enter")
    }
    func testRawImageDataIsRetainedPrivatelyAsPNG() throws {
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        pasteboard.setData(try png(), forType: .png)
        let storage = directory.appendingPathComponent("attachments")
        let image = try XCTUnwrap(TerminalFileDrop.load(pasteboard, directory: storage).first)
        XCTAssertEqual(image.url.deletingLastPathComponent().path, storage.path)
        XCTAssertNotNil(NSBitmapImageRep(data: try Data(contentsOf: image.url)))
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: image.url.path)[.posixPermissions] as? Int, 0o600)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: storage.path)[.posixPermissions] as? Int, 0o700)
    }
    func testInvalidDropsAreRejected() throws {
        XCTAssertThrowsError(try DroppedFile(url: URL(string: "https://example.com/image.png")!))
        XCTAssertThrowsError(try DroppedFile(url: directory))
        XCTAssertThrowsError(try file("bad\nname.txt"))
        XCTAssertThrowsError(try file("bad\u{1b}[201~name.png"))
        XCTAssertThrowsError(try TerminalFileDrop.saveImage(Data("not an image".utf8), directory: directory))
        XCTAssertThrowsError(try TerminalFileDrop.saveImage(Data(count: TerminalFileDrop.maximumImageBytes + 1), directory: directory))
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        pasteboard.setString("ordinary text", forType: .string)
        XCTAssertFalse(TerminalFileDrop.accepts(pasteboard))
        XCTAssertThrowsError(try TerminalFileDrop.load(pasteboard, directory: directory))
        let removed = try file("removed.txt")
        try FileManager.default.removeItem(at: removed.url)
        XCTAssertThrowsError(try TerminalFileDrop.writes([removed]))
    }
}
