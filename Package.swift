// swift-tools-version: 6.0
import PackageDescription
import Foundation

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path
let sodium = ProcessInfo.processInfo.environment["SODIUM_PREFIX"] ?? root + "/.build/deps/sodium"
let ghostty = root + "/.build/deps/GhosttyKit.xcframework/macos-arm64"
let cliOnly = ProcessInfo.processInfo.environment["ORC_CLI_ONLY"] == "1"

let package = Package(
    name: "Orc",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "orc", targets: ["OrcCLI"])] + (cliOnly ? [] : [.executable(name: "OrcDesktop", targets: ["OrcApp"])]),
    targets: [
        .target(name: "COrcSupport", cSettings: [.unsafeFlags(["-I", sodium + "/include"])],
                linkerSettings: [.unsafeFlags([sodium + "/lib/libsodium.a"])]),
        .target(name: "OrcKit", dependencies: ["COrcSupport"]),
        .executableTarget(name: "OrcCLI", dependencies: ["OrcKit", "COrcSupport"]),
        .testTarget(name: "OrcKitTests", dependencies: ["OrcKit"])
    ] + (cliOnly ? [] : [
        .systemLibrary(name: "CGhostty"),
        .executableTarget(name: "OrcApp", dependencies: ["OrcKit", "CGhostty"],
            swiftSettings: [.unsafeFlags(["-I", root + "/.build/deps/ghostty-include"])],
            linkerSettings: [.unsafeFlags([ghostty + "/libghostty-fat.a"]), .linkedLibrary("c++"),
                .linkedFramework("AppKit"), .linkedFramework("Carbon"), .linkedFramework("Metal"),
                .linkedFramework("QuartzCore"), .linkedFramework("CoreText"), .linkedFramework("CoreGraphics"),
                .linkedFramework("IOSurface"), .linkedFramework("IOKit"), .linkedFramework("UniformTypeIdentifiers")])
    ]),
    swiftLanguageModes: [.v5]
)
