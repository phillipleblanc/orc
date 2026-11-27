import SwiftUI
import OrcKit

/// An agent's activity, or a muted bell for a session whose notifications are muted, unless it sent a notification.
struct AgentActivityIndicator: View {
    let activity: AgentActivity
    var muted = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var label: String { muted ? "Notifications muted · \(activity.label)" : activity.label }

    var body: some View {
        Group {
            if muted && activity != .notified {
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
            case .unread, .notified:
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

/// A session's status icon: its agent's activity, or its program's when that reports its status, or a terminal; any
/// session that sent a notification shows the bell.
struct SessionStatusIcon: View {
    let session: Session
    let activity: AgentActivity
    var muted = false

    var body: some View {
        if session.agentIdentity != nil || session.programStatus != nil || activity == .notified {
            AgentActivityIndicator(activity: activity, muted: muted)
        } else {
            Image(systemName: "terminal").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                .frame(width: 12, height: 12)
                .accessibilityElement(children: .ignore).accessibilityLabel("Terminal session")
                .help("Terminal session")
        }
    }
}

extension AgentActivityIndicator {
    /// Whether a session's row shows its indicator: an agent's or a status-reporting program's when it works, has
    /// something new, waits on its person, is offline or is muted; a terminal's only for a notification or offline.
    /// Idle shows nothing.
    static func shows(_ activity: AgentActivity, for session: Session, muted: Bool) -> Bool {
        guard session.agentIdentity != nil || session.programStatus != nil else { return activity == .notified || activity == .offline }
        return muted || [.active, .unread, .notified, .needsAttention, .offline].contains(activity)
    }
}

/// A rounded tile for the program a session runs: an agent's mark on its color, a status-reporting program's
/// initial, or a terminal prompt.
struct ProgramTile: View {
    /// The agent or program, such as "claude", or "" for a terminal.
    let program: String
    var size: CGFloat = 18

    init(program: String, size: CGFloat = 18) { self.program = program.lowercased(); self.size = size }
    init(session: Session, size: CGFloat = 18) { self.init(program: session.agentIdentity ?? session.programStatus?.app ?? "", size: size) }

    private var color: Color {
        switch program {
        case "claude": return Color(red: 0.76, green: 0.37, blue: 0.24)
        case "codex": return Color(red: 0.06, green: 0.64, blue: 0.5)
        case "pi": return Color(red: 0.43, green: 0.34, blue: 0.81)
        case "agy", "antigravity": return Color(red: 0.2, green: 0.45, blue: 0.9)
        case "durable": return Color(red: 0.18, green: 0.49, blue: 0.6)
        case "": return Color(red: 0.27, green: 0.3, blue: 0.34)
        default: return Color(red: 0.36, green: 0.42, blue: 0.5)
        }
    }

    @ViewBuilder private var mark: some View {
        switch program {
        case "claude": Image(systemName: "asterisk").font(.system(size: size * 0.55, weight: .bold))
        case "codex": Image(systemName: "chevron.left.forwardslash.chevron.right").font(.system(size: size * 0.42, weight: .bold))
        case "pi": Text("π").font(.system(size: size * 0.68, weight: .semibold, design: .serif)).offset(y: -size * 0.04)
        case "agy", "antigravity": Image(systemName: "arrow.up").font(.system(size: size * 0.5, weight: .heavy))
        case "durable": Image(systemName: "infinity").font(.system(size: size * 0.5, weight: .bold))
        case "": Text(">_").font(.system(size: size * 0.42, weight: .heavy, design: .monospaced))
        default: Text(program.prefix(1).uppercased()).font(.system(size: size * 0.55, weight: .bold, design: .rounded))
        }
    }

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(color.gradient)
            .overlay { mark.foregroundStyle(.white) }
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
