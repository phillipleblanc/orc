import SwiftUI
import AppKit
import OrcKit

struct AddProjectView: View {
    @ObservedObject var model: SessionModel
    var onAdded: (Workspace) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    @State private var path = ""
    @State private var makeDefault = true
    @State private var adding = false
    @State private var error: String?
    /// The folder open on another Mac and the folders in it.
    @State private var listing: (path: String, folders: [String], truncated: Bool)?
    private var host: RemoteHost? { HostSelection.current }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Add Project").font(.title2.bold())
            Text(host.map { "Choose a folder on \($0.name) for your sessions." } ?? "Choose a local folder for your sessions.").foregroundStyle(.secondary)
            HStack {
                TextField("Absolute project path", text: $path)
                    .onSubmit { if host != nil { Task { await open(path) } } }
                if host == nil { Button("Choose…", action: choose) }
            }
            if host != nil, let listing { folders(listing) }
            Toggle("Use for new sessions by default", isOn: $makeDefault)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button(adding ? "Adding…" : "Add Project") { Task { await add() } }
                    .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                    .disabled(!path.hasPrefix("/"))
            }
        }.padding(24).frame(width: 530).disabled(adding).interactiveDismissDisabled(adding)
        .task {
            guard host != nil, let start = startFolder else { return }
            await open(start)
        }
    }

    /// Another Mac's folders, browsed from the open one; only its home folder can be.
    private func folders(_ listing: (path: String, folders: [String], truncated: Bool)) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            List {
                if listing.path != "/" {
                    Button { Task { await open(parent(of: listing.path)) } } label: { Label("Enclosing Folder", systemImage: "arrow.turn.left.up") }
                        .buttonStyle(.plain)
                }
                ForEach(listing.folders, id: \.self) { folder in
                    Button { Task { await open((listing.path as NSString).appendingPathComponent(folder)) } } label: { Label(folder, systemImage: "folder") }
                        .buttonStyle(.plain)
                }
            }
            .frame(height: 220)
            if listing.truncated {
                Text("Showing the first 5,000 folders. Type the folder's path to go further.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    /// Where browsing starts: the folder holding the selected session's project, or another project's.
    private var startFolder: String? {
        let shown = model.sessions.first { $0.id == model.selected }
        let path = model.workspaces.first { $0.id == shown?.worktreeId }?.path ?? model.workspaces.first?.path ?? shown?.worktreePath
        return path.map(parent(of:))
    }

    private func parent(of path: String) -> String { (path as NSString).deletingLastPathComponent }

    private func open(_ folder: String) async {
        do {
            let opened = try await HostData.folders(in: folder)
            listing = opened
            path = opened.path
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
        panel.prompt = "Choose Project"
        guard panel.runModal() == .OK, let selected = panel.url else { return }
        path = selected.path
    }

    private func add() async {
        adding = true; defer { adding = false }
        do {
            let project = try await model.service.registerProject(at: URL(fileURLWithPath: path))
            var defaultError: String?
            if makeDefault {
                do { try await HostData.setDefaultProject("id:" + project.id) }
                catch { defaultError = "Project registered, but its default could not be saved: \(error.localizedDescription)" }
            }
            await model.refresh()
            if let defaultError { model.error = defaultError }
            onAdded(project); dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
