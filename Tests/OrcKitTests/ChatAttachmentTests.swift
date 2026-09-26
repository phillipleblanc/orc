import AppKit
import UniformTypeIdentifiers
import XCTest
@testable import OrcKit

final class ChatAttachmentTests: XCTestCase {
    private var directory: URL!
    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("orc-drop-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: directory) }
    private func file(_ name: String) throws -> ChatAttachment {
        let url = directory.appendingPathComponent(name)
        try Data("fixture".utf8).write(to: url)
        return try ChatAttachment(url: url)
    }
    private func target(_ agent: String = "codex", remote: Bool = false) throws -> ChatTarget {
        var status: [String: Any] = ["agentType": agent, "state": "done", "providerSession": ["id": "drop-test", "transcriptPath": "/session.jsonl"]]
        if remote { status["connectionId"] = "ssh-host" }
        return try XCTUnwrap(ChatTarget(tab: ["type": "terminal", "terminal": "term_drop", "agentStatus": status]))
    }
    private func png() throws -> Data {
        let image = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8,
                                                  samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                                  bytesPerRow: 0, bitsPerPixel: 0))
        return try XCTUnwrap(image.representation(using: .png, properties: [:]))
    }
    func testFinderProvidersPreserveOrderAndPreferFileOverImageRepresentation() async throws {
        let image = try file("Screenshot 한글 12.34.56 PM.png"), document = try file("notes with spaces.txt")
        let provider = NSItemProvider(object: image.url as NSURL)
        provider.registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) { completion in
            XCTFail("A Finder file URL must not load an image thumbnail")
            completion(nil, OrcError("unexpected")); return nil
        }
        XCTAssertTrue(ChatAttachmentDrop.accepts(provider))
        let files = try await ChatAttachmentDrop.load([provider, NSItemProvider(object: document.url as NSURL)], directory: directory)
        XCTAssertEqual(files, [image, document])
        XCTAssertTrue(files[0].isImage)
        XCTAssertFalse(files[1].isImage)
    }
    func testRawImageProviderIsRetainedPrivatelyAsPNG() async throws {
        let bytes = try png(), provider = NSItemProvider()
        provider.registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) { completion in
            completion(bytes, nil); return nil
        }
        let storage = directory.appendingPathComponent("attachments")
        let files = try await ChatAttachmentDrop.load([provider], directory: storage)
        let image = try XCTUnwrap(files.first)
        XCTAssertTrue(image.isImage)
        XCTAssertEqual(image.name, "Dropped image")
        XCTAssertEqual(image.url.deletingLastPathComponent().path, storage.path)
        XCTAssertNotNil(NSBitmapImageRep(data: try Data(contentsOf: image.url)))
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: image.url.path)[.posixPermissions] as? Int, 0o600)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: storage.path)[.posixPermissions] as? Int, 0o700)
    }
    func testInvalidDropsAreRejected() async throws {
        XCTAssertThrowsError(try ChatAttachment(url: URL(string: "https://example.com/image.png")!))
        XCTAssertThrowsError(try ChatAttachment(url: directory))
        XCTAssertThrowsError(try file("bad\nname.txt"))
        XCTAssertThrowsError(try file("bad\u{1b}[201~name.png"))
        XCTAssertThrowsError(try ChatAttachmentDrop.saveImage(Data("not an image".utf8), directory: directory))
        XCTAssertThrowsError(try ChatAttachmentDrop.saveImage(Data(count: ChatAttachmentDrop.maximumImageBytes + 1), directory: directory))
        let provider = NSItemProvider(object: "ordinary text" as NSString)
        XCTAssertFalse(ChatAttachmentDrop.accepts(provider))
        do { _ = try await ChatAttachmentDrop.load([provider]); XCTFail("Text is not a file drop") } catch {}
        do { _ = try await ChatAttachmentDrop.load(Array(repeating: provider, count: 17)); XCTFail("Unbounded drop") } catch {}
    }
    func testImagesAreSeparatePasteFramesAndFilesRemainInMessage() throws {
        let first = try file("first image.png"), second = try file("second.PNG"), document = try file("spec notes.txt")
        for agent in ["claude", "openclaude", "codex", "grok"] {
            let writes = try ChatInput.writes("Compare these\nand read the notes", attachments: [first, document, second], target: target(agent))
            XCTAssertEqual(writes, ["\u{1b}[200~\(shellQuote(first.url.path))\u{1b}[201~", "\u{1b}[200~\(shellQuote(second.url.path))\u{1b}[201~ ",
                                    "\u{1b}[200~Compare these\nand read the notes\n@\"\(document.url.path)\"\u{1b}[201~"])
            XCTAssertEqual(try ChatInput.writes("", attachments: [first], target: target(agent)), ["\u{1b}[200~\(shellQuote(first.url.path))\u{1b}[201~"])
        }
    }
    func testFileReferencesForPiAndOmpAndAttachmentOnlyMessages() throws {
        let image = try file("image with spaces.png")
        for agent in ["pi", "omp"] {
            XCTAssertEqual(try ChatInput.writes("", attachments: [image], target: target(agent)), ["@\"\(image.url.path)\""])
        }
        let file = try file("a\"b'c.txt")
        XCTAssertEqual(try ChatInput.writes("", attachments: [file], target: target()), ["@\"\(file.url.absoluteString)\""])
    }
    func testValidationPrecedesDelivery() throws {
        let file = try file("file.txt")
        XCTAssertThrowsError(try ChatInput.writes("hello", attachments: [file], target: target(remote: true)))
        XCTAssertEqual(try ChatInput.writes("hello", attachments: [], target: target(remote: true)), ["hello"])
        for text in ["/clear", "hello\u{1b}[201~", "hello\rbye", String(repeating: "x", count: 65537)] {
            XCTAssertThrowsError(try ChatInput.writes(text, attachments: [file], target: target()))
        }
        try FileManager.default.removeItem(at: file.url)
        XCTAssertThrowsError(try ChatInput.writes("hello", attachments: [file], target: target()))
        XCTAssertEqual(try ChatInput.writes(" \n ", attachments: [], target: target()), [])
    }
    func testDraftDeduplicatesAndOnlyClearsSuccessfullySentContent() throws {
        let first = try file("first.txt"), next = try file("next.txt")
        var draft = ChatDraft(); draft.text = "first message"
        draft.append([first, first]); XCTAssertEqual(draft.attachments, [first])
        let sent = draft
        draft.text = "next message"; draft.append([next])
        draft.didSend(sent)
        XCTAssertEqual(draft.text, "next message"); XCTAssertEqual(draft.attachments, [next])
        draft.didSend(draft); XCTAssertTrue(draft.isEmpty)
        draft.append([first]); XCTAssertFalse(draft.isEmpty)
    }
    func testTerminalPasteboardAndShellSafeWritesDoNotSubmit() throws {
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
}
