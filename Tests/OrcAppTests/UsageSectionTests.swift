import AppKit
import SwiftUI
import XCTest
import OrcKit
@testable import OrcApp

final class UsageSectionTests: XCTestCase {
    private func window(_ kind: String, _ label: String, _ percent: Double, hours: Double?) -> AgentUsage.Window {
        AgentUsage.Window(kind: kind, label: label, usedPercent: percent, resetsAt: hours.map { Date().addingTimeInterval($0 * 3600 + 30) })
    }

    @MainActor func testShowsTheAgentsThatAreSetUpAndHidesTheSectionWithoutAny() async throws {
        _ = NSApplication.shared
        let model = UsageModel(monitor: false)
        model.providers = [
            AgentUsage(provider: "claude", name: "Claude", plan: "Max 5x",
                       windows: [window("session", "Session", 34, hours: 2.2), window("weekly", "Weekly", 72, hours: 50), window("model", "Fable", 86, hours: 50)],
                       status: .ok, error: nil, updatedAt: Date()),
            AgentUsage(provider: "codex", name: "Codex", plan: "Pro", windows: [window("weekly", "Weekly", 4, hours: 163)], resetCredits: 2,
                       status: .error, error: "Could not reach ChatGPT", updatedAt: Date().addingTimeInterval(-600))
        ]
        XCTAssertEqual(model.visible.map(\.name), ["Claude", "Codex"])

        let host = NSHostingView(rootView: VStack(spacing: 0) { Spacer(); UsageSection(model: model).padding(.bottom, 12) }
            .frame(width: 260, height: 300).background(Color(nsColor: .windowBackgroundColor)))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 260, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        defer { window.close() }
        func settle(_ name: String) async throws {
            try await Task.sleep(for: .milliseconds(200))
            host.layoutSubtreeIfNeeded()
            guard let directory = ProcessInfo.processInfo.environment["ORC_WINDOW_SNAPSHOT_DIR"] else { return }
            for appearance in [NSAppearance.Name.aqua, .darkAqua] {
                window.appearance = NSAppearance(named: appearance)
                try await Task.sleep(for: .milliseconds(100))
                let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                let url = URL(fileURLWithPath: directory)
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                    .write(to: url.appendingPathComponent("usage-\(name)-\(appearance == .aqua ? "light" : "dark").png"))
            }
        }
        let defaults = UserDefaults.standard
        let expanded = defaults.object(forKey: "usageExpanded")
        defer { defaults.set(expanded, forKey: "usageExpanded") }
        defaults.set(true, forKey: "usageExpanded")
        try await settle("expanded")
        defaults.set(false, forKey: "usageExpanded")
        try await settle("collapsed")

        // Agents that are not set up are left out, and with none the section is gone.
        model.providers = model.providers.map { AgentUsage(provider: $0.provider, name: $0.name, plan: nil, windows: [], status: .unavailable, error: "not signed in", updatedAt: nil) }
        XCTAssertEqual(model.visible, [])
    }
}
