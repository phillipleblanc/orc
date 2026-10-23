import Foundation
import CoreGraphics
import OrcKit

/// Reports one terminal's viewer to the runtime (`terminal.view`): whether it is on screen, and the person's attention
/// to it, in order. The runtime gives the session the size of the shown viewer the person is using, and each reply
/// says which device's viewer that is.
@MainActor final class TerminalViewReport {
    enum Attention: String { case strong, presence }
    /// How often a terminal on screen reports presence while the Mac is in use.
    static let presenceInterval: TimeInterval = 2
    /// Attention repeated this soon (scrolling, clicking) is reported once; the first report already moved the session here.
    static let repeatInterval: TimeInterval = 0.25
    /// Seconds since the last keyboard or pointer input anywhere on this Mac.
    static var secondsSinceInput: TimeInterval {
        CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
    }

    private let handle: String
    private let viewer: String
    private let send: ([String: Any]) async throws -> [String: Any]
    private let ownerChanged: (_ owner: Bool, _ device: String?) -> Void
    private var shown: Bool?
    private var lastAttention: (attention: Attention, at: Date)?
    private var sending: Task<Void, Never>?

    init(handle: String, viewer: String, send: @escaping ([String: Any]) async throws -> [String: Any] = { try await RuntimeRPC.call("terminal.view", $0, timeout: 3) },
         ownerChanged: @escaping (_ owner: Bool, _ device: String?) -> Void) {
        self.handle = handle; self.viewer = viewer; self.send = send; self.ownerChanged = ownerChanged
    }

    /// Reports a change to whether the terminal is on screen, and any attention.
    func report(shown: Bool, attention: Attention?, now: Date = Date()) {
        let changed = shown != self.shown
        self.shown = shown
        if let attention, !changed, let last = lastAttention, last.attention == attention, now.timeIntervalSince(last.at) < Self.repeatInterval { return }
        guard changed || attention != nil else { return }
        if let attention { lastAttention = (attention, now) }
        var params: [String: Any] = ["terminal": handle, "client": ["id": viewer], "shown": shown]
        if let attention { params["attention"] = attention.rawValue }
        let previous = sending
        sending = Task { [send, ownerChanged] in
            await previous?.value
            // A runtime without viewport ownership, or one restarting, leaves the session's size as it was.
            guard let result = try? await send(params) else { return }
            ownerChanged(result["owner"] as? Bool ?? false, result["ownerDevice"] as? String)
        }
    }
}
