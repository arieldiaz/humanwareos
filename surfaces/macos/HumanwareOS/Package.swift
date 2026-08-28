// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "HumanwareOS",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.9.5"),
    ],
    targets: [
        .executableTarget(
            name: "HumanwareOS",
            dependencies: [
                .product(name: "Sparkle", package: "Sparkle"),
            ],
            path: "Sources/HumanwareOS"
        )
    ]
)
