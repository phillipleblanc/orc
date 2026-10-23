import XCTest
@testable import OrcKit

final class MarkdownDocumentTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("orc-markdown-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private func resolve(_ value: String) throws -> MarkdownFileLink {
        try XCTUnwrap(MarkdownFileLink(try XCTUnwrap(URL(string: value)), relativeTo: root))
    }
    func testLocalMarkdownURLsResolveWithoutUsingDefaultApplications() throws {
        for name in ["notes.md", "README.MD", "notes.markdown", "notes.mdx", "한글 notes.md"] {
            let expected = root.appendingPathComponent(name).standardizedFileURL
            XCTAssertEqual(try resolve(expected.absoluteString).fileURL, expected)
            XCTAssertEqual(try resolve(name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)!).fileURL, expected)
        }
        XCTAssertEqual(try resolve("sub/../guide.md:12:3#setup").fileURL, root.appendingPathComponent("guide.md").standardizedFileURL)
        XCTAssertEqual(try resolve("guide.md:12#setup").fragment, "setup")
        XCTAssertEqual(try resolve("guide.md?view=1#한글").fragment, "한글")
        XCTAssertEqual(try resolve("~/Documents/notes.md").fileURL,
                       FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Documents/notes.md"))
    }
    func testURLDecodingDoesNotTreatEncodedCharactersAsNewURLSyntax() throws {
        let file = root.appendingPathComponent("literal %20 # ?.md").standardizedFileURL
        XCTAssertEqual(try resolve(file.absoluteString + "#heading").fileURL, file)
        XCTAssertEqual(try resolve(file.absoluteString + "#heading").fragment, "heading")
    }
    func testWebOtherFilesAndRemotePathsAreNotIntercepted() throws {
        for value in ["https://example.com/readme.md", "http://example.com/doc.md", "orca://open/readme.md",
                      "file://server/home/readme.md", "//server/home/readme.md", "notes.txt", "notes.pdf",
                      "javascript:alert(1)", "notes.md%0A"] {
            XCTAssertNil(MarkdownFileLink(try XCTUnwrap(URL(string: value)), relativeTo: root), value)
        }
        XCTAssertNotNil(try resolve("file://localhost/tmp/notes.md"))
    }
    func testReadsExactUTF8SourceAndSupportsReload() async throws {
        let url = root.appendingPathComponent("notes.md")
        let source = "# 한글\n\n**Bold**\n\n```swift\nlet x = 1\n```\n"
        try Data(source.utf8).write(to: url)
        let first = try await MarkdownDocument.load(url)
        XCTAssertEqual(first.source, source)
        try Data("# Updated".utf8).write(to: url)
        let reloaded = try await MarkdownDocument.load(url)
        XCTAssertEqual(reloaded.source, "# Updated")
    }
    func testMissingUnreadableNonTextAndOversizedDocumentsFailClearly() async throws {
        let binary = root.appendingPathComponent("binary.md")
        try Data([0xff, 0xfe, 0xff]).write(to: binary)
        let oversized = root.appendingPathComponent("oversized.md")
        try Data(repeating: 0x41, count: MarkdownDocument.maximumBytes + 1).write(to: oversized)
        for url: URL in [root.appendingPathComponent("missing.md"), root, binary, oversized] {
            do { _ = try await MarkdownDocument.load(url); XCTFail("\(url.lastPathComponent) loaded") } catch {}
        }
    }
    func testImageLoaderConfinesFileAccessToDocumentFolder() async throws {
        let docs = root.appendingPathComponent("docs", isDirectory: true)
        try FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
        let file = docs.appendingPathComponent("screen shot.png")
        let bytes = Data([1, 2, 3])
        try bytes.write(to: file)
        let loader = MarkdownImageLoader(directory: docs)
        func request(_ file: URL) throws -> URL {
            var components = URLComponents(url: file, resolvingAgainstBaseURL: true)!
            components.scheme = MarkdownImageLoader.scheme; components.host = "local"
            return try XCTUnwrap(components.url)
        }
        let image = try await loader.load(request(file))
        XCTAssertEqual(image.data, bytes); XCTAssertEqual(image.mimeType, "image/png")
        let outside = root.appendingPathComponent("secret.png")
        try bytes.write(to: outside)
        let symlink = docs.appendingPathComponent("link.png")
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: outside)
        let text = docs.appendingPathComponent("secret.txt")
        try bytes.write(to: text)
        for refused in [try request(outside), try request(symlink), try request(text), URL(string: "https://example.com/image.png")!] {
            do { _ = try await loader.load(refused); XCTFail("\(refused) loaded") } catch {}
        }
    }
}
