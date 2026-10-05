import SwiftUI
import WebKit
import OrcKit

/// One of the runtime's chat views of a durable agent.
struct DurableChatVariant: Identifiable, Hashable {
    let id: String
    let title: String
    let description: String
    let url: URL
}

/// The chat views the runtime offers for the selected durable agent. Their addresses change when the
/// runtime restarts, so they are fetched again whenever a view loses its connection.
@MainActor final class DurableChatModel: ObservableObject {
    static let terminal = "terminal"
    @Published private(set) var session: String?
    @Published private(set) var variants: [DurableChatVariant] = []
    @Published private(set) var error: String?

    func load(_ session: String) async {
        if self.session != session { variants = [] }
        self.session = session
        do {
            let result = try await LocalRPC.call("durable.chat", ["name": session])
            guard self.session == session else { return }
            variants = (result["variants"] as? [[String: Any]] ?? []).compactMap { value in
                guard let id = value["id"] as? String, let address = value["url"] as? String, let url = URL(string: address) else { return nil }
                return DurableChatVariant(id: id, title: value["title"] as? String ?? id, description: value["description"] as? String ?? "", url: url)
            }
            error = variants.isEmpty ? "The runtime offers no chat views. Rebuild Orc to bundle them." : nil
        } catch {
            guard self.session == session else { return }
            self.error = error.localizedDescription
        }
    }
}

/// A durable agent's chat view, or a note in its place while it cannot load.
struct DurableChatHost: View {
    let session: Session
    let variant: String
    @ObservedObject var model: DurableChatModel

    var body: some View {
        Group {
            if let chosen = model.session == session.name ? (model.variants.first { $0.id == variant } ?? model.variants.first) : nil {
                DurableChatWebView(url: chosen.url) { Task { await reload() } }
                    .id(chosen.url)
            } else if let error = model.error, model.session == session.name {
                ContentUnavailableView("Chat View Unavailable", systemImage: "bubble.left.and.exclamationmark.bubble.right",
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
