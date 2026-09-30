import Foundation

/// Supplies Claude's documented hook response without contacting or starting the runtime.
public enum ClaudeSessionNameHook {
    public static func response(to input: Data, environment: [String: String] = ProcessInfo.processInfo.environment) -> [String: Any] {
        guard let request = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
              let event = request["hook_event_name"] as? String,
              request["agent_id"] == nil,
              let worktree = environment["ORCA_WORKTREE_ID"], !worktree.isEmpty,
              let pane = environment["ORCA_PANE_KEY"],
              pane.range(of: "^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
              let directory = environment["ORCA_USER_DATA_PATH"], directory.hasPrefix("/") else { return [:] }
        switch event {
        case "SessionStart":
            guard let source = request["source"] as? String, ["startup", "resume", "fork"].contains(source) else { return [:] }
        case "UserPromptSubmit": break
        default: return [:]
        }
        let tab = String(pane.split(separator: ":")[0])
        let names = SavedSessionNames.load(from: URL(fileURLWithPath: directory))
        guard let name = names[SessionTab(host: "local", worktree: worktree, tab: tab)] else { return [:] }
        return ["hookSpecificOutput": ["hookEventName": event, "sessionTitle": name]]
    }
}
