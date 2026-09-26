import AppKit
import SwiftUI
import OrcKit

struct MarkdownLinkHandling: ViewModifier {
    let directory: URL
    func body(content: Content) -> some View {
        content.environment(\.openURL, OpenURLAction { url in
            MarkdownWindowController.open(url, relativeTo: directory) ? .handled : .systemAction
        })
    }
}

@MainActor final class MarkdownWindowController: NSWindowController, NSWindowDelegate {
    static private(set) var documents: [URL: MarkdownWindowController] = [:]
    let model: MarkdownViewModel

    @discardableResult static func open(_ url: URL, relativeTo directory: URL) -> Bool {
        guard let link = MarkdownFileLink(url, relativeTo: directory) else { return false }
        open(link)
        return true
    }
    static func open(_ link: MarkdownFileLink) {
        let controller: MarkdownWindowController
        if let existing = documents[link.fileURL] {
            controller = existing
            controller.model.fragment = link.fragment
        } else {
            controller = MarkdownWindowController(link: link)
            documents[link.fileURL] = controller
        }
        controller.showWindow(nil)
        controller.window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    private init(link: MarkdownFileLink) {
        model = MarkdownViewModel(link: link)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 760),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = link.fileURL.lastPathComponent
        window.representedURL = link.fileURL
        window.minSize = NSSize(width: 540, height: 400)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: MarkdownDocumentView(model: model))
        super.init(window: window)
        window.delegate = self
        window.center()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    func windowWillClose(_ notification: Notification) { Self.documents.removeValue(forKey: model.url) }
}

@MainActor final class MarkdownViewModel: ObservableObject {
    enum Mode: String, CaseIterable { case rendered = "Rendered", raw = "Raw" }
    let url: URL
    @Published var mode: Mode = .rendered
    @Published var fragment: String?
    @Published private(set) var document: MarkdownDocument?
    @Published private(set) var revision = UUID()
    @Published private(set) var loading = false
    @Published var error: String?
    private var generation = UUID()
    init(link: MarkdownFileLink) { url = link.fileURL; fragment = link.fragment }
    func reload() async {
        let generation = UUID(); self.generation = generation
        loading = true; error = nil
        let url = self.url
        do {
            let document = try await Task.detached { try MarkdownDocument.load(url) }.value
            guard !Task.isCancelled, self.generation == generation else { return }
            self.document = document; revision = UUID()
        } catch {
            guard !Task.isCancelled, self.generation == generation else { return }
            self.document = nil; self.error = error.localizedDescription
        }
        loading = false
    }
}

struct MarkdownDocumentView: View {
    @ObservedObject var model: MarkdownViewModel
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text(model.url.path).font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle).help(model.url.path)
                Spacer(minLength: 12)
                Picker("Markdown view", selection: $model.mode) {
                    ForEach(MarkdownViewModel.Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented).labelsHidden().frame(width: 180)
                    .accessibilityLabel("Markdown view")
                Button { Task { await model.reload() } } label: { Image(systemName: "arrow.clockwise") }
                    .help("Reload file").accessibilityLabel("Reload file").disabled(model.loading)
            }.padding(12)
            Divider()
            if let document = model.document {
                if model.mode == .raw {
                    RawMarkdownView(source: document.source)
                } else {
                    MarkdownWebView(document: document, fragment: model.fragment,
                                    appearance: colorScheme == .dark ? "dark" : "light", error: $model.error)
                        .id(model.revision)
                }
            } else if model.loading {
                ProgressView("Loading Markdown…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView("Unable to open Markdown", systemImage: "doc.text.magnifyingglass")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if let error = model.error {
                HStack(alignment: .top) {
                    Image(systemName: "exclamationmark.triangle")
                    Text(error).textSelection(.enabled)
                    Spacer()
                }.font(.callout).foregroundStyle(.orange).padding(12)
            }
        }
        .task { await model.reload() }
    }
}

private struct RawMarkdownView: NSViewRepresentable {
    let source: String
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.hasVerticalScroller = true
        if let text = scroll.documentView as? NSTextView {
            text.isEditable = false
            text.isRichText = false
            text.isAutomaticLinkDetectionEnabled = false
            text.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
            text.textContainerInset = NSSize(width: 20, height: 20)
            text.autoresizingMask = [.width]
            text.setAccessibilityLabel("Raw Markdown")
        }
        return scroll
    }
    func updateNSView(_ view: NSScrollView, context: Context) {
        if let text = view.documentView as? NSTextView, text.string != source { text.string = source }
    }
}
