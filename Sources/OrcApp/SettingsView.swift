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
    @AppStorage("showStatusOnReturn") private var showStatusOnReturn = true
    /// The model the runtime writes agent status briefs with, as `provider/id`, or "" for none.
    @State private var statusModel = ""
    @State private var statusModels: [(model: String, name: String)] = []
    /// The model as the runtime has it, once read; a choice that differs is saved.
    @State private var savedStatusModel: String?
    @State private var statusError: String?
    /// The checks never reported to agents, separated by commas, and as the runtime has them once read.
    @State private var ignoredChecks = ""
    @State private var savedIgnoredChecks: String?
    @State private var pullRequestError: String?

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
            Section("Agent Status") {
                Picker("Status model", selection: $statusModel) {
                    Text("Off").tag("")
                    ForEach(statusModels, id: \.model) { Text("\($0.name) (\($0.model))").tag($0.model) }
                }
                .disabled(savedStatusModel == nil)
                Toggle("Show status when returning to an agent", isOn: $showStatusOnReturn)
                Text("Orc writes where each agent's work stands from its transcript with this model, one of Pi's: after the agent's turns and every 15 minutes while it works, without messaging the agent. Coming back to an agent after 15 minutes away shows its status in a floating panel; ⌥⌘S shows it any time.")
                    .font(.caption).foregroundStyle(.secondary)
                if let statusError { Text(statusError).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            }
            Section("Pull Requests") {
                TextField("Ignored checks", text: $ignoredChecks, prompt: Text("Attestation"))
                    .disabled(savedIgnoredChecks == nil)
                    .onSubmit(saveIgnoredChecks)
                Text("Writing an agent's status links the pull requests it opened. Once the agent is idle, Orc tells it about their failing checks, unresolved Copilot comments and merge conflicts, each once. These checks, separated by commas, are never reported; * matches anything.")
                    .font(.caption).foregroundStyle(.secondary)
                if let pullRequestError { Text(pullRequestError).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .onAppear(perform: load)
        .task { await loadStatus() }
        .task { await loadIgnoredChecks() }
        .onDisappear(perform: saveIgnoredChecks)
        .onChange(of: statusModel) { _, value in
            guard let saved = savedStatusModel, value != saved else { return }
            Task {
                do {
                    try await BriefModel.configure(model: value.isEmpty ? nil : value)
                    savedStatusModel = value
                    statusError = nil
                } catch {
                    statusError = error.localizedDescription
                    statusModel = saved
                }
            }
        }
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

    private func loadStatus() async {
        do {
            let settings = try await BriefModel.settings()
            statusModels = settings.models
            if let model = settings.model, !settings.models.contains(where: { $0.model == model }) {
                statusModels.insert((model, model), at: 0)
            }
            savedStatusModel = settings.model ?? ""
            statusModel = settings.model ?? ""
            statusError = nil
        } catch {
            statusError = "Could not read the status model: \(error.localizedDescription)"
        }
    }

    private func loadIgnoredChecks() async {
        do {
            let checks = try await PullRequestWatch.ignoredChecks().joined(separator: ", ")
            ignoredChecks = checks
            savedIgnoredChecks = checks
        } catch {
            pullRequestError = "Could not read the ignored checks: \(error.localizedDescription)"
        }
    }

    private func saveIgnoredChecks() {
        guard let saved = savedIgnoredChecks, ignoredChecks != saved else { return }
        let checks = ignoredChecks.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        Task {
            do {
                try await PullRequestWatch.setIgnoredChecks(checks)
                savedIgnoredChecks = checks.joined(separator: ", ")
                ignoredChecks = checks.joined(separator: ", ")
                pullRequestError = nil
            } catch {
                pullRequestError = error.localizedDescription
            }
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
