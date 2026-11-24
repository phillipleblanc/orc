import AppKit
import SwiftUI
import OrcKit

/// The agents' subscription usage, which the runtime fetches. It is checked at launch, when Orc becomes active, and
/// every fifteen minutes while it is active; the runtime refetches only usage that is minutes old.
@MainActor final class UsageModel: ObservableObject {
    @Published var providers: [AgentUsage] = []
    @Published private(set) var fetching = false
    private var timer: Timer?
    private var activation: NSObjectProtocol?
    private static let interval: TimeInterval = 15 * 60

    /// The providers the user has set up.
    var visible: [AgentUsage] { providers.filter { $0.status != .unavailable } }

    /// Without `monitor`, usage is only what is assigned to `providers`.
    init(monitor: Bool = true) {
        guard monitor else { return }
        timer = Timer.scheduledTimer(withTimeInterval: Self.interval, repeats: true) { _ in
            Task { @MainActor [weak self] in if NSApp.isActive { await self?.refresh() } }
        }
        activation = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor [weak self] in await self?.refresh() }
        }
        Task { await refresh() }
    }

    /// Asks the runtime for usage, fetched again if it is old (`stale`) or regardless (`force`).
    func refresh(_ mode: String = "stale") async {
        guard !fetching else { return }
        fetching = true
        defer { fetching = false }
        // A runtime that is not running, or that predates usage, leaves what is shown.
        guard let result = try? await RuntimeRPC.call("usage.read", ["refresh": mode], timeout: 60),
              let providers = try? AgentUsage.list(from: result) else { return }
        self.providers = providers
    }
}

/// A ring for each agent, filled to its window closest to the limit, with that window's share. Clicking shows
/// every window.
struct UsageRings: View {
    @ObservedObject var model: UsageModel
    @State private var showingDetails = false

    var body: some View {
        if !model.visible.isEmpty {
            Button { showingDetails.toggle() } label: {
                HStack(spacing: 8) {
                    ForEach(model.visible) { usage in
                        HStack(spacing: 4) {
                            UsageRing(window: usage.tightest, failed: usage.status == .error)
                            Text(usage.tightest.map { "\(Int($0.usedPercent.rounded()))%" } ?? "–")
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showingDetails, arrowEdge: .top) { UsageDetails(model: model) }
            .help(summary)
            .accessibilityLabel("Usage")
            .accessibilityValue(summary)
            .accessibilityIdentifier("usage")
        }
    }

    /// Each agent's window closest to its limit, or why its usage is missing.
    var summary: String {
        model.visible.compactMap { usage in
            usage.tightest.map { "\(usage.name) \($0.label) \(Int($0.usedPercent.rounded()))%" } ?? usage.error.map { "\(usage.name): \($0)" }
        }.joined(separator: " · ")
    }
}

/// A ring filled to a window's share used: orange from 60%, red from 80%, and orange while usage can't be fetched.
struct UsageRing: View {
    let window: AgentUsage.Window?
    var failed = false

    private var color: Color {
        switch UsageLevel(usedPercent: window?.usedPercent ?? 0) {
        case .normal: return failed ? .orange : Color.primary.opacity(0.75)
        case .high: return .orange
        case .critical: return .red
        }
    }

    var body: some View {
        ZStack {
            Circle().stroke(failed && window == nil ? Color.orange : Color.primary.opacity(0.15), lineWidth: 2.5)
            Circle().trim(from: 0, to: min(1, (window?.usedPercent ?? 0) / 100))
                .stroke(color, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 13, height: 13)
        .padding(1)
        .accessibilityHidden(true)
    }
}

/// Each agent's windows, their shares used and the time until they reset, with a button to fetch usage now.
struct UsageDetails: View {
    @ObservedObject var model: UsageModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Text("Usage").font(.headline)
                Spacer(minLength: 0)
                if model.fetching {
                    ProgressView().controlSize(.mini).frame(width: 16, height: 16)
                } else {
                    Button { Task { await model.refresh("force") } } label: {
                        Image(systemName: "arrow.clockwise").font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.borderless).foregroundStyle(.secondary)
                    .help(refreshHelp).accessibilityLabel("Refresh Usage")
                }
            }
            // Reset countdowns tick by the minute.
            TimelineView(.everyMinute) { context in
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(model.visible) { ProviderUsageView(usage: $0, now: context.date) }
                }
            }
        }
        .padding(14)
        .frame(width: 300)
    }

