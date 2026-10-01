import AppKit
import SwiftUI
import CGhostty
import OrcKit

/// The embedded Ghostty app. Terminals use the user's Ghostty settings when Ghostty is installed, and
/// Orc's own defaults otherwise; either way, the settings Orc's terminals depend on come last.
@MainActor final class GhosttyEngine: ObservableObject {
    static let shared = GhosttyEngine()
    private(set) var app: ghostty_app_t?
    private var config: ghostty_config_t?
    private var appearanceObservation: NSKeyValueObservation?
    /// The configured `background-opacity`; below 1, a window showing a terminal must be translucent.
    @Published private(set) var backgroundOpacity: Double = 1

    /// Settings Orc's terminals depend on, applied over any user configuration. Terminals are replaced
    /// as sessions are selected, so closing one must not ask for confirmation, and they run `orc attach`
    /// rather than a shell.
    static let requiredSettings = "confirm-close-surface = false\nshell-integration = none\n"

    /// The user's Ghostty configuration files that exist, in the order Ghostty loads them; later
    /// files override earlier ones. Orc loads them itself because libghostty's default-file loader
    /// writes a template configuration into the user's Ghostty folder when there is none.
    nonisolated static func userConfigFiles() -> [URL] {
        let environment = ProcessInfo.processInfo.environment
        let home = environment["HOME"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser
        let xdg = environment["XDG_CONFIG_HOME"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
            ?? home.appendingPathComponent(".config")
        let appSupport = home.appendingPathComponent("Library/Application Support/com.mitchellh.ghostty")
        return [xdg.appendingPathComponent("ghostty/config"), xdg.appendingPathComponent("ghostty/config.ghostty"),
                appSupport.appendingPathComponent("config"), appSupport.appendingPathComponent("config.ghostty")]
            .filter { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// Whether the user has Ghostty, as an installed app or a configuration file.
    nonisolated static var usesGhosttySettings: Bool {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.mitchellh.ghostty") != nil || !userConfigFiles().isEmpty
    }

    /// A finalized configuration: Ghostty's defaults and the user's Ghostty files, or Orc's bundled
    /// defaults, followed by `requiredSettings`.
    static func makeConfig(usingGhosttySettings: Bool = usesGhosttySettings) -> ghostty_config_t? {
        guard let config = ghostty_config_new() else { return nil }
        if usingGhosttySettings {
            for file in userConfigFiles() { file.path.withCString { ghostty_config_load_file(config, $0) } }
        } else if let url = Bundle.main.url(forResource: "terminal", withExtension: "conf") {
            url.path.withCString { ghostty_config_load_file(config, $0) }
        }
        ghostty_config_load_recursive_files(config)
        let required = FileManager.default.temporaryDirectory.appendingPathComponent("orc-ghostty-required-\(getpid()).conf")
        if (try? requiredSettings.write(to: required, atomically: true, encoding: .utf8)) != nil {
            required.path.withCString { ghostty_config_load_file(config, $0) }
            try? FileManager.default.removeItem(at: required)
        }
        ghostty_config_finalize(config)
        return config
    }

    private init() {
        if let resources = Bundle.main.resourceURL?.appendingPathComponent("ghostty"), FileManager.default.fileExists(atPath: resources.path) {
            setenv("GHOSTTY_RESOURCES_DIR", resources.path, 1)
        }
        guard ghostty_init(0, nil) == 0, let config = Self.makeConfig() else { return }
        self.config = config
        readBackgroundOpacity()
        var runtime = ghostty_runtime_config_s()
        runtime.userdata = Unmanaged.passUnretained(self).toOpaque()
        runtime.wakeup_cb = { pointer in
            guard let pointer else { return }
            DispatchQueue.main.async {
                let engine = Unmanaged<GhosttyEngine>.fromOpaque(pointer).takeUnretainedValue()
                if let app = engine.app { ghostty_app_tick(app) }
            }
        }
        runtime.action_cb = { _, target, action in
            if action.tag == GHOSTTY_ACTION_MOUSE_OVER_LINK, target.tag == GHOSTTY_TARGET_SURFACE,
               let surface = target.target.surface, let pointer = ghostty_surface_userdata(surface) {
                let view = Unmanaged<GhosttyView>.fromOpaque(pointer).takeUnretainedValue()
                let link = action.action.mouse_over_link
                view.hoveredLink = link.len > 0 && link.url != nil
                    ? String(data: Data(bytes: link.url!, count: Int(link.len)), encoding: .utf8) : nil
                return true
            }
            if action.tag == GHOSTTY_ACTION_OPEN_URL, target.tag == GHOSTTY_TARGET_SURFACE,
               let surface = target.target.surface, let pointer = ghostty_surface_userdata(surface),
               let bytes = action.action.open_url.url,
               let value = String(data: Data(bytes: bytes, count: Int(action.action.open_url.len)), encoding: .utf8) {
                let view = Unmanaged<GhosttyView>.fromOpaque(pointer).takeUnretainedValue()
                return view.openMarkdownLink(value)
            }
            if action.tag == GHOSTTY_ACTION_RELOAD_CONFIG {
                // A soft reload follows a color scheme change; a full one rereads the configuration files.
                let soft = action.action.reload_config.soft
                DispatchQueue.main.async { if soft { GhosttyEngine.shared.applyConfig() } else { GhosttyEngine.shared.reload() } }
                return true
            }
            // Window-management actions belong to the session manager; the surface handles terminal actions.
            return action.tag == GHOSTTY_ACTION_SET_TITLE || action.tag == GHOSTTY_ACTION_PWD || action.tag == GHOSTTY_ACTION_CELL_SIZE
        }
        runtime.read_clipboard_cb = { pointer, _, state in
            guard let pointer else { return false }
            let view = Unmanaged<GhosttyView>.fromOpaque(pointer).takeUnretainedValue()
            guard let surface = view.surface else { return false }
            let text = NSPasteboard.general.string(forType: .string) ?? ""
            text.withCString { ghostty_surface_complete_clipboard_request(surface, $0, state, false) }
            return true
        }
        runtime.confirm_read_clipboard_cb = { pointer, text, state, _ in
            guard let pointer, let text else { return }
            let view = Unmanaged<GhosttyView>.fromOpaque(pointer).takeUnretainedValue()
            guard let surface = view.surface else { return }
            // Confirm requested terminal pastes through AppKit's normal alert.
            let alert = NSAlert(); alert.messageText = "Paste into this session?"
            alert.informativeText = "The terminal requested clipboard text."
            alert.addButton(withTitle: "Paste"); alert.addButton(withTitle: "Cancel")
            if alert.runModal() == .alertFirstButtonReturn { ghostty_surface_complete_clipboard_request(surface, text, state, true) }
            else { "".withCString { ghostty_surface_complete_clipboard_request(surface, $0, state, true) } }
        }
        runtime.write_clipboard_cb = { _, _, contents, count, _ in
            guard let contents, count > 0, let text = contents[0].data else { return }
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(String(cString: text), forType: .string)
        }
        runtime.close_surface_cb = { pointer, _ in
            guard let pointer else { return }
            let view = Unmanaged<GhosttyView>.fromOpaque(pointer).takeUnretainedValue()
            DispatchQueue.main.async { [weak view] in view?.detach() }
        }
        app = ghostty_app_new(&runtime, config)
        applyColorScheme()
        appearanceObservation = NSApplication.shared.observe(\.effectiveAppearance) { _, _ in
            DispatchQueue.main.async { GhosttyEngine.shared.applyColorScheme() }
        }
    }

    /// Follows the system appearance, for a theme with light and dark variants.
    func applyColorScheme() {
        guard let app else { return }
        let dark = NSApplication.shared.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        ghostty_app_set_color_scheme(app, dark ? GHOSTTY_COLOR_SCHEME_DARK : GHOSTTY_COLOR_SCHEME_LIGHT)
        applyConfig()
    }

    /// Gives the app its configuration resolved for the current appearance. A terminal created from an
    /// unresolved light/dark configuration rebuilds it from the files and loses the command it was
    /// given (Ghostty 1.3.1), so new terminals must start from the resolved one.
    func applyConfig() {
        guard let app, let config else { return }
        ghostty_app_update_config(app, config)
    }

    private func readBackgroundOpacity() {
        guard let config else { return }
        var opacity: Double = 1
        let key = "background-opacity"
        if ghostty_config_get(config, &opacity, key, UInt(key.utf8.count)) { backgroundOpacity = opacity }
    }

    /// Makes `window` translucent, with the configured background blur, while it shows a terminal and
    /// the background opacity is below 1; otherwise opaque. libghostty draws the terminal's translucent
    /// background itself, so the rest of the window must draw its own.
    func applyWindowBackground(_ window: NSWindow, showingTerminal: Bool) {
        let translucent = showingTerminal && backgroundOpacity < 1
        guard window.isOpaque == translucent || (translucent && window.backgroundColor.alphaComponent > 0.01) else { return }
        window.isOpaque = !translucent
        // A fully clear window stops receiving clicks in its clear areas.
        window.backgroundColor = translucent ? NSColor.white.withAlphaComponent(0.001) : .windowBackgroundColor
        if translucent, let app { ghostty_set_window_background_blur(app, Unmanaged.passUnretained(window).toOpaque()) }
    }

    /// Reads the configuration again, from the user's Ghostty files or Orc's defaults.
    func reload(using replacement: ghostty_config_t? = nil) {
        guard let next = replacement ?? Self.makeConfig() else { return }
        let previous = config
        config = next
        readBackgroundOpacity()
        applyConfig()
        applyColorScheme()
        if let previous { ghostty_config_free(previous) }
    }
}

struct GhosttyTerminal: NSViewRepresentable {
    let session: Session
    func makeNSView(context: Context) -> GhosttyView { GhosttyView(session: session) }
    func updateNSView(_ view: GhosttyView, context: Context) { view.setAccessibilityLabel("Terminal — \(session.name)") }
    static func dismantleNSView(_ view: GhosttyView, coordinator: ()) { view.detach() }
}

@MainActor final class GhosttyView: NSView, @preconcurrency NSTextInputClient {
    fileprivate var surface: ghostty_surface_t?
    private let session: Session
    private let commandOverride: String?
    fileprivate var hoveredLink: String?
    private var markdownPress: (event: NSEvent, link: MarkdownFileLink)?
    private var marked = NSAttributedString(string: "")
    private var inputText: String?
    private var handlingKey = false
    private var tracking: NSTrackingArea?
    private var detached = false
    private var visibilityObserver: NSObjectProtocol?
    override var acceptsFirstResponder: Bool { true }
    override var isFlipped: Bool { true }
    init(session: Session, command: String? = nil) {
        self.session = session; commandOverride = command
        super.init(frame: .zero)
        wantsLayer = true
        setAccessibilityElement(true)
        setAccessibilityRole(.textArea)
        setAccessibilityLabel("Terminal — \(session.name)")
        registerForDraggedTypes(TerminalFileDrop.types)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    func openMarkdownLink(_ value: String) -> Bool {
        guard let url = URL(string: value) else { return false }
        return MarkdownWindowController.open(url, relativeTo: URL(fileURLWithPath: session.worktreePath, isDirectory: true))
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let window, surface == nil, !detached, let app = GhosttyEngine.shared.app else { return }
        var config = ghostty_surface_config_new()
        config.platform_tag = GHOSTTY_PLATFORM_MACOS
        config.platform.macos.nsview = Unmanaged.passUnretained(self).toOpaque()
        config.userdata = Unmanaged.passUnretained(self).toOpaque()
        config.scale_factor = window.backingScaleFactor
        config.wait_after_command = true
        let cli = Bundle.main.resourceURL?.appendingPathComponent("orc").path ?? "orc"
        // The native app owns navigation; its terminal stays bound to this session.
        // An embedded Ghostty PTY is not its parent process's Herdr pane.
        let command = commandOverride ?? ("/usr/bin/env -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_BIN_PATH -u HERDR_SOCKET_PATH -u HERDR_AGENT "
            + shellQuote(cli) + " attach " + shellQuote(session.handle) + " --no-session-switch")
        command.withCString { commandPointer in
            config.command = commandPointer
            FileManager.default.homeDirectoryForCurrentUser.path.withCString { directory in
                config.working_directory = directory
                surface = ghostty_surface_new(app, &config)
            }
        }
        updateSize()
        updateAppearance()
        visibilityObserver = NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let surface = self.surface else { return }
                ghostty_surface_set_occlusion(surface, self.window?.occlusionState.contains(.visible) ?? true)
                ghostty_surface_refresh(surface)
            }
        }
        window.makeFirstResponder(self)
    }
    func detach() {
        detached = true; markdownPress = nil; hoveredLink = nil
        if let visibilityObserver { NotificationCenter.default.removeObserver(visibilityObserver); self.visibilityObserver = nil }
        if let surface { self.surface = nil; ghostty_surface_free(surface) }
    }
    override func layout() { super.layout(); updateSize() }
    override func viewDidChangeBackingProperties() { super.viewDidChangeBackingProperties(); updateSize() }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); updateAppearance() }
    private func updateAppearance() {
        guard let surface else { return }
        ghostty_surface_set_color_scheme(surface, effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? GHOSTTY_COLOR_SCHEME_DARK : GHOSTTY_COLOR_SCHEME_LIGHT)
    }
    private func updateSize() {
        guard let surface else { return }
        let scale = window?.backingScaleFactor ?? 1
        ghostty_surface_set_content_scale(surface, scale, scale)
        ghostty_surface_set_size(surface, UInt32(max(1, bounds.width * scale)), UInt32(max(1, bounds.height * scale)))
        ghostty_surface_refresh(surface)
    }
    override func becomeFirstResponder() -> Bool {
        if let surface { ghostty_surface_set_focus(surface, true) }
        if let app = GhosttyEngine.shared.app { ghostty_app_set_focus(app, true) }
        return true
    }
    override func resignFirstResponder() -> Bool { if let surface { ghostty_surface_set_focus(surface, false) }; return true }
    private func mods(_ flags: NSEvent.ModifierFlags) -> ghostty_input_mods_e {
        var value: UInt32 = 0
        if flags.contains(.shift) { value |= GHOSTTY_MODS_SHIFT.rawValue }
        if flags.contains(.control) { value |= GHOSTTY_MODS_CTRL.rawValue }
        if flags.contains(.option) { value |= GHOSTTY_MODS_ALT.rawValue }
        if flags.contains(.command) { value |= GHOSTTY_MODS_SUPER.rawValue }
        if flags.contains(.capsLock) { value |= GHOSTTY_MODS_CAPS.rawValue }
        if flags.rawValue & UInt(NX_DEVICERSHIFTKEYMASK) != 0 { value |= GHOSTTY_MODS_SHIFT_RIGHT.rawValue }
        if flags.rawValue & UInt(NX_DEVICERCTLKEYMASK) != 0 { value |= GHOSTTY_MODS_CTRL_RIGHT.rawValue }
        if flags.rawValue & UInt(NX_DEVICERALTKEYMASK) != 0 { value |= GHOSTTY_MODS_ALT_RIGHT.rawValue }
        if flags.rawValue & UInt(NX_DEVICERCMDKEYMASK) != 0 { value |= GHOSTTY_MODS_SUPER_RIGHT.rawValue }
        return ghostty_input_mods_e(rawValue: value)
    }
    override func keyDown(with event: NSEvent) {
        guard let surface else { return }
        let translated = ghostty_surface_key_translation_mods(surface, mods(event.modifierFlags))
        var translationFlags = event.modifierFlags
        if translated.rawValue & GHOSTTY_MODS_ALT.rawValue == 0 { translationFlags.remove(.option) }
        let translationEvent: NSEvent
        if translationFlags == event.modifierFlags { translationEvent = event }
        else {
            translationEvent = NSEvent.keyEvent(with: event.type, location: event.locationInWindow,
                                                modifierFlags: translationFlags, timestamp: event.timestamp,
                                                windowNumber: event.windowNumber, context: nil,
                                                characters: event.characters(byApplyingModifiers: translationFlags) ?? "",
                                                charactersIgnoringModifiers: event.charactersIgnoringModifiers ?? "",
                                                isARepeat: event.isARepeat, keyCode: event.keyCode) ?? event
        }
        inputText = nil; handlingKey = true
        if !event.modifierFlags.contains(.control) && !event.modifierFlags.contains(.command) { interpretKeyEvents([translationEvent]) }
        handlingKey = false
        var key = ghostty_input_key_s()
        key.action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS
        key.mods = mods(event.modifierFlags)
        key.consumed_mods = mods(translationEvent.modifierFlags.subtracting([.control, .command]))
        key.keycode = UInt32(event.keyCode)
        key.composing = hasMarkedText()
        key.unshifted_codepoint = event.characters(byApplyingModifiers: [])?.unicodeScalars.first?.value ?? 0
        var text = inputText ?? (hasMarkedText() ? "" : translationEvent.characters ?? "")
        if text.unicodeScalars.count == 1, let scalar = text.unicodeScalars.first {
            if scalar.value < 0x20 { text = translationEvent.characters(byApplyingModifiers: translationEvent.modifierFlags.subtracting(.control)) ?? "" }
            else if (0xF700...0xF8FF).contains(scalar.value) { text = "" }
        }
        // Ghostty encodes control and function keys from the physical key and
        // modifiers. Text is only the printable result of layout/IME translation.
        if let first = text.utf8.first, first >= 0x20 {
            text.withCString { key.text = $0; _ = ghostty_surface_key(surface, key) }
        } else { _ = ghostty_surface_key(surface, key) }
    }
    override func keyUp(with event: NSEvent) {
        guard let surface else { return }; var key = ghostty_input_key_s()
        key.action = GHOSTTY_ACTION_RELEASE; key.mods = mods(event.modifierFlags); key.keycode = UInt32(event.keyCode)
        key.unshifted_codepoint = event.characters(byApplyingModifiers: [])?.unicodeScalars.first?.value ?? 0
        _ = ghostty_surface_key(surface, key)
    }
    override func flagsChanged(with event: NSEvent) {
        guard let surface, !hasMarkedText() else { return }
        let bit: UInt32
        let rightMask: UInt?
        switch event.keyCode {
        case 0x39: bit = GHOSTTY_MODS_CAPS.rawValue; rightMask = nil
        case 0x38: bit = GHOSTTY_MODS_SHIFT.rawValue; rightMask = nil
        case 0x3C: bit = GHOSTTY_MODS_SHIFT.rawValue; rightMask = UInt(NX_DEVICERSHIFTKEYMASK)
        case 0x3B: bit = GHOSTTY_MODS_CTRL.rawValue; rightMask = nil
        case 0x3E: bit = GHOSTTY_MODS_CTRL.rawValue; rightMask = UInt(NX_DEVICERCTLKEYMASK)
        case 0x3A: bit = GHOSTTY_MODS_ALT.rawValue; rightMask = nil
        case 0x3D: bit = GHOSTTY_MODS_ALT.rawValue; rightMask = UInt(NX_DEVICERALTKEYMASK)
        case 0x37: bit = GHOSTTY_MODS_SUPER.rawValue; rightMask = nil
        case 0x36: bit = GHOSTTY_MODS_SUPER.rawValue; rightMask = UInt(NX_DEVICERCMDKEYMASK)
        default: return
        }
        var key = ghostty_input_key_s()
        key.keycode = UInt32(event.keyCode)
        key.mods = mods(event.modifierFlags)
        let sidePressed = rightMask.map { event.modifierFlags.rawValue & $0 != 0 } ?? true
        let pressed = key.mods.rawValue & bit != 0 && sidePressed
        key.action = pressed ? GHOSTTY_ACTION_PRESS : GHOSTTY_ACTION_RELEASE
        _ = ghostty_surface_key(surface, key)
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard window?.firstResponder === self else { return super.performKeyEquivalent(with: event) }
        guard let surface, event.modifierFlags.contains(.command) else { return false }
        if event.charactersIgnoringModifiers == "c" { return binding("copy_to_clipboard", surface) }
        if event.charactersIgnoringModifiers == "v" { return binding("paste_from_clipboard", surface) }
        if event.charactersIgnoringModifiers == "a" { return binding("select_all", surface) }
        return false
    }
    private func binding(_ action: String, _ surface: ghostty_surface_t) -> Bool {
        action.withCString { ghostty_surface_binding_action(surface, $0, UInt(action.utf8.count)) }
    }
    @objc func copy(_ sender: Any?) { if let surface { _ = binding("copy_to_clipboard", surface) } }
    @objc func paste(_ sender: Any?) { if let surface { _ = binding("paste_from_clipboard", surface) } }
    override func selectAll(_ sender: Any?) { if let surface { _ = binding("select_all", surface) } }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard surface != nil, !detached, session.writable, TerminalFileDrop.accepts(sender.draggingPasteboard) else { return [] }
        return .copy
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard surface != nil, !detached, session.writable else { return false }
        do {
            let writes = try TerminalFileDrop.writes(TerminalFileDrop.load(sender.draggingPasteboard))
            guard !writes.isEmpty else { return false }
            window?.makeFirstResponder(self)
            for text in writes {
                if let surface { text.withCString { ghostty_surface_text(surface, $0, UInt(text.utf8.count)) } }
            }
            return true
        } catch {
            let alert = NSAlert(); alert.messageText = "Could not drop files"
            alert.informativeText = error.localizedDescription
            if let window { alert.beginSheetModal(for: window) }
            return false
        }
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas(); if let tracking { removeTrackingArea(tracking) }
        tracking = NSTrackingArea(rect: bounds, options: [.activeInKeyWindow, .mouseMoved, .mouseEnteredAndExited, .inVisibleRect], owner: self)
        addTrackingArea(tracking!)
    }
    override func mouseMoved(with event: NSEvent) {
        guard let surface else { return }; let point = convert(event.locationInWindow, from: nil)
        ghostty_surface_mouse_pos(surface, point.x, point.y, mods(event.modifierFlags))
    }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        markdownPress = nil
        if event.clickCount == 1, event.modifierFlags.intersection([.shift, .control, .option]).isEmpty,
           let link = markdownLink(at: event) {
            // Fullscreen applications can open links through their own mouse handler.
            // Hold the press until a click or drag determines who owns the gesture.
            markdownPress = (event, link)
            return
        }
        forwardMouseDown(event)
    }
    override func mouseUp(with event: NSEvent) {
        if let press = markdownPress {
            markdownPress = nil
            if markdownLink(at: event) == press.link {
                MarkdownWindowController.open(press.link)
            }
            return
        }
        mouseMoved(with: event)
        if let surface { _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, mods(event.modifierFlags)) }
    }
    override func mouseDragged(with event: NSEvent) {
        if let press = markdownPress {
            markdownPress = nil
            forwardMouseDown(press.event)
        }
        mouseMoved(with: event)
    }
    private func forwardMouseDown(_ event: NSEvent) {
        mouseMoved(with: event)
        if let surface { _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, mods(event.modifierFlags)) }
    }
    private func markdownLink(at event: NSEvent) -> MarkdownFileLink? {
        guard let surface else { return nil }
        let point = convert(event.locationInWindow, from: nil)
        guard bounds.contains(point) else { return nil }
        // Shift bypasses application mouse capture; Command enables OSC 8 hit testing.
        // Restore the real modifiers before forwarding any terminal input.
        hoveredLink = nil
        // Leaving the viewport invalidates Ghostty's same-cell link cache.
        ghostty_surface_mouse_pos(surface, -1, -1, mods(event.modifierFlags))
        ghostty_surface_mouse_pos(surface, point.x, point.y, mods([.shift, .command]))
        let value = hoveredLink
        ghostty_surface_mouse_pos(surface, point.x, point.y, mods(event.modifierFlags))
        guard let value, let url = URL(string: value) else { return nil }
        return MarkdownFileLink(url, relativeTo: URL(fileURLWithPath: session.worktreePath, isDirectory: true))
    }
    override func scrollWheel(with event: NSEvent) {
        guard let surface else { return }
        ghostty_surface_mouse_scroll(surface, event.scrollingDeltaX, event.scrollingDeltaY, event.hasPreciseScrollingDeltas ? 1 : 0)
    }
    func hasMarkedText() -> Bool { marked.length > 0 }
    func markedRange() -> NSRange { NSRange(location: marked.length > 0 ? 0 : NSNotFound, length: marked.length) }
    func selectedRange() -> NSRange { NSRange(location: NSNotFound, length: 0) }
    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        marked = (string as? NSAttributedString) ?? NSAttributedString(string: string as? String ?? "")
        if let surface { marked.string.withCString { ghostty_surface_preedit(surface, $0, UInt(marked.string.utf8.count)) } }
    }
    func unmarkText() { marked = NSAttributedString(string: ""); if let surface { ghostty_surface_preedit(surface, nil, 0) } }
    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }
    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? { nil }
    func insertText(_ string: Any, replacementRange: NSRange) {
        let text = (string as? NSAttributedString)?.string ?? string as? String ?? ""
        unmarkText()
        if handlingKey { inputText = (inputText ?? "") + text }
        else if let surface { text.withCString { ghostty_surface_text(surface, $0, UInt(text.utf8.count)) } }
    }
    func characterIndex(for point: NSPoint) -> Int { 0 }
    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        guard let surface, let window else { return .zero }
        var x = 0.0, y = 0.0, width = 0.0, height = 0.0
        ghostty_surface_ime_point(surface, &x, &y, &width, &height)
        return window.convertToScreen(convert(NSRect(x: x, y: y, width: width, height: height), to: nil))
    }
    override func doCommand(by selector: Selector) {}
}
