import AppKit
import SwiftUI

/// One usage window rendered as a custom-view menu item inside the otherwise-stock
/// `NSMenu`: the window label on the left, "NN% · resets …" on the right, a thin
/// horizontal bar underneath. This is the platform's own pattern for putting a
/// control inside a standard menu (`NSMenuItem.view` — the Sound menu's volume
/// slider, Battery's charge display live inside stock menus this way).
///
/// Styling is entirely system-derived so the OS still owns the look: system fonts
/// at menu sizes, semantic label colors, the menu's own side inset, and SwiftUI's
/// stock linear `ProgressView` tinted with the system accent — shifting to
/// `.systemOrange`/`.systemRed` once the 75%/90% thresholds are crossed (the M1.2
/// amber/red behavior, now via semantic colors). No hardcoded hex, no custom fonts,
/// no fixed width beyond the menu's natural content width: the host autoresizes to
/// whatever width the menu settles on from its stock items.
enum UsageRow {
    /// The menu's own horizontal inset, so the row's label lines up with the stock
    /// text items above and below it.
    static let horizontalInset: CGFloat = 14
    /// Status value, reset time, and a substantial read-only meter.
    static let rowHeight: CGFloat = 52
    /// Initial width; the host has an autoresizing width mask, so the menu stretches
    /// it to the real content width once it lays the menu out.
    static let initialWidth: CGFloat = 264

    static func menuItem(provider: String, window: UsageWindow, resetText: String?) -> NSMenuItem {
        let item = NSMenuItem()
        let host = NSHostingView(
            rootView: UsageRowContent(provider: provider, window: window, resetText: resetText)
        )
        host.frame = NSRect(x: 0, y: 0, width: initialWidth, height: rowHeight)
        host.autoresizingMask = [.width]
        item.view = host
        return item
    }
}

private struct UsageRowContent: View {
    let provider: String
    let window: UsageWindow
    let resetText: String?

    // System font at the menu's own size — the same metric the stock rows use.
    private var menuFontSize: CGFloat { NSFont.menuFont(ofSize: 0).pointSize }
    private var pct: Int { Int(window.usedPercent.rounded()) }
    // Accent fill by default; amber then red as usage crosses 75% / 90%. All three
    // are system semantic colors — the OS supplies the actual pixels.
    private var barTint: Color {
        if window.usedPercent >= 90 { return Color(nsColor: .systemRed) }
        if window.usedPercent >= 75 { return Color(nsColor: .systemOrange) }
        return Color(nsColor: .controlAccentColor)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(provider) · \(window.label)")
                    .font(.system(size: menuFontSize))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 6)
                if let resetText {
                    Text(resetText)
                    .font(.system(size: menuFontSize - 1))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
            }
            HStack(spacing: 10) {
                Text("\(pct)%")
                    .font(.system(size: menuFontSize + 2, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .frame(width: 42, alignment: .trailing)
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color(nsColor: .quaternaryLabelColor))
                        Capsule()
                            .fill(barTint)
                            .frame(width: geometry.size.width * min(max(window.usedPercent, 0), 100) / 100)
                    }
                }
                .frame(height: 8)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(provider) \(window.label) usage")
                .accessibilityValue("\(pct) percent")
            }
        }
        .padding(.horizontal, UsageRow.horizontalInset)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
