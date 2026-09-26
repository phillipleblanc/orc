import SwiftUI
import WebKit
import OrcKit

struct MarkdownWebView: NSViewRepresentable {
    let document: MarkdownDocument
    let fragment: String?
    let appearance: String
    @Binding var error: String?

    static var pageURL: URL? {
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "MarkdownView") { return url }
        #if DEBUG
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("dist/MarkdownView/index.html").standardizedFileURL
        if FileManager.default.fileExists(atPath: url.path) { return url }
        #endif
        return nil
    }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(context.coordinator, name: "markdownLink")
        configuration.setURLSchemeHandler(MarkdownImageSchemeHandler(directory: document.url.deletingLastPathComponent()),
                                          forURLScheme: MarkdownImageLoader.scheme)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.setAccessibilityLabel("Rendered Markdown")
        context.coordinator.webView = view
        if let url = Self.pageURL {
            context.coordinator.pageURL = url
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else { context.coordinator.fail("The Markdown renderer is missing. Rebuild Orc to bundle it. Raw view is still available.") }
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.render()
    }
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        view.navigationDelegate = nil
        view.configuration.userContentController.removeScriptMessageHandler(forName: "markdownLink")
        coordinator.webView = nil
    }
    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: MarkdownWebView
        weak var webView: WKWebView?
        var pageURL: URL?
        private var ready = false
        private var rendered: [String]?
        init(_ parent: MarkdownWebView) { self.parent = parent }
        func render() {
            guard ready, let webView else { return }
            let key = [parent.document.url.absoluteString, parent.document.source, parent.appearance, parent.fragment ?? ""]
            guard rendered != key else { return }; rendered = key
            // The document is a data argument, never executable HTML or JavaScript.
            webView.callAsyncJavaScript("window.renderMarkdown(source, documentURL, appearance, fragment)",
                arguments: ["source": parent.document.source, "documentURL": parent.document.url.absoluteString,
                            "appearance": parent.appearance, "fragment": parent.fragment ?? ""],
                in: nil, in: .page) { [weak self] result in
                    if case .failure = result { self?.fail("Markdown preview unavailable. Use Raw view to read the file.") }
                }
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready = true; render() }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, let value = message.body as? [String: Any],
                  let href = value["url"] as? String, let url = URL(string: href) else { return }
            openLink(url)
        }
        private func openLink(_ url: URL) {
            if !MarkdownWindowController.open(url, relativeTo: parent.document.url.deletingLastPathComponent()),
               ["https", "http", "mailto", "file"].contains(url.scheme?.lowercased() ?? "") {
                NSWorkspace.shared.open(url)
            }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if navigationAction.navigationType == .linkActivated {
                openLink(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(url == pageURL ? .allow : .cancel)
            }
        }
        func fail(_ message: String) { DispatchQueue.main.async { [weak self] in self?.parent.error = message } }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error.localizedDescription) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error.localizedDescription) }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail("Markdown preview stopped. Switch to Raw, then Rendered, to reload it.") }
    }
}

@MainActor private final class MarkdownImageSchemeHandler: NSObject, WKURLSchemeHandler {
    let loader: MarkdownImageLoader
    private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]
    init(directory: URL) { loader = MarkdownImageLoader(directory: directory) }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let id = ObjectIdentifier(urlSchemeTask)
        let loader = self.loader
        tasks[id] = Task {
            defer { tasks.removeValue(forKey: id) }
            do {
                guard let url = urlSchemeTask.request.url else { throw OrcError("Invalid image URL.") }
                let image = try await Task.detached { try loader.load(url) }.value
                guard !Task.isCancelled else { return }
                urlSchemeTask.didReceive(URLResponse(url: url, mimeType: image.mimeType, expectedContentLength: image.data.count, textEncodingName: nil))
                urlSchemeTask.didReceive(image.data)
                urlSchemeTask.didFinish()
            } catch {
                if !Task.isCancelled { urlSchemeTask.didFailWithError(error) }
            }
        }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        tasks.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel()
    }
}
