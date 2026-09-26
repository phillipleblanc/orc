import SwiftUI
import OrcKit

struct RuntimeSetupView: View {
    var onReady: () -> Void
    @State private var starting = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Start Fresh with Orc").font(.title2.bold())
            Text("Orc found settings from an existing Orca installation. Start fresh to create sessions using Orc’s bundled runtime.")
            Text("Your old sessions and phone pairings stay in Orca. Orc saves a backup of your old connection settings. Add your projects and pair your phone again after setup.")
                .foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            Button(starting ? "Starting…" : "Start Fresh") {
                Task {
                    starting = true; error = nil
                    defer { starting = false }
                    do {
                        _ = try await RuntimeBootstrap.startFresh()
                        onReady()
                    } catch { self.error = error.localizedDescription }
                }
            }.buttonStyle(.borderedProminent).disabled(starting)
        }.padding(24).frame(maxWidth: 480).interactiveDismissDisabled(starting)
    }
}
