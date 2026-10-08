import AppKit
import Combine
import UserNotifications
import OrcKit

@MainActor final class IdleNotifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    struct Target: Sendable {
        let handle: String
        let incarnation: String?
    }
    static let shared = IdleNotifications()
    @Published private(set) var warning: String?
    var onSelect: ((Target) -> Void)? {
        didSet {
            if let pendingSelection, let onSelect {
                self.pendingSelection = nil
                onSelect(pendingSelection)
            }
        }
    }
    /// Nil outside an app bundle, where the notification center raises an exception.
    private let center: UNUserNotificationCenter? = Bundle.main.bundleURL.pathExtension == "app" ? .current() : nil
    private var authorization: Task<Void, Never>?
    private var pendingSelection: Target?

    override private init() {
        super.init()
        center?.delegate = self
    }

    func start() {
        guard authorization == nil, let center else { return }
        authorization = Task {
            do {
                // Ask for every notification feature we use, including the Dock badge.
                // Existing installations may already have alert/sound authorization but
                // have never requested badge authorization.
                _ = try await center.requestAuthorization(options: [.alert, .sound, .badge])
                _ = await isAuthorized()
            } catch { warning = "Could not enable idle notifications: \(error.localizedDescription)" }
        }
    }

    private func isAuthorized() async -> Bool {
        guard let center else { return false }
        let settings = await center.notificationSettings()
        let allowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
        if !allowed {
            warning = "Idle notifications are disabled. Enable Orc in System Settings → Notifications."
        } else if settings.badgeSetting == .disabled {
            warning = "Dock badges are disabled. Enable Badge application icon for Orc in System Settings → Notifications."
        } else {
            warning = nil
        }
        return allowed
    }

    func refreshSettings() async {
        await authorization?.value
        _ = await isAuthorized()
    }

    func setBadgeCount(_ count: Int) async {
        start()
        await authorization?.value
        do { try await center?.setBadgeCount(count) }
        catch { warning = "Could not update the Dock badge: \(error.localizedDescription)" }
    }

    func postIdle(_ session: Session) async {
        start()
        await authorization?.value
        guard await isAuthorized() else { return }
        let content = UNMutableNotificationContent()
        content.title = session.name
        let project = URL(fileURLWithPath: session.worktreePath).lastPathComponent
        if session.agentIdentity == nil, let program = session.programStatus {
            content.subtitle = "\(program.app ?? "Program") is done"
            content.body = program.lead?.msg ?? program.lead?.title ?? "Finished in \(project)."
        } else {
            content.subtitle = "Agent is idle"
            content.body = "Finished working in \(project)."
        }
        await deliver(content, from: session, kind: "idle")
    }

    /// A message a session sent with `orc notify`. It shows whether or not the session is muted: muting silences
    /// turn ends, and a session notifies only when it has something to say.
    func postMessage(_ notification: SessionNotification, from session: Session?) async {
        start()
        await authorization?.value
        guard await isAuthorized() else { return }
        let content = UNMutableNotificationContent()
        content.title = session?.name ?? notification.session ?? "Orc"
        content.body = notification.message
        await deliver(content, from: session, kind: "message")
    }

    private func deliver(_ content: UNMutableNotificationContent, from session: Session?, kind: String) async {
        content.sound = .default
        if let session {
            content.threadIdentifier = "orc-session-" + session.handle
            content.userInfo = ["sessionHandle": session.handle]
            if let incarnation = session.incarnationId { content.userInfo["incarnationId"] = incarnation }
        }
        // Reusing an identifier can silently update the previous notification
        // instead of presenting a banner for the next one.
        let id = "orc-\(kind)-" + (session.map { $0.handle + "-" } ?? "") + UUID().uuidString
        do { try await center?.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) }
        catch { warning = "Could not show the \(kind) notification: \(error.localizedDescription)" }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let handle = response.notification.request.content.userInfo["sessionHandle"] as? String else {
            completionHandler(); return
        }
        let target = Target(handle: handle,
            incarnation: response.notification.request.content.userInfo["incarnationId"] as? String)
        Task { @MainActor in
            if let onSelect { onSelect(target) }
            else { pendingSelection = target }
            completionHandler()
        }
    }
}
