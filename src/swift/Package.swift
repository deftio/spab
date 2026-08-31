// swift-tools-version:5.9
// spab — Swift port (skeleton; not yet implemented). No dependencies.
import PackageDescription

let package = Package(
    name: "spab",
    products: [
        .library(name: "spab", targets: ["spab"])
    ],
    dependencies: [],   // dependency-free by design
    targets: [
        .target(name: "spab", path: "Sources/spab")
    ]
)
