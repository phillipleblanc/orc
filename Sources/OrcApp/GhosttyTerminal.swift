import AppKit
import SwiftUI
import CGhostty
import OrcKit

@MainActor final class GhosttyEngine {
    static let shared = GhosttyEngine()
    private(set) var app: ghostty_app_t?
    private var config: ghostty_config_t?
    private init() {
        if let resources = Bundle.main.resourceURL?.appendingPathComponent("ghostty"), FileManager.default.fileExists(atPath: resources.path) {
            setenv("GHOSTTY_RESOURCES_DIR", resources.path, 1)
        }
        guard ghostty_init(0, nil) == 0, let config = ghostty_config_new() else { return }
        self.config = config
        if let url = Bundle.main.url(forResource: "terminal", withExtension: "conf") { url.path.withCString { ghostty_config_load_file(config, $0) } }
        ghostty_config_load_recursive_files(config)
        ghostty_config_finalize(config)
        var runtime = ghostty_runtime_config_s()
        runtime.userdata = Unmanaged.passUnretained(self).toOpaque()
        runtime.wakeup_cb = { pointer in
            guard let pointer else { return }
            DispatchQueue.main.async {
                let engine = Unmanaged<GhosttyEngine>.fromOpaque(pointer).takeUnretainedValue()
                if let app = engine.app { ghostty_app_tick(app) }
            }
        }
        runtime.action_cb = { _, _, action in
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
        if let app { ghostty_app_set_color_scheme(app, NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? GHOSTTY_COLOR_SCHEME_DARK : GHOSTTY_COLOR_SCHEME_LIGHT) }
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
    private var marked = NSAttributedString(string: "")
    private var inputText: String?
    private var handlingKey = false
    private var tracking: NSTrackingArea?
    private var detached = false
    private var visibilityObserver: NSObjectProtocol?
    override var acceptsFirstResponder: Bool { true }
    override var isFlipped: Bool { true }
    init(session: Session) {
        self.session = session
        super.init(frame: .zero)
        wantsLayer = true
        setAccessibilityElement(true)
        setAccessibilityRole(.textArea)
        setAccessibilityLabel("Terminal — \(session.name)")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let window, surface == nil, !detached, let app = GhosttyEngine.shared.app else { return }
        var config = ghostty_surface_config_new()
        config.platform_tag = GHOSTTY_PLATFORM_MACOS
        config.platform.macos.nsview = Unmanaged.passUnretained(self).toOpaque()
        config.userdata = Unmanaged.passUnretained(self).toOpaque()
        config.scale_factor = window.backingScaleFactor
        config.font_size = 13
        config.wait_after_command = true
        let cli = Bundle.main.resourceURL?.appendingPathComponent("orc").path ?? "orc"
        // The native app owns navigation; its terminal stays bound to this session.
        let command = shellQuote(cli) + " attach " + shellQuote(session.handle) + " --no-session-switch"
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
        detached = true
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
        return ghostty_input_mods_e(rawValue: value)
    }
    override func keyDown(with event: NSEvent) {
        guard let surface else { return }
        inputText = nil; handlingKey = true
        if !event.modifierFlags.contains(.control) && !event.modifierFlags.contains(.command) { interpretKeyEvents([event]) }
        handlingKey = false
        var key = ghostty_input_key_s()
        key.action = event.isARepeat ? GHOSTTY_ACTION_REPEAT : GHOSTTY_ACTION_PRESS
        key.mods = mods(event.modifierFlags)
        key.consumed_mods = mods(event.modifierFlags.subtracting([.control, .command]))
        key.keycode = UInt32(event.keyCode)
        key.composing = hasMarkedText()
        key.unshifted_codepoint = event.characters(byApplyingModifiers: [])?.unicodeScalars.first?.value ?? 0
        var text = inputText ?? (hasMarkedText() ? "" : event.characters ?? "")
        if text.unicodeScalars.count == 1, let scalar = text.unicodeScalars.first {
            if scalar.value < 0x20 { text = event.characters(byApplyingModifiers: event.modifierFlags.subtracting(.control)) ?? "" }
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
        window?.makeFirstResponder(self); mouseMoved(with: event)
        if let surface { _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_PRESS, GHOSTTY_MOUSE_LEFT, mods(event.modifierFlags)) }
    }
    override func mouseUp(with event: NSEvent) { if let surface { _ = ghostty_surface_mouse_button(surface, GHOSTTY_MOUSE_RELEASE, GHOSTTY_MOUSE_LEFT, mods(event.modifierFlags)) } }
    override func mouseDragged(with event: NSEvent) { mouseMoved(with: event) }
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
