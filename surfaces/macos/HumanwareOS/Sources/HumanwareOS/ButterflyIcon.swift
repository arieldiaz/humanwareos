import AppKit

/// The menu bar icon: the canonical paired half-butterfly/half-fox app mark,
/// loaded from AppIcon.icns and rendered as a template. AppKit uses the mark's
/// alpha coverage as a monochrome silhouette that follows the menu bar.
enum ButterflyIcon {
    static func image(pointSize: CGFloat) -> NSImage {
        guard let source = NSImage(named: NSImage.Name("AppIcon")) else {
            let fallback = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "HumanwareOS")!
            fallback.isTemplate = true
            return fallback
        }

        // AppIcon carries generous square icon padding. Crop to the paired
        // animals before scaling so the silhouette occupies the same vertical
        // presence as Apple's 18–19 pt status icons.
        let crop = NSRect(
            x: source.size.width * 0.10,
            y: source.size.height * 0.15,
            width: source.size.width * 0.80,
            height: source.size.height * 0.72
        )
        let targetSize = NSSize(width: pointSize * 1.05, height: pointSize)
        let image = NSImage(size: targetSize)
        image.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .high
        source.draw(
            in: NSRect(origin: .zero, size: targetSize),
            from: crop,
            operation: .copy,
            fraction: 1
        )
        image.unlockFocus()
        image.isTemplate = true
        return image
    }
}
