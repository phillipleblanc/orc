import SwiftUI
import AppKit
import OrcKit

struct PhonePairingView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var status: PhonePairingStatus?
    @State private var address = ""
    @State private var offer: PhonePairingOffer?
    @State private var qr: CGImage?
    @State private var working = false
    @State private var error: String?
    @State private var copied = false
    private var paired: Bool { status?.devices.contains(where: { $0.id == offer?.deviceId && $0.isPaired }) == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Pair Phone").font(.title2.bold())
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
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
                }.frame(maxHeight: 130)
            }
        }.padding(24).frame(width: 560).interactiveDismissDisabled(working)
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
