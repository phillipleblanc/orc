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
    private let center = UNUserNotificationCenter.current()
    private var authorization: Task<Void, Never>?
    private var pendingSelection: Target?

    override private init() {
        super.init()
        center.delegate = self
    }

    func start() {
        guard authorization == nil else { return }
        authorization = Task {
            do {
                let settings = await center.notificationSettings()
                if settings.authorizationStatus == .notDetermined {
                    _ = try await center.requestAuthorization(options: [.alert, .sound])
                }
                _ = await isAuthorized()
            } catch { warning = "Could not enable idle notifications: \(error.localizedDescription)" }
        }
    }

    private func isAuthorized() async -> Bool {
        let settings = await center.notificationSettings()
        let allowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
        warning = allowed ? nil : "Idle notifications are disabled. Enable Orc in System Settings → Notifications."
        return allowed
    }

    func postIdle(_ session: Session) async {
        start()
        await authorization?.value
        guard await isAuthorized() else { return }
        let content = UNMutableNotificationContent()
        content.title = session.name
        content.subtitle = "Agent is idle"
        content.body = "Finished working in \(URL(fileURLWithPath: session.worktreePath).lastPathComponent)."
        content.sound = .default
        content.threadIdentifier = "orc-session-" + session.handle
        content.userInfo = ["sessionHandle": session.handle]
        if let incarnation = session.incarnationId { content.userInfo["incarnationId"] = incarnation }
        // Reusing an identifier can silently update the previous notification
        // instead of presenting a banner for the next completed work cycle.
        let id = "orc-agent-idle-" + session.handle + "-" + UUID().uuidString
        do { try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) }
        catch { warning = "Could not show the idle notification: \(error.localizedDescription)" }
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
