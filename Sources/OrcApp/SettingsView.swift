import SwiftUI
import OrcKit

/// Defaults for new sessions, kept in Orc's `config.json` and shared with `orc new`.
struct SettingsView: View {
    @ObservedObject var model: SessionModel
    @State private var agent: SessionType = .codex
    @State private var project = ""
    /// What the file held when last read, so showing a setting never writes it back.
    @State private var stored: (agent: SessionType, project: String)?
    /// A configured project selector that names no registered project, offered until another is chosen.
    @State private var unregistered: String?
    @State private var error: String?

    var body: some View {
        Form {
            Picker("Default agent", selection: $agent) {
                ForEach(SessionType.allCases, id: \.self) { Text(label($0)).tag($0) }
            }
            Picker("Default project", selection: $project) {
                Text("None").tag("")
                ForEach(model.workspaces) { Text($0.name).tag("id:" + $0.id) }
                if let unregistered { Text("\(unregistered) (not registered)").tag(unregistered) }
            }
            Section {
                Text("New Session, `orc new` and the session picker start new sessions with these. Saved in \(OrcConfiguration.file.path).")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                if let error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .onAppear(perform: load)
        .onChange(of: model.workspaces) { _, _ in load() }
        .onChange(of: agent) { _, value in
            guard let stored, value != stored.agent else { return }
            save { try OrcConfiguration.setDefaultSessionType(value) }
        }
        .onChange(of: project) { _, value in
            guard let stored, value != stored.project else { return }
            save { try OrcConfiguration.setDefaultProject(value.isEmpty ? nil : value) }
        }
    }

    private func load() {
        do {
            let config = try OrcConfiguration.load()
            let resolved = config.defaultProject.isEmpty ? nil : try? SessionCreationDefaults.project(config.defaultProject, in: model.workspaces)
            let tag = config.defaultProject.isEmpty ? "" : resolved.map { "id:" + $0.id } ?? config.defaultProject
            unregistered = !config.defaultProject.isEmpty && resolved == nil ? config.defaultProject : nil
            stored = (config.defaultSessionType, tag)
            agent = config.defaultSessionType
            project = tag
            error = nil
        } catch {
            stored = nil
            self.error = error.localizedDescription
        }
    }

    private func save(_ change: () throws -> Void) {
        do {
            try change()
            stored = (agent, project)
            if project != unregistered { unregistered = nil }
            error = nil
        } catch {
            self.error = error.localizedDescription
            load()
        }
    }

    private func label(_ type: SessionType) -> String {
        switch type {
        case .codex: "Codex"
        case .claude: "Claude"
        case .pi: "Pi"
        case .durable: "Durable (experimental)"
        case .terminal: "Terminal"
        }
    }
}
