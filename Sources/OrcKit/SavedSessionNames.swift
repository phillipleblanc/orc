import Foundation

struct SessionTab: Hashable {
    let host: String
    let worktree: String
    let tab: String
}

/// Headless terminal.rename persists customTitle before its layout cache catches up.
/// Read only the selected profile's names; all mutations go through Orca's API.
enum SavedSessionNames {
    static func load(from directory: URL = RuntimeMetadata.directory) -> [SessionTab: String] {
        let index = directory.appendingPathComponent("orca-profile-index.json")
        let file: URL
        if FileManager.default.fileExists(atPath: index.path) {
            guard let data = try? Data(contentsOf: index),
                  let profile = try? JSONDecoder().decode(ProfileIndex.self, from: data),
                  profile.profiles.contains(where: { $0.id == profile.activeProfileId }),
                  profile.activeProfileId.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$", options: .regularExpression) != nil else { return [:] }
            file = directory.appendingPathComponent("profiles/\(profile.activeProfileId)/orca-data.json")
        } else {
            file = directory.appendingPathComponent("orca-data.json")
        }
        guard let data = try? Data(contentsOf: file), let state = try? JSONDecoder().decode(State.self, from: data) else { return [:] }
        var names: [SessionTab: String] = [:]
        func add(_ session: WorkspaceSession?, host: String) {
            for (worktree, tabs) in session?.tabsByWorktree ?? [:] {
                for tab in tabs {
                    if let title = tab.customTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
                        names[SessionTab(host: host, worktree: worktree, tab: tab.id)] = title
                    }
                }
            }
        }
        add(state.workspaceSession, host: "local")
        for (host, session) in state.workspaceSessionsByHostId ?? [:] where host != "local" { add(session, host: host) }
        return names
    }

    private struct ProfileIndex: Decodable {
        struct Profile: Decodable { let id: String }
        let activeProfileId: String
        let profiles: [Profile]
    }
    private struct State: Decodable {
        let workspaceSession: WorkspaceSession?
        let workspaceSessionsByHostId: [String: WorkspaceSession]?
    }
    private struct WorkspaceSession: Decodable {
        struct Tab: Decodable { let id: String; let customTitle: String? }
        let tabsByWorktree: [String: [Tab]]?
    }
}
