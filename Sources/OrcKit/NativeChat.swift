import Foundation

/// Transcript identity comes from Orca's live agent hooks, never from a tab title
/// or a guessed file path. Terminal and provider session IDs are distinct.
public struct ChatTarget: Equatable {
    public let handle: String
    public let agent: String?
    public let sessionID: String?
    public let transcriptPath: String?
    public let state: String?
    public let interactivePrompt: String?
    public let streamingText: String?
    public let supported: Bool
    public let hasLiveAgent: Bool
    public let launchDraft: String?

    public init?(tab: [String: Any]) {
        guard tab["type"] as? String == "terminal", let handle = tab["terminal"] as? String else { return nil }
        let status = tab["agentStatus"] as? [String: Any] ?? [:]
        let provider = status["providerSession"] as? [String: Any] ?? [:]
        self.handle = handle
        agent = status["agentType"] as? String ?? tab["launchAgent"] as? String
        sessionID = (provider["id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        transcriptPath = provider["transcriptPath"] as? String
        state = status["state"] as? String
        interactivePrompt = status["interactivePrompt"] as? String
        hasLiveAgent = status["agentType"] as? String != nil && status["restoredUnconfirmed"] as? Bool != true
        launchDraft = tab["launchDraft"] as? String
        streamingText = state == "working" && status["lastAssistantMessageIsToolOutput"] as? Bool != true
            ? status["lastAssistantMessage"] as? String : nil
        let local = status["connectionId"] == nil || status["connectionId"] is NSNull
        supported = ["claude", "openclaude", "codex", "grok", "omp"].contains(agent ?? "")
            && (local || !["grok", "omp"].contains(agent ?? ""))
    }
    public var identity: String? {
        guard supported, let agent, let sessionID else { return nil }
        return agent + "\0" + sessionID + "\0" + (transcriptPath ?? "")
    }
    public var requiresTerminal: Bool { state == "blocked" || state == "waiting" || interactivePrompt?.isEmpty == false }
    public var canSend: Bool { supported && hasLiveAgent && identity != nil && !requiresTerminal }
    public var isWorking: Bool { state == "working" }
    public var params: [String: Any] {
        var result: [String: Any] = ["agent": agent == "openclaude" ? "claude" : agent ?? "", "sessionId": sessionID ?? "", "limit": 60]
        if let transcriptPath { result["transcriptPath"] = transcriptPath }
        return result
    }
    public static func targets(in response: [String: Any]) -> [String: ChatTarget] {
        let snapshots = response["snapshots"] as? [[String: Any]] ?? [response]
        var result: [String: ChatTarget] = [:]
        for snapshot in snapshots {
            for tab in snapshot["tabs"] as? [[String: Any]] ?? [] {
                if let target = ChatTarget(tab: tab) { result[target.handle] = target }
            }
        }
        return result
    }
}

public struct ChatMessage: Identifiable, Equatable {
    public let id: String
    public let role: String
    public let blocks: [ChatBlock]
    public init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String, let role = value["role"] as? String else { return nil }
        self.id = id; self.role = role
        blocks = (value["blocks"] as? [[String: Any]] ?? []).map(ChatBlock.init)
    }
}

public struct ChatBlock: Equatable {
    public let type: String
    public let title: String
    public let body: String
    public let isError: Bool
    public init(_ value: [String: Any]) {
        type = value["type"] as? String ?? "unknown"
        isError = value["isError"] as? Bool == true || value["state"] as? String == "failed"
        switch type {
        case "text": title = ""; body = value["text"] as? String ?? ""
        case "tool-call":
            title = (value["name"] as? String ?? "Tool") + " · " + (value["state"] as? String ?? "running")
            body = Self.display(value["input"])
        case "tool-result": title = isError ? "Tool error" : "Tool result"; body = Self.display(value["output"])
        case "image-ref": title = "Image"; body = value["alt"] as? String ?? value["path"] as? String ?? "Image attachment — open the terminal to view."
        default: title = type.replacingOccurrences(of: "-", with: " ").capitalized; body = Self.display(value)
        }
    }
    private static func display(_ value: Any?) -> String {
        guard let value else { return "" }
        if let text = value as? String { return text }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
}

public struct ChatHistory {
    public private(set) var messages: [ChatMessage] = []
    public private(set) var hasMore = false
    public private(set) var beforeOffset: Int?
    private var identity: String?
    public init() {}
    public mutating func bind(to identity: String) {
        guard self.identity != identity else { return }
        self = ChatHistory()
        self.identity = identity
    }
    public mutating func apply(_ event: [String: Any]) {
        // Pending snapshots do not prove an empty transcript (e.g. a file that
        // has not been created yet). Retain the last authoritative history.
        guard event["pending"] as? Bool != true, event["error"] == nil else { return }
        let incoming = (event["messages"] as? [[String: Any]] ?? []).compactMap(ChatMessage.init)
        switch event["type"] as? String {
        case "snapshot", "replacement":
            messages = []; merge(incoming)
            hasMore = event["hasMore"] as? Bool ?? false
            beforeOffset = event["beforeOffset"] as? Int
        case "appended": merge(incoming)
        default: break
        }
    }
    public mutating func prepend(_ page: [String: Any]) throws {
        if let error = page["error"] { throw OrcError(String(describing: error)) }
        let earlier = (page["messages"] as? [[String: Any]] ?? []).compactMap(ChatMessage.init)
        let current = messages
        messages = []; merge(earlier); merge(current)
        let next = page["beforeOffset"] as? Int
        hasMore = page["hasMore"] as? Bool == true && next != beforeOffset
        beforeOffset = next
    }
    private mutating func merge(_ incoming: [ChatMessage]) {
        var indexes = Dictionary(uniqueKeysWithValues: messages.enumerated().map { ($0.element.id, $0.offset) })
        for message in incoming {
            if let index = indexes[message.id] { messages[index] = message }
            else { indexes[message.id] = messages.count; messages.append(message) }
        }
    }
}

/// Desktop writes do not claim a viewport or take the phone's input floor.
/// Every write is guarded by Orca so chat text cannot land at a shell prompt.
@MainActor public enum ChatWriter {
    public static func send(_ text: String, target: ChatTarget, connection: StreamConnection, clientID: String) async throws {
        guard target.canSend else { throw OrcError("Use Attach to finish the agent's prompt before sending a message.") }
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard text.utf8.count <= 64 * 1024 else { throw OrcError("Messages must be 64 KiB or smaller.") }
        guard !text.hasPrefix("/") else { throw OrcError("Use Attach for agent slash commands.") }
        guard !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) && $0 != "\n" && $0 != "\t" }) else {
            throw OrcError("Messages cannot contain terminal control characters.")
        }
        // Control bytes must be their own write; pasting them with message text
        // can insert literal Ctrl-U into an agent's multi-line editor.
        let lines = min(40, (target.launchDraft?.components(separatedBy: "\n").count ?? 1) + 8)
        let clear = String(repeating: "\u{15}", count: 2 * lines - 1) + String(repeating: "\u{b}", count: 2 * lines - 1)
        try await write(["text": clear, "enter": false], target: target, connection: connection, clientID: clientID)
        try await write(["text": text, "enter": false], target: target, connection: connection, clientID: clientID)
        // Codex's paste detector treats an immediate Enter as part of a paste.
        // Allow the editor to settle before the separately guarded submit.
        try await Task.sleep(for: .milliseconds(300))
        try await write(["enter": true], target: target, connection: connection, clientID: clientID)
    }
    public static func stop(target: ChatTarget, connection: StreamConnection, clientID: String) async throws {
        guard target.canSend, target.isWorking else { throw OrcError("The agent is not working, or needs a response in its terminal.") }
        // Escape interrupts the agent without exiting its terminal process.
        try await write(["text": "\u{1b}", "enter": false], target: target, connection: connection, clientID: clientID)
        // Match Orca mobile's paced Escape pair: a queued turn can consume the
        // first Escape before the foreground response receives it.
        try await Task.sleep(for: .milliseconds(80))
        try? await write(["text": "\u{1b}", "enter": false], target: target, connection: connection, clientID: clientID)
    }
    private static func write(_ payload: [String: Any], target: ChatTarget, connection: StreamConnection, clientID: String) async throws {
        var params = payload
        params["terminal"] = target.handle
        params["client"] = ["id": clientID, "type": "desktop"]
        params["requireAgentStatus"] = "sendable"
        let response: [String: Any]
        do { response = try await connection.request("terminal.send", params) }
        catch { throw OrcError("Delivery unconfirmed. Check the conversation or attach before retrying. \(error.localizedDescription)") }
        guard (response["send"] as? [String: Any])?["accepted"] as? Bool == true else {
            throw OrcError("Orca refused input. The phone may own the terminal, or the agent may need attention. Use Attach to check before retrying.")
        }
    }
}
