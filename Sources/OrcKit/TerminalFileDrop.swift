import AppKit

/// A local file dropped onto a terminal.
public struct DroppedFile: Equatable, Sendable {
    public let url: URL

    public init(url: URL) throws {
        guard url.isFileURL, url.host == nil || url.host == "" || url.host == "localhost" else {
            throw OrcError("Drop a local file, not a web link.")
        }
        guard !url.path.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            throw OrcError("File names cannot contain terminal control characters or newlines.")
        }
        self.url = url.standardizedFileURL
        try validate()
    }
    public func validate() throws {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey])
        guard values.isRegularFile == true, FileManager.default.isReadableFile(atPath: url.path) else {
            throw OrcError("“\(url.lastPathComponent)” is not a readable file. Drop files rather than folders.")
        }
    }
}

public enum TerminalFileDrop {
    public static let types: [NSPasteboard.PasteboardType] = [.fileURL, .png, .tiff]
    public static let maximumImageBytes = 20 * 1024 * 1024
    public static func accepts(_ pasteboard: NSPasteboard) -> Bool {
        pasteboard.availableType(from: types) != nil
    }
    public static func load(_ pasteboard: NSPasteboard, directory: URL = Pairing.directory.appendingPathComponent("attachments")) throws -> [DroppedFile] {
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            return try urls.map { try DroppedFile(url: $0) }
        }
        if let type = pasteboard.availableType(from: [.png, .tiff]), let data = pasteboard.data(forType: type) {
            return [try saveImage(data, directory: directory)]
        }
        throw OrcError("Drop local files or images into the terminal.")
    }
    public static func writes(_ files: [DroppedFile]) throws -> [String] {
        try files.map { file in
            try file.validate()
            // Ghostty's text API adds paste framing. Supplying escape sequences
            // here would paste them literally. Quote paths for shell prompts,
            // and leave a separator for the user's next input without submitting.
            return shellQuote(file.url.path) + " "
        }
    }
    /// Image data without a file is kept as a private PNG: the program it was
    /// pasted into may read it later, for example when a conversation resumes.
    public static func saveImage(_ data: Data, directory: URL) throws -> DroppedFile {
        guard data.count <= maximumImageBytes else { throw OrcError("Dropped images must be 20 MiB or smaller.") }
        guard let image = NSBitmapImageRep(data: data), let png = image.representation(using: .png, properties: [:]) else {
            throw OrcError("The dropped image could not be decoded.")
        }
        guard png.count <= maximumImageBytes else { throw OrcError("Dropped images must be 20 MiB or smaller as PNG.") }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = directory.appendingPathComponent("image-" + UUID().uuidString + ".png")
        try png.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return try DroppedFile(url: url)
    }
}
