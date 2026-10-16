import SwiftUI
import AppKit
import OrcKit

/// Pairs a phone (Orca Mobile) or another computer (Orc for Windows) with this Mac's runtime.
struct PairDeviceView: View {
    enum Device: Hashable { case phone, computer }
    @Environment(\.dismiss) private var dismiss
    @State private var device: Device = .phone
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Pair Device").font(.title2.bold())
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            Picker("Device", selection: $device) {
                Text("Phone").tag(Device.phone)
                Text("Computer").tag(Device.computer)
            }.pickerStyle(.segmented).labelsHidden().disabled(working)
            switch device {
            case .phone: PhonePairingPane(working: $working)
            case .computer: ComputerPairingPane(working: $working)
            }
        }.padding(24).frame(width: 560).interactiveDismissDisabled(working)
    }
}

/// A sheet gives a scroll view no height of its own, so a device list is as tall as its rows, up to about two and a half.
private func deviceListHeight(_ rows: Int) -> CGFloat { min(130, CGFloat(rows) * 56) }

private struct PhonePairingPane: View {
    @Binding var working: Bool
    @State private var status: PhonePairingStatus?
    @State private var address = ""
    @State private var offer: PairingOffer?
    @State private var qr: CGImage?
    @State private var error: String?
    @State private var copied = false
    private var paired: Bool { status?.devices.contains(where: { $0.id == offer?.deviceId && $0.isPaired }) == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Connect your phone to the same Wi-Fi or Tailscale network. In Orca Mobile, choose Pair and scan the code.")
                .foregroundStyle(.secondary)
            HStack {
                Picker("Mac address", selection: $address) {
                    Text("Choose an address").tag("")
                    ForEach(status?.interfaces ?? []) { item in
                        Text("\(item.address) — \(item.name)").tag(item.address)
                    }
                }.disabled(working)
                Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }
                    .help("Refresh network addresses and phones").disabled(working)
            }
            if let offer {
                if paired {
                    Label("Phone paired", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                } else if let qr {
                    HStack {
                        Spacer()
                        Image(decorative: qr, scale: 1).interpolation(.none).resizable().scaledToFit()
                            .frame(width: 290, height: 290).padding(16).background(.white)
                            .accessibilityLabel("Phone pairing QR code")
                        Spacer()
                    }
                    Text("This code grants access to your sessions. Keep it private.").font(.caption).foregroundStyle(.secondary)
                }
                Text(offer.endpoint).font(.caption.monospaced()).textSelection(.enabled)
            }
            HStack {
                Button(working ? "Working…" : paired ? "Pair Another Phone" : "Generate QR Code") {
                    Task { await generate() }
                }.buttonStyle(.borderedProminent).disabled(working || address.isEmpty)
                if let offer, !paired {
                    Button(copied ? "Copied" : "Copy Link") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(offer.pairingUrl, forType: .string)
                        copied = true
                    }.disabled(working)
                    Button("Replace Code") { Task { await generate(rotate: true) } }
                        .help("Invalidate the unused code and generate another. Paired phones keep access.")
                        .disabled(working)
                }
            }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let devices = status?.devices, !devices.isEmpty {
                Divider()
                Text("Phone Access").font(.headline)
                ScrollView {
                    VStack(spacing: 10) {
                        ForEach(devices) { phone in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(phone.name)
                                    Text(phone.isPaired ? "Paired" : "Awaiting pairing").font(.caption).foregroundStyle(.secondary)
                                    Text(String(phone.id.prefix(8))).font(.caption.monospaced()).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("Revoke", role: .destructive) { Task { await revoke(phone) } }.disabled(working)
                            }
                        }
                    }
                }.frame(height: deviceListHeight(devices.count))
            }
        }
        .onChange(of: address) { _, _ in offer = nil; qr = nil; copied = false }
        .task {
            await refresh()
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { break }
                if !working { await refresh(quiet: true) }
            }
        }
    }

    private func refresh(quiet: Bool = false) async {
        do {
            let updated = try await PhonePairingService.status()
            guard !Task.isCancelled else { return }
            status = updated
            if !updated.interfaces.contains(where: { $0.address == address }) { address = updated.defaultAddress ?? "" }
            if let offer, !updated.devices.contains(where: { $0.id == offer.deviceId }) { self.offer = nil; qr = nil }
            if !quiet { error = nil }
        } catch { if !quiet { self.error = error.localizedDescription } }
    }

    private func generate(rotate: Bool = false) async {
        working = true; error = nil; offer = nil; qr = nil; copied = false
        defer { working = false }
        do {
            let created = try await PhonePairingService.create(address: address, rotate: rotate)
            offer = created
            qr = try PhonePairingQR(link: created.pairingUrl).image
            await refresh(quiet: true)
        } catch { self.error = error.localizedDescription }
    }

    private func revoke(_ phone: PhoneDevice) async {
        working = true; error = nil
        defer { working = false }
        do {
            try await PhonePairingService.revoke(deviceId: phone.id)
            if offer?.deviceId == phone.id { offer = nil; qr = nil }
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
}

private struct ComputerPairingPane: View {
    @Binding var working: Bool
    @State private var status: DesktopPairingStatus?
    @State private var name = DesktopPairingService.defaultName
    @State private var address = ""
    @State private var offer: PairingOffer?
    @State private var error: String?
    private var paired: Bool { status?.devices.contains(where: { $0.id == offer?.deviceId && $0.isPaired }) == true }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Let a computer on the same network, such as one running Orc for Windows, view and drive this Mac's sessions. Copy the link and paste it into the computer's Host page.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Grid(alignment: .leadingFirstTextBaseline, verticalSpacing: 12) {
                GridRow {
                    Text("Computer name")
                    TextField("Computer name", text: $name).textFieldStyle(.roundedBorder).labelsHidden().disabled(working)
                }
                GridRow {
                    Text("Mac address")
                    HStack {
                        Picker("Mac address", selection: $address) {
                            Text("Choose an address").tag("")
                            ForEach(status?.hostnames ?? [], id: \.self) { host in
                                Text("\(host) — this Mac's local name").tag(host)
                            }
                            ForEach(status?.interfaces ?? []) { item in
                                Text("\(item.address) — \(item.name)").tag(item.address)
                            }
                        }.labelsHidden().disabled(working)
                            .help("The local name keeps working when the Mac's address changes")
                        Button { Task { await refresh() } } label: { Image(systemName: "arrow.clockwise") }
                            .help("Refresh network addresses and computers").disabled(working)
                    }
                }
            }
            if let offer {
                if paired {
                    Label("Computer paired", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                } else {
                    Label("Link copied. Paste it into the computer's Host page and connect.", systemImage: "doc.on.clipboard")
                    Text("The link gives full control of this Mac's sessions. Paste it only into Orc for Windows.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text(offer.endpoint).font(.caption.monospaced()).textSelection(.enabled)
            }
            HStack {
                Button(working ? "Working…" : "Copy Link") { Task { await copyLink() } }
                    .buttonStyle(.borderedProminent).disabled(working || address.isEmpty || trimmedName.isEmpty)
                if offer != nil, !paired {
                    Button("Replace Link") { Task { await copyLink(rotate: true) } }
                        .help("Invalidate the unused link and copy another. Paired computers keep access.")
                        .disabled(working)
                }
            }
            if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if let devices = status?.devices, !devices.isEmpty {
                Divider()
                Text("Computer Access").font(.headline)
                ScrollView {
                    VStack(spacing: 10) {
                        ForEach(devices) { computer in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(computer.name)
                                    Text(state(of: computer)).font(.caption).foregroundStyle(.secondary)
                                    Text(String(computer.id.prefix(8))).font(.caption.monospaced()).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button("Revoke", role: .destructive) { Task { await revoke(computer) } }.disabled(working)
                            }
                        }
                    }
                }.frame(height: deviceListHeight(devices.count))
            }
        }
        .onChange(of: address) { _, _ in offer = nil }
        .onChange(of: name) { _, _ in offer = nil }
        .task {
            await refresh()
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { break }
                if !working { await refresh(quiet: true) }
            }
        }
    }

    private func state(of computer: DesktopDevice) -> String {
        if computer.connected { return "Connected" }
        guard computer.isPaired else { return "Awaiting pairing" }
        return "Last seen " + Date(timeIntervalSince1970: computer.lastSeenAt / 1000).formatted(.relative(presentation: .named))
    }

    private func refresh(quiet: Bool = false) async {
        do {
            let updated = try await DesktopPairingService.status()
            guard !Task.isCancelled else { return }
            status = updated
            if !updated.offers(address) { address = updated.defaultAddress ?? "" }
            if let offer, !updated.devices.contains(where: { $0.id == offer.deviceId }) { self.offer = nil }
            if !quiet { error = nil }
        } catch { if !quiet { self.error = error.localizedDescription } }
    }

    private func copyLink(rotate: Bool = false) async {
        working = true; error = nil; offer = nil
        defer { working = false }
        do {
            let created = try await DesktopPairingService.create(address: address, name: trimmedName, rotate: rotate)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(created.pairingUrl, forType: .string)
            offer = created
            await refresh(quiet: true)
        } catch { self.error = error.localizedDescription }
    }

    private func revoke(_ computer: DesktopDevice) async {
        working = true; error = nil
        defer { working = false }
        do {
            try await DesktopPairingService.revoke(deviceId: computer.id)
            if offer?.deviceId == computer.id { offer = nil }
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
}
