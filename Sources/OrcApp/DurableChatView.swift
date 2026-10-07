import SwiftUI
import WebKit
import OrcKit

/// The address of the selected durable agent's Workbench. It changes when the runtime restarts, so it is
/// fetched again whenever the Workbench loses its connection.
@MainActor final class DurableChatModel: ObservableObject {
    @Published private(set) var session: String?
    @Published private(set) var url: URL?
    @Published private(set) var error: String?

    func load(_ session: String) async {
        if self.session != session { url = nil }
        self.session = session
        do {
            let result = try await LocalRPC.call("durable.chat", ["name": session])
            guard self.session == session else { return }
            url = (result["url"] as? String).flatMap(URL.init(string:))
            error = url == nil ? "The runtime did not give the Workbench's address." : nil
        } catch {
            guard self.session == session else { return }
            self.error = error.localizedDescription
        }
    }
}

/// A durable agent's Workbench, or a note in its place while it cannot load.
struct DurableChatHost: View {
    let session: Session
    @ObservedObject var model: DurableChatModel

    var body: some View {
        Group {
            if model.session == session.name, let url = model.url {
                DurableChatWebView(url: url) { Task { await reload() } }
                    .id(url)
            } else if let error = model.error, model.session == session.name {
                ContentUnavailableView("Workbench Unavailable", systemImage: "bubble.left.and.exclamationmark.bubble.right",
                                       description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .textBackgroundColor))
        .task(id: session.name) { await model.load(session.name) }
    }

    /// A view that lost its connection retries on its own; when the runtime moved, it gets the new address.
    private func reload() async {
        try? await Task.sleep(for: .seconds(1))
        await model.load(session.name)
    }
}

struct DurableChatWebView: NSViewRepresentable {
    let url: URL
    let disconnected: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(context.coordinator, name: "orc")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.setValue(false, forKey: "drawsBackground")
        view.setAccessibilityLabel("Durable agent chat")
        view.load(URLRequest(url: url))
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        view.navigationDelegate = nil
        view.uiDelegate = nil
        view.configuration.userContentController.removeScriptMessageHandler(forName: "orc")
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: DurableChatWebView
        private var lastReport = Date.distantPast
        init(_ parent: DurableChatWebView) { self.parent = parent }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, (message.body as? [String: Any])?["type"] as? String == "disconnected",
                  Date().timeIntervalSince(lastReport) > 3 else { return }
            lastReport = Date()
            parent.disconnected()
        }

        /// The view's own pages stay here; every other link opens in the browser.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if url.host == parent.url.host, url.port == parent.url.port, url.path.hasPrefix("/chat/") {
                decisionHandler(.allow)
            } else {
                if ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
                decisionHandler(.cancel)
            }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                NSWorkspace.shared.open(url)
            }
            return nil
        }

        /// Typing goes to the chat as soon as it shows, as it would to a terminal.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.window?.makeFirstResponder(webView)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            parent.disconnected()
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }
    }
}
