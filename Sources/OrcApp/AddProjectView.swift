import SwiftUI
import AppKit
import OrcKit

struct AddProjectView: View {
    @ObservedObject var model: SessionModel
    var onAdded: (Workspace) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    @State private var path = ""
    @State private var folder = false
    @State private var makeDefault = true
    @State private var adding = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Add Project").font(.title2.bold())
            Text("Choose a local repository or folder for your sessions.").foregroundStyle(.secondary)
            HStack {
                TextField("Absolute project path", text: $path)
                Button("Choose…", action: choose)
            }
            Toggle("Plain folder (without Git worktrees)", isOn: $folder)
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
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
        panel.prompt = "Choose Project"
        guard panel.runModal() == .OK, let selected = panel.url else { return }
        path = selected.path
        folder = !FileManager.default.fileExists(atPath: selected.appendingPathComponent(".git").path)
    }

    private func add() async {
        adding = true; defer { adding = false }
        do {
            let project = try await model.service.registerProject(at: URL(fileURLWithPath: path), folder: folder)
            var defaultError: String?
            if makeDefault {
                do { try OrcConfiguration.setDefaultProject("id:" + project.id) }
                catch { defaultError = "Project registered, but its default could not be saved: \(error.localizedDescription)" }
            }
            await model.refresh()
            if let defaultError { model.error = defaultError }
            onAdded(project); dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
