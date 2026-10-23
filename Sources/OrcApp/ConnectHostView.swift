import SwiftUI
import OrcKit

/// Pairs another Mac to show its sessions, from a link copied on that Mac, and lists the Macs paired so far.
struct ConnectHostView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var link = ""
    @State private var name = ""
    /// Whether the name was typed, rather than taken from the link.
    @State private var named = false
    @State private var working = false
    @State private var error: String?
    @State private var paired: RemoteHost?
    @State private var hosts: [RemoteHost] = (try? RemoteHosts.list()) ?? []
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Connect to a Mac").font(.title2.bold())
            Text("Show another Mac's sessions here. In Orc on that Mac, choose Pair Device…, then Computer; name this Mac, choose how it reaches that Mac, and Copy Link. Paste the link here.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Grid(alignment: .leadingFirstTextBaseline, verticalSpacing: 12) {
                GridRow {
                    Text("Link")
                    SecureField("Pairing link", text: $link).textFieldStyle(.roundedBorder).accessibilityIdentifier("host-link")
                }
                GridRow {
                    Text("Name")
                    TextField("The other Mac's name", text: Binding(get: { name }, set: { name = $0; named = true }))
                        .textFieldStyle(.roundedBorder).accessibilityIdentifier("host-name")
                }
            }
            Text("The link gives full control of that Mac's sessions. Orc keeps it on this Mac, readable only by you.")
                .font(.caption).foregroundStyle(.secondary)
            if let paired { Label("Paired with \(paired.name)", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Spacer()
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
                if let paired {
                    Button("Show \(paired.name)") { HostSelection.switchTo(paired) }
                        .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                        .help("Orc reopens showing that Mac's sessions")
                } else {
                    Button(working ? "Connecting…" : "Connect") { Task { await connect() } }
                        .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                        .disabled(working || link.isEmpty || trimmedName.isEmpty)
                }
            }
            if !hosts.isEmpty {
                Divider()
                Text("Paired Macs").font(.headline)
                ForEach(hosts) { host in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(host.name)
                            Text(host.endpoint).font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                        Spacer()
                        let shown = host.id == HostSelection.current?.id
                        Button("Forget", role: .destructive) { forget(host) }.disabled(shown)
                            .help(shown ? "Show This Mac first" : "Remove this Mac from Orc. Revoke its access on that Mac too, under Computer Access.")
                    }
                }
            }
        }
        .padding(24).frame(width: 540).disabled(working)
        .onChange(of: link) { _, value in
            paired = nil; error = nil
            if !named, let pairing = try? Pairing.parse(value) { name = RemoteHost.suggestedName(endpoint: pairing.endpoint) }
        }
    }

    private func connect() async {
        working = true; error = nil
        defer { working = false }
        do {
            let host = try RemoteHosts.save(try await RemoteHosts.verify(link: link, name: trimmedName))
            hosts = (try? RemoteHosts.list()) ?? []
            paired = host
        } catch { self.error = error.localizedDescription }
    }

    private func forget(_ host: RemoteHost) {
        do {
            try RemoteHosts.remove(host.id)
            hosts = (try? RemoteHosts.list()) ?? []
        } catch { self.error = error.localizedDescription }
    }
}
