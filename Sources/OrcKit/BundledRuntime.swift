import Foundation
import CryptoKit
import Security
import COrcSupport

struct BundledRuntime {
    static let identifier = "dev.phillipleblanc.orc.runtime"
    let executable: URL
    let version: String

    static var currentExecutable: URL {
        var path = [CChar](repeating: 0, count: 4096)
        guard orc_executable_path(&path, UInt32(path.count)) == 0 else { return Bundle.main.executableURL! }
        return URL(fileURLWithPath: String(cString: path)).resolvingSymlinksInPath()
    }

    static func hostBundle(executable: URL = currentExecutable) throws -> URL {
        let actual = executable.resolvingSymlinksInPath()
        let contents = actual.deletingLastPathComponent().deletingLastPathComponent()
        guard contents.lastPathComponent == "Contents",
              ["MacOS", "Resources"].contains(actual.deletingLastPathComponent().lastPathComponent),
              contents.deletingLastPathComponent().pathExtension == "app" else {
            throw OrcError("The bundled runtime is unavailable. Run the installed Orc app or its linked CLI. For development, set ORCA_APP_EXECUTABLE explicitly.")
        }
        return contents.deletingLastPathComponent()
    }

    static func verify(host: URL) throws -> BundledRuntime {
        let resources = host.appendingPathComponent("Contents/Resources")
        let runtime = host.appendingPathComponent("Contents/Helpers/Orca.app")
        do {
            let lock = try jsonObject(Data(contentsOf: resources.appendingPathComponent("orca-runtime-lock.json")))
            let origin = try jsonObject(Data(contentsOf: resources.appendingPathComponent("orca-runtime-origin.json")))
            guard lock["schemaVersion"] as? Int == 1, lock["architecture"] as? String == "arm64",
                  lock["platform"] as? String == "darwin", origin["kind"] as? String == "source",
                  let source = lock["sourceBuild"] as? [String: Any], source["profileMode"] as? String == "orc-managed",
                  let expected = source["bundle"] as? [String: Any], expected["identifier"] as? String == identifier,
                  let version = expected["version"] as? String,
                  let team = expected["teamIdentifier"] as? String, team.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil else {
                throw OrcError("Unsupported bundled runtime manifest.")
            }
            let recipe = SHA256.hash(data: try JSONSerialization.data(withJSONObject: lock, options: [.sortedKeys, .withoutEscapingSlashes]))
                .map { String(format: "%02x", $0) }.joined()
            let provenance = try jsonObject(Data(contentsOf: runtime.appendingPathComponent("Contents/Resources/orc-build.json")))
            guard origin["recipeSHA256"] as? String == recipe, provenance["recipeSHA256"] as? String == recipe else {
                throw OrcError("Bundled runtime build inputs do not match Orc.")
            }
            let info = try PropertyListSerialization.propertyList(from: Data(contentsOf: runtime.appendingPathComponent("Contents/Info.plist")), format: nil) as? [String: Any]
            guard info?["CFBundleIdentifier"] as? String == identifier,
                  info?["CFBundleShortVersionString"] as? String == version,
                  info?["CFBundleVersion"] as? String == version,
                  info?["CFBundleName"] as? String == "Orc Runtime", info?["LSUIElement"] as? Bool == true else {
                throw OrcError("Bundled runtime version or accessory configuration is invalid.")
            }
            let executable = runtime.appendingPathComponent("Contents/MacOS/Orca")
            let header = try FileHandle(forReadingFrom: executable)
            defer { try? header.close() }
            guard try header.read(upToCount: 8) == Data([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]) else {
                throw OrcError("Bundled runtime must be an Apple Silicon executable.")
            }
            try checkSignature(host)
            try checkSignature(runtime, requirement: "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(team)\"")
            return BundledRuntime(executable: executable, version: version)
        } catch {
            throw OrcError("Cannot verify the bundled runtime. Rebuild or reinstall the complete Orc.app. \(error.localizedDescription)")
        }
    }

    private static func checkSignature(_ app: URL, requirement: String? = nil) throws {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code else { throw OrcError("Missing app signature.") }
        var rule: SecRequirement?
        if let requirement, SecRequirementCreateWithString(requirement as CFString, [], &rule) != errSecSuccess {
            throw OrcError("Invalid runtime signing requirement.")
        }
        let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckNestedCode | kSecCSCheckAllArchitectures)
        guard SecStaticCodeCheckValidity(code, flags, rule) == errSecSuccess else { throw OrcError("App signature or sealed resources are invalid.") }
    }
}
