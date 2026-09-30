import AppKit
import WebKit
import XCTest
import OrcKit
@testable import OrcApp

final class MarkdownWindowTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("orc-markdown-window-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDown() async throws {
        await MainActor.run {
            for controller in Array(MarkdownWindowController.documents.values) { controller.close() }
        }
        try FileManager.default.removeItem(at: root)
    }
    private func file(_ name: String, _ content: String) throws -> URL {
        let url = root.appendingPathComponent(name).standardizedFileURL
        try Data(content.utf8).write(to: url)
        return url
    }
    @MainActor private func waitFor(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(10)
        while !condition() {
            guard Date() < deadline else { XCTFail("The Markdown window did not reach its expected state"); throw OrcError("Timed out") }
            try await Task.sleep(for: .milliseconds(50))
        }
    }
    @MainActor private func descendant<T: NSView>(_ type: T.Type, in view: NSView?) -> T? {
        guard let view else { return nil }
        if let found = view as? T { return found }
        return view.subviews.lazy.compactMap { self.descendant(type, in: $0) }.first
    }
    @MainActor private func renderedView(_ controller: MarkdownWindowController, heading: String) async throws -> WKWebView {
        guard MarkdownWebView.pageURL != nil else { throw XCTSkip("Build the bundled views with npm --prefix WebMarkdown run build.") }
        try await waitFor { self.descendant(WKWebView.self, in: controller.window?.contentView) != nil }
        let web = try XCTUnwrap(descendant(WKWebView.self, in: controller.window?.contentView))
        let deadline = Date().addingTimeInterval(15)
        while (try? await web.evaluateJavaScript("document.querySelector('h1')?.textContent")) as? String != heading {
            guard Date() < deadline else { XCTFail(controller.model.error ?? "Markdown did not render"); throw OrcError("Timed out") }
            try await Task.sleep(for: .milliseconds(50))
        }
        return web
    }
    @MainActor func testWindowDefaultsToRenderedAndRawShowsExactSource() async throws {
        _ = NSApplication.shared
        let source = "# Rendered document\n\n**Bold** text.\n\n```swift\nlet x = 1\n```\n"
        let url = try file("document.md", source)
        XCTAssertTrue(MarkdownWindowController.open(url, relativeTo: root))
        let controller = try XCTUnwrap(MarkdownWindowController.documents[url])
        XCTAssertEqual(controller.model.mode, .rendered)
        XCTAssertEqual(controller.window?.representedURL, url)
        let web = try await renderedView(controller, heading: "Rendered document")
        let bold = try await web.evaluateJavaScript("document.querySelector('strong').textContent")
        XCTAssertEqual(bold as? String, "Bold")
        controller.model.mode = .raw
        try await waitFor { self.descendant(NSTextView.self, in: controller.window?.contentView)?.string == source }
        let raw = try XCTUnwrap(descendant(NSTextView.self, in: controller.window?.contentView))
        XCTAssertFalse(raw.isEditable); XCTAssertTrue(raw.isSelectable)
        XCTAssertEqual(raw.string, source)
        try Data("# Reloaded document".utf8).write(to: url)
        await controller.model.reload()
        try await waitFor { raw.string == "# Reloaded document" }
        controller.model.mode = .rendered
        _ = try await renderedView(controller, heading: "Reloaded document")
        controller.model.mode = .raw
        let next = try file("other.md", "# Other document")
        XCTAssertTrue(MarkdownWindowController.open(next, relativeTo: root))
        XCTAssertEqual(MarkdownWindowController.documents[next]?.model.mode, .rendered)
        XCTAssertEqual(MarkdownWindowController.documents.count, 2)
        let anchored = try XCTUnwrap(URL(string: url.absoluteString + "#rendered-document"))
        XCTAssertTrue(MarkdownWindowController.open(anchored, relativeTo: root))
        XCTAssertTrue(MarkdownWindowController.documents[url] === controller)
        XCTAssertEqual(controller.model.fragment, "rendered-document")
        XCTAssertEqual(MarkdownWindowController.documents.count, 2)
        controller.close()
        XCTAssertNil(MarkdownWindowController.documents[url])
    }
    @MainActor func testRenderedLinkOpensAnotherMarkdownWindowAndHTMLCannotExecute() async throws {
        _ = NSApplication.shared
        let next = try file("next.md", "# Linked document")
        let url = try file("index.md", "# Index\n\n[Next](next.md)\n\n<script>window.pwned = true</script>\n\n<a href='javascript:alert(1)'>Unsafe</a>")
        XCTAssertTrue(MarkdownWindowController.open(url, relativeTo: root))
        let controller = try XCTUnwrap(MarkdownWindowController.documents[url])
        let web = try await renderedView(controller, heading: "Index")
        let safe = try await web.evaluateJavaScript("typeof window.pwned === 'undefined' && !document.querySelector('a[href^=\"javascript:\"]')")
        XCTAssertEqual(safe as? Bool, true)
        _ = try await web.evaluateJavaScript("document.querySelector('a').click()")
        try await waitFor { MarkdownWindowController.documents[next] != nil }
        let linked = try XCTUnwrap(MarkdownWindowController.documents[next])
        XCTAssertEqual(linked.model.mode, .rendered)
        _ = try await renderedView(linked, heading: "Linked document")
    }
    @MainActor func testLocalImageUsesTheNativeScopedLoader() async throws {
        _ = NSApplication.shared
        let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 8, pixelsHigh: 8, bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        let color = NSColor(deviceRed: 0.4, green: 0.2, blue: 0.8, alpha: 1)
        for x in 0..<8 { for y in 0..<8 { bitmap.setColor(color, atX: x, y: y) } }
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: root.appendingPathComponent("image.png"))
        let url = try file("images.md", "# Images\n\n![Local](image.png)\n\n![Remote](https://example.invalid/tracking.png)")
        XCTAssertTrue(MarkdownWindowController.open(url, relativeTo: root))
        let controller = try XCTUnwrap(MarkdownWindowController.documents[url])
        let web = try await renderedView(controller, heading: "Images")
        let deadline = Date().addingTimeInterval(10)
        while (try await web.evaluateJavaScript("document.querySelector('img').naturalWidth")) as? Int != 8 {
            guard Date() < deadline else { XCTFail("The local image did not load"); return }
            try await Task.sleep(for: .milliseconds(50))
        }
        let remoteCount = try await web.evaluateJavaScript("document.querySelectorAll('img[src^=\"https:\"]').length")
        XCTAssertEqual(remoteCount as? Int, 0)
    }
    @MainActor func testTerminalMarkdownLinksUseTheSessionsProjectFolder() throws {
        _ = NSApplication.shared
        let url = try file("terminal.md", "# Terminal document")
        let session: Session = try decode(["handle": "term_markdown_fixture", "worktreeId": "markdown-fixture",
                                          "worktreePath": root.path, "connected": false, "writable": false])
        let terminal = GhosttyView(session: session)
        XCTAssertTrue(terminal.openMarkdownLink("terminal.md:12:3"))
        XCTAssertEqual(MarkdownWindowController.documents[url]?.model.mode, .rendered)
        XCTAssertFalse(terminal.openMarkdownLink("https://example.com/readme.md"))
    }
    @MainActor func testMissingMarkdownStaysInOrcAndOtherURLsAreNotClaimed() async throws {
        _ = NSApplication.shared
        let missing = root.appendingPathComponent("missing.md").standardizedFileURL
        XCTAssertTrue(MarkdownWindowController.open(missing, relativeTo: root))
        let controller = try XCTUnwrap(MarkdownWindowController.documents[missing])
        try await waitFor { controller.model.error != nil }
        XCTAssertNil(controller.model.document)
        XCTAssertFalse(MarkdownWindowController.open(URL(string: "https://example.com/README.md")!, relativeTo: root))
        XCTAssertFalse(MarkdownWindowController.open(root.appendingPathComponent("notes.txt"), relativeTo: root))
        XCTAssertEqual(MarkdownWindowController.documents.count, 1)
    }
}
