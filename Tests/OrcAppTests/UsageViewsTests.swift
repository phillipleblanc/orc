import AppKit
import SwiftUI
import XCTest
import OrcKit
@testable import OrcApp

final class UsageViewsTests: XCTestCase {
    private func window(_ kind: String, _ label: String, _ percent: Double, hours: Double?) -> AgentUsage.Window {
        AgentUsage.Window(kind: kind, label: label, usedPercent: percent, resetsAt: hours.map { Date().addingTimeInterval($0 * 3600 + 30) })
    }

    @MainActor func testShowsTheAgentsThatAreSetUpAndHidesTheRingsWithoutAny() async throws {
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

        XCTAssertEqual(UsageRings(model: model).summary, "Claude Fable 86% · Codex Weekly 4%")

        let host = NSHostingView(rootView: VStack(alignment: .leading, spacing: 12) {
            UsageRings(model: model)
            UsageDetails(model: model)
        }
        .padding(12).frame(width: 330, height: 360, alignment: .topLeading))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 330, height: 360), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(200))
        host.layoutSubtreeIfNeeded()
        if let directory = ProcessInfo.processInfo.environment["ORC_WINDOW_SNAPSHOT_DIR"] {
            for appearance in [NSAppearance.Name.aqua, .darkAqua] {
                window.appearance = NSAppearance(named: appearance)
                try await Task.sleep(for: .milliseconds(100))
                let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                let url = URL(fileURLWithPath: directory)
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                    .write(to: url.appendingPathComponent("usage-\(appearance == .aqua ? "light" : "dark").png"))
            }
        }

        // Agents that are not set up are left out, and with none there are no rings.
        model.providers = model.providers.map { AgentUsage(provider: $0.provider, name: $0.name, plan: nil, windows: [], status: .unavailable, error: "not signed in", updatedAt: nil) }
        XCTAssertEqual(model.visible, [])
    }
}
