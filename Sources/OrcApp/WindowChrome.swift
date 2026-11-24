import AppKit
import SwiftUI
import CGhostty

/// The window's colors, taken from the terminal's so the window and its terminal read as one surface: the
/// terminal's background behind the terminal, a darker shade of it for the sidebar, and lines and fills mixed
/// from the background and the text color.
struct TerminalTheme: Equatable, Sendable {
    struct RGB: Equatable, Sendable {
        var red: Double, green: Double, blue: Double

        init(red: Double, green: Double, blue: Double) { self.red = red; self.green = green; self.blue = blue }
        init(_ color: ghostty_config_color_s) {
            self.init(red: Double(color.r) / 255, green: Double(color.g) / 255, blue: Double(color.b) / 255)
        }
        init(hex: UInt32) {
            self.init(red: Double(hex >> 16 & 0xff) / 255, green: Double(hex >> 8 & 0xff) / 255, blue: Double(hex & 0xff) / 255)
        }

        /// Relative luminance, from 0 for black to 1 for white.
        var luminance: Double {
            func linear(_ value: Double) -> Double { value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4) }
            return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
        }
        /// This color moved `amount` of the way to `other`.
        func mixed(with other: RGB, _ amount: Double) -> RGB {
            RGB(red: red + (other.red - red) * amount, green: green + (other.green - green) * amount, blue: blue + (other.blue - blue) * amount)
        }
        var nsColor: NSColor { NSColor(srgbRed: red, green: green, blue: blue, alpha: 1) }
        var color: Color { Color(nsColor: nsColor) }
    }

    var background: RGB
    var foreground: RGB

    /// Ghostty's own colors, for a configuration that does not give its colors.
    static let ghosttyDefault = TerminalTheme(background: RGB(hex: 0x282c34), foreground: RGB(hex: 0xffffff))

    var isDark: Bool { background.luminance < 0.18 }
    /// The sidebar: darker than the terminal, a little for a light theme.
    var sidebar: RGB { background.mixed(with: RGB(red: 0, green: 0, blue: 0), isDark ? 0.3 : 0.04) }
    /// Dividers between the window's parts.
    var line: RGB { background.mixed(with: foreground, 0.14) }
}

/// An icon button for the window's top rows and the sidebar's footer, highlighted under the pointer.
struct ChromeButton: View {
    let title: String
    let systemImage: String
    /// The keyboard shortcut the tooltip names, such as "⌘N".
    var shortcut: String? = nil
    let action: () -> Void
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage).labelStyle(.iconOnly)
                .font(.system(size: 13))
                .frame(width: 28, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(hovering && isEnabled ? .primary : .secondary)
        .opacity(isEnabled ? 1 : 0.4)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(hovering && isEnabled ? 0.08 : 0)))
        .onHover { hovering = $0 }
        .help(shortcut.map { "\(title) (\($0))" } ?? title)
    }
}