    private var refreshHelp: String {
        guard let updated = model.visible.compactMap(\.updatedAt).min() else { return "Refresh Usage" }
        return "Refresh Usage · Updated \(RelativeDateTimeFormatter().localizedString(for: updated, relativeTo: .now))"
    }
}

/// An agent's name and plan, then a row per window: its share used and the time until it resets.
struct ProviderUsageView: View {
    let usage: AgentUsage
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(usage.name).font(.callout.weight(.medium))
                if let plan = usage.plan { Text(plan).font(.caption).foregroundStyle(.secondary) }
                Spacer(minLength: 0)
                if usage.status == .error, !usage.windows.isEmpty {
                    Image(systemName: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.orange)
                        .help(staleHelp).accessibilityLabel(staleHelp)
                }
            }
            .help(headerHelp)
            if usage.windows.isEmpty {
                Text(usage.error ?? "No usage reported").font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
            ForEach(usage.windows) { UsageWindowRow(provider: usage.name, window: $0, now: now) }
        }
    }

    private var headerHelp: String {
        guard let credits = usage.resetCredits, credits > 0 else { return usage.plan.map { "\(usage.name) \($0)" } ?? usage.name }
        return "\(usage.name)\(usage.plan.map { " \($0)" } ?? "") · \(credits) free rate-limit reset\(credits == 1 ? "" : "s") available"
    }

    private var staleHelp: String {
        let age = usage.updatedAt.map { " Showing usage from \(RelativeDateTimeFormatter().localizedString(for: $0, relativeTo: now))." } ?? ""
        return "Could not refresh: \(usage.error ?? "unknown error").\(age)"
    }
}

struct UsageWindowRow: View {
    let provider: String
    let window: AgentUsage.Window
    let now: Date

    private var level: UsageLevel { UsageLevel(usedPercent: window.usedPercent) }
    private var percent: Int { Int(window.usedPercent.rounded()) }
    private var reset: String { window.resetsAt.map { formatDuration($0.timeIntervalSince(now)) } ?? "" }

    var body: some View {
        HStack(spacing: 8) {
            Text(window.label).font(.caption).foregroundStyle(.secondary).lineLimit(1).frame(width: 50, alignment: .leading)
            UsageBar(fraction: window.usedPercent / 100, color: color)
            Text("\(percent)%").font(.caption.monospacedDigit())
                .foregroundStyle(level == .normal ? AnyShapeStyle(.secondary) : AnyShapeStyle(color))
                .frame(width: 34, alignment: .trailing)
            Text(reset).font(.caption.monospacedDigit()).foregroundStyle(.tertiary).lineLimit(1)
                .frame(width: 44, alignment: .trailing)
        }
        .help(help)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(provider) \(window.label): \(percent) percent used\(window.resetsAt == nil ? "" : ", resets in \(reset)")")
    }

    private var color: Color {
        switch level {
        case .normal: return .secondary
        case .high: return .orange
        case .critical: return .red
        }
    }

    private var help: String {
        guard let resetsAt = window.resetsAt else { return "\(percent)% used" }
        let when = Calendar.current.isDate(resetsAt, inSameDayAs: now)
            ? resetsAt.formatted(date: .omitted, time: .shortened)
            : resetsAt.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute())
        return "\(percent)% used · resets in \(reset), \(when)"
    }
}

/// A thin capsule filled to the share used.
struct UsageBar: View {
    let fraction: Double
    let color: Color

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule().fill(color).frame(width: fraction > 0 ? max(4, geometry.size.width * min(1, fraction)) : 0)
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }
}
