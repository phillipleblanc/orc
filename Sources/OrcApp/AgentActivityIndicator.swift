import SwiftUI
import OrcKit

struct AgentActivityIndicator: View {
    let activity: AgentActivity
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
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
        .font(.system(size: 12)).frame(width: 12, height: 12)
        .accessibilityElement(children: .ignore).accessibilityLabel(activity.label)
        .help(activity.label)
    }
}
