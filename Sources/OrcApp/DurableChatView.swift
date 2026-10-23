import SwiftUI
import UniformTypeIdentifiers
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
        if let host = HostSelection.current {
            // Another Mac's agents open in this Mac's copy of the Workbench, one origin per Mac.
            var components = URLComponents()
            components.scheme = WorkbenchFiles.scheme
            components.host = host.id.lowercased()
            components.path = "/chat/workbench/"
            components.queryItems = [URLQueryItem(name: "session", value: session)]
            url = components.url
            error = WorkbenchFiles.frontend == nil ? "This copy of Orc has no Workbench. Reinstall Orc." : nil
            if error != nil { url = nil }
            return
        }
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
        if url.scheme == WorkbenchFiles.scheme {
            configuration.setURLSchemeHandler(WorkbenchFiles(), forURLScheme: WorkbenchFiles.scheme)
            configuration.userContentController.addUserScript(WKUserScript(source: DurableRelay.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            configuration.userContentController.add(context.coordinator.relay, name: DurableRelay.handlerName)
        }
        let view = WKWebView(frame: .zero, configuration: configuration)
        context.coordinator.relay.webView = view
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
        view.configuration.userContentController.removeScriptMessageHandler(forName: DurableRelay.handlerName)
        coordinator.relay.stop()
    }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: DurableChatWebView
        let relay = DurableRelay()
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

/// This Mac's copy of the Workbench, which shows another Mac's durable agents: the files the runtime's chat server serves
/// under `/chat/`, from the runtime bundled in Orc.app.
@MainActor final class WorkbenchFiles: NSObject, WKURLSchemeHandler {
    static let scheme = "orc-workbench"

    static var frontend: URL? {
        if let url = Bundle.main.resourceURL?.appendingPathComponent("Runtime/frontend"), FileManager.default.fileExists(atPath: url.path) { return url }
        #if DEBUG
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("slim/frontend")
        if FileManager.default.fileExists(atPath: url.path) { return url }
        #endif
        return nil
    }

    /// The file a page path names, inside the Workbench's folders only.
    static func file(for path: String, in frontend: URL) -> URL? {
        guard path.hasPrefix("/chat/") else { return nil }
        var relative = String(path.dropFirst("/chat/".count))
        let folder: URL
        if relative.hasPrefix("vendor/") {
            relative = String(relative.dropFirst("vendor/".count))
            if relative.hasPrefix("diffs/") { relative = String(relative.dropFirst("diffs/".count)) }
            folder = frontend.appendingPathComponent("build/chat-vendor", isDirectory: true)
        } else {
            folder = frontend.appendingPathComponent("src/chat", isDirectory: true)
            if relative.isEmpty || relative.hasSuffix("/") { relative += "index.html" }
        }
        let file = folder.appendingPathComponent(relative).standardizedFileURL
        return file.path.hasPrefix(folder.standardizedFileURL.path + "/") ? file : nil
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
        // URL.path drops a folder's trailing slash, which names its index.html.
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path ?? url.path
        guard let frontend = Self.frontend, let file = Self.file(for: path, in: frontend), let data = try? Data(contentsOf: file) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!)
            return task.didFinish()
        }
        let type = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type])!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

/// Carries the Workbench's requests of another Mac's agent to that Mac, over Orc's connection to it: `orcRelay` in the
/// page, which the Workbench's relay socket uses as its client. Only the methods of agents' conversations pass.
@MainActor final class DurableRelay: NSObject, WKScriptMessageHandler {
    static let handlerName = "orcRelay"
    private static let requests: Set<String> = ["durable.request", "durable.renew", "durable.unsubscribe"]
    static let script = """
    (function(){
    var sink=window.webkit.messageHandlers.orcRelay, replies=new Map(), streams=new Map(), next=0;
    Object.defineProperty(window,'__orcRelayDeliver',{value:function(m){
    if(m.type==='reply'){var w=replies.get(m.id);replies.delete(m.id);if(w){m.error!==undefined?w.reject(new Error(m.error)):w.resolve(m.result)}}
    else if(m.type==='event'){var l=streams.get(m.id);if(l){if(m.event&&m.event.type==='end'){streams.delete(m.id)}l(m.event)}}}});
    Object.defineProperty(window,'orcRelay',{value:{
    request:function(method,params){var id=++next;return new Promise(function(resolve,reject){replies.set(id,{resolve:resolve,reject:reject});sink.postMessage({type:'request',id:id,method:method,params:params||{}})})},
    subscribe:function(method,params,onEvent){var id=++next;streams.set(id,onEvent);sink.postMessage({type:'subscribe',id:id,method:method,params:params||{}});
    return function(){if(streams.delete(id)){sink.postMessage({type:'cancel',id:id})}}}}});
    })();
    """
    weak var webView: WKWebView?
    private var streams: [Int: () -> Void] = [:]

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let id = body["id"] as? Int else { return }
        let method = body["method"] as? String ?? "", params = body["params"] as? [String: Any] ?? [:]
        switch body["type"] as? String {
        case "request":
            guard Self.requests.contains(method) else { return deliver(["type": "reply", "id": id, "error": "\(method) is not relayed"]) }
            Task {
                do { deliver(["type": "reply", "id": id, "result": try await RuntimeRPC.call(method, params, timeout: 30)]) }
                catch { deliver(["type": "reply", "id": id, "error": error.localizedDescription]) }
            }
        case "subscribe":
            guard method == "durable.subscribe" else { return deliver(["type": "event", "id": id, "event": ["type": "end"]]) }
            Task {
                do {
                    streams[id] = try await RuntimeRPC.subscribe(method, params) { [weak self] event in
                        self?.deliver(["type": "event", "id": id, "event": event])
                    }
                } catch { deliver(["type": "event", "id": id, "event": ["type": "end", "error": error.localizedDescription]]) }
            }
        case "cancel":
            streams.removeValue(forKey: id)?()
        default: break
        }
    }

    private func deliver(_ message: [String: Any]) {
        webView?.callAsyncJavaScript("window.__orcRelayDeliver(m)", arguments: ["m": message], in: nil, in: .page) { _ in }
    }

    func stop() {
        for cancel in streams.values { cancel() }
        streams.removeAll()
    }
}
