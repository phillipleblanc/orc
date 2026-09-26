import AppKit

public enum TerminalFileDrop {
    public static let types: [NSPasteboard.PasteboardType] = [.fileURL, .png, .tiff]
    public static func accepts(_ pasteboard: NSPasteboard) -> Bool {
        pasteboard.availableType(from: types) != nil
    }
    public static func load(_ pasteboard: NSPasteboard) throws -> [ChatAttachment] {
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            return try urls.map { try ChatAttachment(url: $0) }
        }
        if let type = pasteboard.availableType(from: [.png, .tiff]), let data = pasteboard.data(forType: type) {
            return [try ChatAttachmentDrop.saveImage(data)]
        }
        throw OrcError("Drop local files or images into the terminal.")
    }
    public static func writes(_ files: [ChatAttachment]) throws -> [String] {
        try files.map { file in
            try file.validate()
            // Ghostty's text API adds paste framing. Supplying escape sequences
            // here would paste them literally. Quote paths for shell prompts,
            // and leave a separator for the user's next input without submitting.
            return shellQuote(file.url.path) + " "
        }
    }
}
