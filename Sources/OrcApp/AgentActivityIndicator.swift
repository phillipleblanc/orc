import SwiftUI
import OrcKit

/// An agent's activity, or a muted bell for a session whose notifications are muted.
struct AgentActivityIndicator: View {
    let activity: AgentActivity
    var muted = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var label: String { muted ? "Notifications muted · \(activity.label)" : activity.label }

    var body: some View {
        Group {
            if muted {
                Image(systemName: "bell.slash.fill").foregroundStyle(.secondary)
            } else {
                indicator
            }
        }
        .font(.system(size: 12)).frame(width: 12, height: 12)
        .accessibilityElement(children: .ignore).accessibilityLabel(label)
        .help(label)
    }

    @ViewBuilder private var indicator: some View {
        Group {
            switch activity {
            case .active:
                TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
                    Circle().trim(from: 0, to: 0.72)
                        .stroke(.yellow, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                        .rotationEffect(.degrees(reduceMotion ? -90 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1) * 360))
                        .padding(1)
                }
            case .idle:
                Circle().fill(.green).padding(2)
            case .unread:
                Image(systemName: "bell.fill").foregroundStyle(.blue)
            case .needsAttention:
                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.orange)
            case .noAgent:
                Image(systemName: "circle").foregroundStyle(.secondary)
            case .unknown:
                Image(systemName: "questionmark.circle").foregroundStyle(.secondary)
            case .offline:
                Image(systemName: "xmark.circle").foregroundStyle(.secondary)
            }
        }
    }
}

/// A session's status icon: its agent's activity, or a terminal for a session without an agent.
struct SessionStatusIcon: View {
    let session: Session
    let activity: AgentActivity
    var muted = false

    var body: some View {
        if session.agentIdentity != nil {
            AgentActivityIndicator(activity: activity, muted: muted)
        } else {
            Image(systemName: "terminal").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                .frame(width: 12, height: 12)
                .accessibilityElement(children: .ignore).accessibilityLabel("Terminal session")
                .help("Terminal session")
        }
    }
}
