// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OrcHolder",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "orc-holder", targets: ["OrcHolder"])],
    targets: [
        .target(name: "CHolder"),
        .executableTarget(name: "OrcHolder", dependencies: ["CHolder"])
    ],
    swiftLanguageModes: [.v5]
)
