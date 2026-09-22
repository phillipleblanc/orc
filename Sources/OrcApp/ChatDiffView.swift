import SwiftUI
import WebKit
import OrcKit

struct ChatDiffView: View {
    let block: ChatBlock
    let diff: ChatDiff
    @Environment(\.colorScheme) private var colorScheme
    @State private var expanded = true
    @State private var style = "unified"
    @State private var height: CGFloat = 160
    @State private var error: String?
    @State private var visible = false
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Changes").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Picker("Diff layout", selection: $style) {
                        Text("Unified").tag("unified")
                        Text("Split").tag("split")
                    }.pickerStyle(.segmented).labelsHidden().frame(width: 160).accessibilityLabel("Diff layout")
                }
                if let error {
                    Text(error).font(.callout).foregroundStyle(.secondary)
                } else if visible {
                    DiffWebView(diff: diff, style: style, appearance: colorScheme == .dark ? "dark" : "light",
                                height: $height, error: $error)
                        .frame(height: height).clipShape(RoundedRectangle(cornerRadius: 6))
                } else { Color.clear.frame(height: height) }
                DisclosureGroup("Tool input") {
                    Text(block.body).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }.font(.caption).foregroundStyle(.secondary)
            }.padding(.top, 8)
        } label: {
            Text(block.title).foregroundStyle(block.isError ? Color.red : Color.primary)
        }
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .onChange(of: expanded) { _, expanded in if expanded { error = nil } }
        .onChange(of: diff) { _, _ in error = nil }
    }
}

private struct DiffWebView: NSViewRepresentable {
    let diff: ChatDiff
    let style: String
    let appearance: String
    @Binding var height: CGFloat
    @Binding var error: String?
    private static let dataStore = WKWebsiteDataStore.nonPersistent()

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = Self.dataStore
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(context.coordinator, name: "diffView")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.setAccessibilityLabel("Edit diff")
        context.coordinator.webView = view
        if let url = Self.pageURL {
            context.coordinator.pageURL = url
            view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else { context.coordinator.failed("The diff renderer is missing. Rebuild Orc to bundle it.") }
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.render()
    }
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        view.navigationDelegate = nil
        view.configuration.userContentController.removeScriptMessageHandler(forName: "diffView")
        coordinator.webView = nil
    }
    private static var pageURL: URL? {
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "DiffView") { return url }
        #if DEBUG
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = root.appendingPathComponent("dist/DiffView/index.html")
        if FileManager.default.fileExists(atPath: url.path) { return url }
        #endif
        return nil
    }
    @MainActor final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: DiffWebView
        weak var webView: WKWebView?
        var pageURL: URL?
        private var ready = false
        private var rendered: String?
        init(_ parent: DiffWebView) { self.parent = parent }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, let value = message.body as? [String: Any] else { return }
            switch value["type"] as? String {
            case "ready": ready = true; render()
            case "height":
                if let height = value["value"] as? Double, height.isFinite {
                    let bounded = CGFloat(min(520, max(60, height)))
                    if abs(parent.height - bounded) > 1 { parent.height = bounded }
                }
            case "scroll":
                guard let delta = value["delta"] as? Double, delta.isFinite,
                      let scroll = webView?.enclosingScrollView else { return }
                let clip = scroll.contentView
                let mode = value["mode"] as? Int ?? 0
                let scale: CGFloat = mode == 1 ? 20 : mode == 2 ? clip.bounds.height : 1
                var bounds = clip.bounds
                bounds.origin.y += CGFloat(min(10_000, max(-10_000, delta))) * scale * (clip.isFlipped ? 1 : -1)
                clip.scroll(to: clip.constrainBoundsRect(bounds).origin)
                scroll.reflectScrolledClipView(clip)
            case "error": failed(value["message"] as? String ?? "Diff preview unavailable. See the tool input below.")
            default: break
            }
        }
        func render() {
            guard ready, let webView else { return }
            do {
                let data = try JSONEncoder().encode(parent.diff)
                let key = String(decoding: data, as: UTF8.self) + parent.style + parent.appearance
                guard key != rendered else { return }; rendered = key
                let payload = try JSONSerialization.jsonObject(with: data)
                // Tool contents are data arguments, never interpolated into JavaScript or HTML.
                webView.callAsyncJavaScript("window.renderDiff(payload, style, appearance)",
                    arguments: ["payload": payload, "style": parent.style, "appearance": parent.appearance],
                    in: nil, in: .page) { [weak self] result in
                        if case .failure = result { self?.failed("Diff preview unavailable. See the tool input below.") }
                    }
            } catch { failed("Diff preview unavailable. See the tool input below.") }
        }
        func failed(_ message: String) {
            DispatchQueue.main.async { [weak self] in self?.parent.error = message }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(navigationAction.request.url == pageURL ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            failed("Diff preview unavailable. See the tool input below.")
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            failed("Diff preview unavailable. See the tool input below.")
        }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            failed("Diff preview stopped. Reopen this tool call to reload it.")
        }
    }
}
