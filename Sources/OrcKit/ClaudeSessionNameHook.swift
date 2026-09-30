import Foundation

/// Supplies Claude's documented hook response: the Orc session's name as Claude's session title.
public enum ClaudeSessionNameHook {
    public static func response(to input: Data, environment: [String: String] = ProcessInfo.processInfo.environment) -> [String: Any] {
        guard let request = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
              let event = request["hook_event_name"] as? String,
              request["agent_id"] == nil,
              let name = environment["ORC_SESSION_NAME"], !name.isEmpty else { return [:] }
        switch event {
        case "SessionStart":
            guard let source = request["source"] as? String, ["startup", "resume", "fork"].contains(source) else { return [:] }
        case "UserPromptSubmit": break
        default: return [:]
        }
        return ["hookSpecificOutput": ["hookEventName": event, "sessionTitle": name]]
    }
}
