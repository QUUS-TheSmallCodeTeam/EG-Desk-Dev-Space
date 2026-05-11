// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "EGDeskGestureHelper",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "egdesk-gesture-helper", targets: ["EGDeskGestureHelper"]),
    ],
    targets: [
        .executableTarget(
            name: "EGDeskGestureHelper",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("Network"),
            ]
        ),
    ]
)
