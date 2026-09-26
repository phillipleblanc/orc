import Foundation
import UniformTypeIdentifiers

public struct MarkdownFileLink: Equatable {
    public let fileURL: URL
    public let fragment: String?

    public init?(_ input: URL, relativeTo directory: URL) {
        var url = input
        // A bare filename with a line suffix is parsed as a URL scheme.
        if input.absoluteString.range(of: #"^[^/:]+\.(?:md|markdown|mdx):\d+(?::\d+)?(?:#.*)?$"#,
                                      options: [.regularExpression, .caseInsensitive]) != nil,
           let relative = URL(string: "./" + input.absoluteString) { url = relative }
        guard directory.isFileURL, url.scheme == nil || url.isFileURL,
              url.host == nil || url.host == "" || (url.isFileURL && url.host == "localhost") else { return nil }
        var path = url.path
        if let suffix = path.range(of: #":\d+(?::\d+)?$"#, options: .regularExpression) {
            path.removeSubrange(suffix)
        }
        guard ["md", "markdown", "mdx"].contains((path as NSString).pathExtension.lowercased()) else { return nil }
        if path.hasPrefix("~/") { path = (path as NSString).expandingTildeInPath }
        guard !path.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }
        fileURL = (path.hasPrefix("/") ? URL(fileURLWithPath: path) : directory.appendingPathComponent(path)).standardizedFileURL
        fragment = URLComponents(url: url, resolvingAgainstBaseURL: true)?.fragment
    }
}

public struct MarkdownDocument: Equatable, Sendable {
    public let url: URL
    public let source: String
    public static let maximumBytes = 4 * 1024 * 1024

    public static func load(_ url: URL) throws -> Self {
        let data = try readFile(url, maximumBytes: maximumBytes)
        guard let source = String(data: data, encoding: .utf8) else {
            throw OrcError("This Markdown file is not UTF-8 text.")
        }
        return Self(url: url, source: source)
    }
    static func readFile(_ url: URL, maximumBytes: Int) throws -> Data {
        guard url.isFileURL else { throw OrcError("Only local files can be previewed.") }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true else { throw OrcError("The link does not point to a regular file.") }
        guard (values.fileSize ?? 0) <= maximumBytes else { throw OrcError("This file is too large to preview (limit: \(maximumBytes / 1024 / 1024) MiB).") }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: maximumBytes + 1) ?? Data()
        guard data.count <= maximumBytes else { throw OrcError("This file is too large to preview.") }
        return data
    }
}

/// Markdown images are limited to the document's directory. Resolve symlinks
/// before checking containment so a link cannot grant access to another folder.
public struct MarkdownImageLoader: Sendable {
    public static let scheme = "orc-markdown-image"
    public let directory: URL
    public init(directory: URL) { self.directory = directory.resolvingSymlinksInPath().standardizedFileURL }
    public func load(_ request: URL) throws -> (data: Data, mimeType: String) {
        guard directory.isFileURL, request.scheme == Self.scheme, request.host == "local" else { throw OrcError("Unsupported image URL.") }
        let file = URL(fileURLWithPath: request.path).resolvingSymlinksInPath().standardizedFileURL
        let prefix = directory.path.hasSuffix("/") ? directory.path : directory.path + "/"
        guard file.path.hasPrefix(prefix), let type = UTType(filenameExtension: file.pathExtension),
              type.conforms(to: .image), let mimeType = type.preferredMIMEType else {
            throw OrcError("Only images inside the Markdown file's folder can be previewed.")
        }
        return (try MarkdownDocument.readFile(file, maximumBytes: 20 * 1024 * 1024), mimeType)
    }
}
