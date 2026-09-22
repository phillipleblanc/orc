import Foundation

/// Changes recorded in a tool call. Excerpts are never filled from today's
/// filesystem: it may differ from the file the agent edited at that time.
public struct ChatDiff: Encodable, Equatable {
    public struct Edit: Encodable, Equatable {
        public let path: String
        public let before: String
        public let after: String
    }
    public let edits: [Edit]
    public let patch: String?

    init?(toolName: String, input: Any?) {
        let name = toolName.split(separator: ".").last?.lowercased() ?? ""
        var input = input
        if let text = input as? String, let data = text.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            input = object
        }
        let object = input as? [String: Any] ?? [:]
        if ["apply_patch", "applypatch", "patch"].contains(name) {
            guard let patch = input as? String ?? object["patch"] as? String ?? object["input"] as? String,
                  patch.utf8.count <= 1_048_576,
                  ["*** Begin Patch", "diff --git ", "--- "].contains(where: { patch.hasPrefix($0) }) else { return nil }
            self.patch = patch; edits = []; return
        }
        guard ["edit", "edit_file", "multiedit", "multi_edit", "str_replace", "str_replace_editor"].contains(name) else { return nil }
        let path = object["path"] as? String ?? object["file_path"] as? String
        let entries = object["edits"] as? [[String: Any]] ?? [object]
        guard !entries.isEmpty, entries.count <= 100 else { return nil }
        var edits: [Edit] = []
        var bytes = 0
        for entry in entries {
            guard let path = entry["path"] as? String ?? entry["file_path"] as? String ?? path, !path.isEmpty,
                  let before = entry["oldText"] as? String ?? entry["old_string"] as? String ?? entry["old_str"] as? String,
                  let after = entry["newText"] as? String ?? entry["new_string"] as? String ?? entry["new_str"] as? String else { return nil }
            bytes += path.utf8.count + before.utf8.count + after.utf8.count
            guard bytes <= 1_048_576 else { return nil }
            edits.append(Edit(path: path, before: before, after: after))
        }
        self.edits = edits; patch = nil
    }
}
