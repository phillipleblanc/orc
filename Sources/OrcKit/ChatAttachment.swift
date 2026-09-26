import AppKit
import UniformTypeIdentifiers

public struct ChatAttachment: Identifiable, Equatable, Sendable {
    public let url: URL
    public var id: URL { url }
    public let name: String
    public var isImage: Bool { UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true }

    public init(url: URL, name: String? = nil) throws {
        guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost" else {
            throw OrcError("Drop a local file, not a web link.")
        }
        guard !url.path.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            throw OrcError("File names cannot contain terminal control characters or newlines.")
        }
        self.url = url.standardizedFileURL
        self.name = name ?? url.lastPathComponent
        try validate()
    }
    public func validate() throws {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey])
        guard values.isRegularFile == true, FileManager.default.isReadableFile(atPath: url.path) else {
            throw OrcError("“\(name)” is not a readable file. Drop files rather than folders.")
        }
    }
    var reference: String {
        let path = url.path
        if !path.contains(where: { $0.isWhitespace || $0 == "@" || $0 == "\"" || $0 == "'" }) { return "@" + path }
        if !path.contains("\"") { return "@\"" + path + "\"" }
        if !path.contains("'") { return "@'" + path + "'" }
        return "@\"" + url.absoluteString + "\""
    }
}

public struct ChatDraft: Equatable {
    public var text = ""
    public var attachments: [ChatAttachment] = []
    public var loadingAttachments = false
    public init() {}
    public var isEmpty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty }
    public mutating func append(_ files: [ChatAttachment]) {
        for file in files where !attachments.contains(where: { $0.id == file.id }) { attachments.append(file) }
    }
    public mutating func didSend(_ sent: ChatDraft) {
        if text == sent.text { text = "" }
        attachments.removeAll { sent.attachments.contains($0) }
    }
}

/// Provider-backed images must be saved before their temporary representation expires.
/// Retain these files after sending: agents may read them asynchronously or on resume.
public enum ChatAttachmentDrop {
    public static let types = [UTType.fileURL.identifier, UTType.image.identifier]
    public static let maximumFiles = 16
    public static let maximumImageBytes = 20 * 1024 * 1024
    public static func accepts(_ provider: NSItemProvider) -> Bool {
        types.contains { provider.hasItemConformingToTypeIdentifier($0) }
    }
    public static func load(_ providers: [NSItemProvider], directory: URL = Pairing.directory.appendingPathComponent("attachments")) async throws -> [ChatAttachment] {
        guard !providers.isEmpty, providers.count <= maximumFiles else {
            throw OrcError("Drop up to \(maximumFiles) files at a time.")
        }
        var result: [ChatAttachment] = []
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                let data = try await data(from: provider, type: UTType.fileURL.identifier)
                guard let url = URL(dataRepresentation: data, relativeTo: nil) else { throw OrcError("The dropped file URL is invalid.") }
                result.append(try ChatAttachment(url: url))
            } else if let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) {
                let data = try await data(from: provider, type: type)
                result.append(try saveImage(data, name: provider.suggestedName, directory: directory))
            } else {
                throw OrcError("Drop local files or images into Chat.")
            }
        }
        return result
    }
    private static func data(from provider: NSItemProvider, type: String) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: type) { data, error in
                if let error { continuation.resume(throwing: error) }
                else if let data { continuation.resume(returning: data) }
                else { continuation.resume(throwing: OrcError("The dropped item could not be read.")) }
            }
        }
    }
    public static func saveImage(_ data: Data, name: String? = nil, directory: URL = Pairing.directory.appendingPathComponent("attachments")) throws -> ChatAttachment {
        guard data.count <= maximumImageBytes else { throw OrcError("Dropped images must be 20 MiB or smaller.") }
        guard let image = NSBitmapImageRep(data: data), let png = image.representation(using: .png, properties: [:]) else {
            throw OrcError("The dropped image could not be decoded.")
        }
        guard png.count <= maximumImageBytes else { throw OrcError("Dropped images must be 20 MiB or smaller as PNG.") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = directory.appendingPathComponent("image-" + UUID().uuidString + ".png")
        try png.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return try ChatAttachment(url: url, name: name.flatMap { $0.isEmpty ? nil : $0 } ?? "Dropped image")
    }
}

/// Each image paste is a separate frame so vision-capable TUIs recognize it.
public enum ChatInput {
    public static func writes(_ text: String, attachments: [ChatAttachment], target: ChatTarget) throws -> [String] {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !attachments.isEmpty else { return [] }
        guard !text.hasPrefix("/") else { throw OrcError("Use Attach for agent slash commands.") }
        guard !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) && $0 != "\n" && $0 != "\t" }) else {
            throw OrcError("Messages cannot contain terminal control characters.")
        }
        guard attachments.isEmpty || target.isLocal else { throw OrcError("Local files cannot be attached to an SSH session. Transfer them to the remote host first.") }
        for attachment in attachments { try attachment.validate() }
        let imagePaste = ["claude", "openclaude", "codex", "grok"].contains(target.agent ?? "")
        let images = attachments.filter { $0.isImage && imagePaste }
        let references = attachments.filter { !$0.isImage || !imagePaste }.map(\.reference)
        let body = ([text].filter { !$0.isEmpty } + references).joined(separator: "\n")
        // Agent paste parsers tokenize paths; quoting preserves screenshot names
        // with spaces and prevents shell metacharacters from becoming input.
        var writes = images.map { "\u{1b}[200~" + shellQuote($0.url.path) + "\u{1b}[201~" }
        if !body.isEmpty {
            if !writes.isEmpty { writes[writes.count - 1] += " " }
            writes.append(body.contains("\n") ? "\u{1b}[200~" + body + "\u{1b}[201~" : body)
        }
        guard writes.reduce(0, { $0 + $1.utf8.count }) <= 64 * 1024 else { throw OrcError("Messages and file paths must be 64 KiB or smaller.") }
        return writes
    }
}
