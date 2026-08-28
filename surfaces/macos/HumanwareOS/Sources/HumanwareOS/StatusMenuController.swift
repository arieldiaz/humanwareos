import AppKit

/// Owns the menu-bar status item and its real `NSMenu`. Everything the app shows
/// is a stock AppKit primitive — standard `NSMenuItem`s, `NSMenuItem.separator()`
/// dividers, SF Symbol images, section headers, the standard disabled state — so
/// the OS restyles the whole surface with each macOS release and we never hand-
/// match another app's pixels. The one sanctioned custom view is the capture
/// field at the top (a text field cannot be a plain menu item).
///
/// Capture path: `⏎` in the field posts to the ingest service (leading `!` = task,
/// handled server-side) and closes the menu. `⌥Space` opens the menu; whether the
/// in-menu field can take keystrokes during menu tracking is decided empirically
/// (see `focusDiagnostics`) — if it cannot, `AppDelegate` routes `⌥Space` to the
/// minimal borderless field instead, per the build brief's sanctioned fallback.
final class StatusMenuController: NSObject, NSMenuDelegate, NSTextFieldDelegate {
    /// Native menus size themselves from their longest title and offer no maximum width. Keep every dynamic label bounded so an operational error or thread title cannot stretch the menu across the screen.
    private static let menuTitleLimit = 42
    private let statusItem: NSStatusItem
    private let captureField: NSTextField
    private let captureItemView: NSView

    /// Latest usage snapshot, refreshed in the background so the menu can render
    /// real numbers the instant it opens (and updated live if a refresh lands
    /// while the menu is showing). Never fabricated — absence renders as a reason.
    private var usageSnapshot: UsageSnapshot?
    private var usageError: String?
    private var threadSnapshot: ThreadSnapshot?
    private var threadError: String?

    /// When true, the capture field is embedded as the top custom-view menu item
    /// and ⌥Space focuses it. Default false: AppKit does not reliably route key
    /// events to a menu item's view during tracking, so capture uses the
    /// borderless field instead and the menu shows a discoverable "Capture note…"
    /// item. Flip on only if a keystroke test confirms in-menu typing works.
    var includeCaptureFieldInMenu = false

    /// Invoked when the standard "Capture note…" menu item is chosen (borderless
    /// field mode). Set by `AppDelegate` to present the capture field.
    var onCaptureRequested: (() -> Void)?
    var onCheckForUpdates: (() -> Void)?

    override init() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        // Capture field: a plain stock text field, no custom colors/fonts. The
        // rounded bezel is the standard AppKit search/entry look; the OS owns it.
        let field = NSTextField()
        field.placeholderString = "Capture anything…"
        field.bezelStyle = .roundedBezel
        field.isBezeled = true
        field.focusRingType = .default
        field.translatesAutoresizingMaskIntoConstraints = false
        captureField = field

        // Menu-width host for the field with the standard menu-item side inset.
        let host = NSView(frame: NSRect(x: 0, y: 0, width: 240, height: 30))
        host.addSubview(field)
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: host.leadingAnchor, constant: 14),
            field.trailingAnchor.constraint(equalTo: host.trailingAnchor, constant: -14),
            field.centerYAnchor.constraint(equalTo: host.centerYAnchor),
            host.heightAnchor.constraint(equalToConstant: 30),
            host.widthAnchor.constraint(greaterThanOrEqualToConstant: 240),
        ])
        captureItemView = host

        super.init()

        field.delegate = self
        field.target = self
        field.action = #selector(captureSubmitted)

        if let button = statusItem.button {
            button.image = ButterflyIcon.image(pointSize: 19)
            button.toolTip = "HumanwareOS — capture (⌥Space)"
        }
        statusItem.menu = buildMenu()

        refreshUsage()
        refreshThreads()
    }

    var statusButton: NSStatusBarButton? { statusItem.button }

    // MARK: Menu construction

    /// Builds the whole menu from stock primitives. Rebuilt on each open via
    /// `menuNeedsUpdate` so usage lines reflect the newest snapshot.
    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        populate(menu)
        return menu
    }

    private func populate(_ menu: NSMenu) {
        menu.removeAllItems()

        if includeCaptureFieldInMenu {
            // The one sanctioned custom-view item.
            let captureItem = NSMenuItem()
            captureItem.view = captureItemView
            menu.addItem(captureItem)
        } else {
            // Discoverable standard capture command → opens the borderless field.
            // The ⌥Space shortcut is shown the stock way (right-aligned key
            // equivalent); the global hotkey is what actually fires it.
            let capture = NSMenuItem(title: "Capture note…", action: #selector(captureRequested), keyEquivalent: " ")
            capture.keyEquivalentModifierMask = .option
            capture.image = NSImage(systemSymbolName: "square.and.pencil", accessibilityDescription: "Capture")
            capture.target = self
            menu.addItem(capture)
        }

        // Do not expose roadmap capture modes as disabled commands. Disabled
        // controls mean "temporarily unavailable"; these features do not exist
        // yet, so showing them here makes the current product look broken.

        menu.addItem(.separator())
        addSectionHeader(menu, threadHeader)
        populateThreads(menu)
        let allThreads = NSMenuItem(title: "Open all threads…", action: #selector(openThreads), keyEquivalent: "")
        allThreads.target = self
        menu.addItem(allThreads)

        // Usage — real numbers from the ingest /usage feed, rendered as plain
        // text menu items (text is the stock primitive; no custom bars/colors).
        menu.addItem(.separator())
        addSectionHeader(menu, usageHeader)
        populateUsage(menu)

        // Footer.
        menu.addItem(.separator())
        let settings = NSMenuItem(title: "Settings…", action: nil, keyEquivalent: ",")
        settings.isEnabled = false // no settings window yet — standard disabled state
        menu.addItem(settings)
        let open = NSMenuItem(title: "Open HumanwareOS ↗", action: #selector(openDashboard), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        let updates = NSMenuItem(title: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "")
        updates.target = self
        menu.addItem(updates)
        let quit = NSMenuItem(title: "Quit HumanwareOS", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    private func populateUsage(_ menu: NSMenu) {
        if let snapshot = usageSnapshot, snapshot.ok {
            addUsageProvider(menu, "Claude", windows: snapshot.claude)
            addUsageProvider(menu, "Codex", windows: snapshot.codex)
            if snapshot.claude.isEmpty && snapshot.codex.isEmpty {
                addInfo(menu, "No usage windows")
            }
        } else if let error = usageError {
            NSLog("HumanwareOS usage unavailable: \(error)")
            addInfo(menu, "Usage unavailable")
        } else {
            addInfo(menu, "Loading…")
        }
    }

    private func populateThreads(_ menu: NSMenu) {
        if let snapshot = threadSnapshot, snapshot.ok {
            if snapshot.groups.isEmpty {
                addInfo(menu, "No active threads")
                return
            }
            for group in snapshot.groups {
                let label = group.label
                let statusItem = NSMenuItem(
                    title: "\(label): \(group.threads.count)",
                    action: nil,
                    keyEquivalent: ""
                )
                statusItem.image = statusImage(group.status, label: label)
                let submenu = NSMenu(title: label)
                for channel in group.channels {
                    addSectionHeader(submenu, "#\(channel.channel)")
                    for thread in channel.threads {
                        let item = NSMenuItem(
                            title: truncated(thread.title, limit: 52),
                            action: #selector(openThread(_:)),
                            keyEquivalent: ""
                        )
                        item.target = self
                        item.representedObject = thread.appURL
                        submenu.addItem(item)
                    }
                }
                statusItem.submenu = submenu
                menu.addItem(statusItem)
            }
        } else if let error = threadError {
            NSLog("HumanwareOS thread data unavailable: \(error)")
            addInfo(menu, "Thread data unavailable")
        } else {
            addInfo(menu, "Loading…")
        }
    }

    private func truncated(_ text: String, limit: Int) -> String {
        guard text.count > limit else { return text }
        return String(text.prefix(max(1, limit - 1))).trimmingCharacters(in: .whitespaces) + "…"
    }

    private func statusImage(_ status: String, label: String) -> NSImage? {
        let symbol: String
        switch status {
        case "working": symbol = "arrow.triangle.2.circlepath"
        case "answer": symbol = "questionmark.circle"
        case "act": symbol = "hand.raised"
        case "scheduled": symbol = "calendar"
        default: symbol = "exclamationmark.triangle"
        }
        return NSImage(systemSymbolName: symbol, accessibilityDescription: label)
    }

    private func addUsageProvider(_ menu: NSMenu, _ name: String, windows: [UsageWindow]) {
        guard !windows.isEmpty else { return }
        for win in windows {
            // Each window is a custom-view row: label + "NN% · resets …" + a thin
            // stock ProgressView bar. `NSMenuItem.view` is the sanctioned primitive
            // for a control inside a standard menu; the styling stays system-derived.
            menu.addItem(UsageRow.menuItem(provider: name, window: win, resetText: resetText(win.resetsAt)))
        }
    }

    // MARK: Stock item helpers

    /// A section header — the real macOS 14+ primitive when available, otherwise a
    /// standard disabled item (the pre-14 stock way to show a header).
    private func addSectionHeader(_ menu: NSMenu, _ title: String) {
        if #available(macOS 14.0, *) {
            menu.addItem(NSMenuItem.sectionHeader(title: title))
        } else {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }
    }

    /// A disabled informational row — the standard way to show read-only text.
    private func addInfo(_ menu: NSMenu, _ text: String) {
        let item = NSMenuItem(
            title: truncated(text, limit: Self.menuTitleLimit),
            action: nil,
            keyEquivalent: ""
        )
        item.isEnabled = false
        menu.addItem(item)
    }

    private func resetText(_ date: Date?) -> String? {
        guard let date else { return nil }
        let formatter = DateFormatter()
        if Calendar.current.isDate(date, inSameDayAs: Date()) {
            formatter.dateFormat = "h:mm a"
        } else {
            formatter.dateFormat = "EEE h a"
        }
        return "resets \(formatter.string(from: date))"
    }

    private var usageHeader: String {
        guard let sampledAt = usageSnapshot?.sampledAt else { return "Usage" }
        let minutes = max(0, Int(Date().timeIntervalSince(sampledAt) / 60))
        return minutes < 1 ? "Usage · updated now" : "Usage · updated \(minutes)m ago"
    }

    private var threadHeader: String {
        guard let snapshot = threadSnapshot, snapshot.ok else { return "Active Threads" }
        return "Active Threads: \(snapshot.activeCount)"
    }

    // MARK: NSMenuDelegate

    func menuNeedsUpdate(_ menu: NSMenu) {
        populate(menu)
    }

    func menuWillOpen(_ menu: NSMenu) {
        refreshUsage()
        refreshThreads()
        // Best-effort focus of the in-menu field. Whether keystrokes actually
        // reach it during menu tracking is validated by `focusDiagnostics`.
        DispatchQueue.main.async { [weak self] in
            self?.focusCaptureField()
        }
    }

    // MARK: Capture

    /// Programmatically opens the menu (used by the ⌥Space hotkey when the in-menu
    /// field path is active).
    func openMenu() {
        statusItem.button?.performClick(nil)
    }

    func focusCaptureField() {
        captureField.window?.makeFirstResponder(captureField)
    }

    @objc private func captureRequested() {
        onCaptureRequested?()
    }

    @objc private func captureSubmitted() {
        let text = captureField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        captureField.stringValue = ""
        statusItem.menu?.cancelTracking()
        guard !text.isEmpty else { return }
        IngestClient.shared.send(text: text) { result in
            if case .failure(let error) = result {
                NSLog("HumanwareOS capture failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: Usage refresh

    private func refreshUsage() {
        UsageClient.shared.fetch { [weak self] snapshot in
            DispatchQueue.main.async {
                guard let self else { return }
                if snapshot.ok {
                    self.usageSnapshot = snapshot
                    self.usageError = nil
                } else {
                    self.usageSnapshot = nil
                    self.usageError = snapshot.error ?? "no usage data"
                }
                // The menu is rebuilt from this cache on every open
                // (`menuNeedsUpdate`), so the next open shows the fresh numbers.
            }
        }
    }

    private func refreshThreads() {
        ThreadClient.shared.fetch { [weak self] snapshot in
            DispatchQueue.main.async {
                guard let self else { return }
                if snapshot.ok {
                    self.threadSnapshot = snapshot
                    self.threadError = nil
                } else {
                    self.threadError = snapshot.error ?? "no thread data"
                }
            }
        }
    }

    // MARK: Footer actions

    @objc private func openThreads() { open(UserDefaults.standard.string(forKey: "sessionsURL") ?? "http://127.0.0.1/sessions/") }
    @objc private func openThread(_ sender: NSMenuItem) {
        guard let url = sender.representedObject as? URL else { return }
        let workspace = NSWorkspace.shared
        if workspace.urlForApplication(toOpen: url) != nil {
            workspace.open(url)
        } else {
            openThreads()
        }
    }
    @objc private func openDashboard() { open(UserDefaults.standard.string(forKey: "dashboardURL") ?? "http://127.0.0.1") }
    @objc private func checkForUpdates() { onCheckForUpdates?() }
    @objc private func quit() { NSApp.terminate(nil) }

    private func open(_ string: String) {
        if let url = URL(string: string) { NSWorkspace.shared.open(url) }
    }

    // MARK: Focus diagnostic (headless)

    /// Pops the menu programmatically, tries to make the capture field first
    /// responder, and reports whether a field editor actually attaches during
    /// menu tracking. Written to a file and returned. This is the honest test of
    /// "can you type into the in-menu field" that a headless worker can run
    /// without synthetic keystrokes.
    func focusDiagnostics(outPath: String) {
        guard let button = statusItem.button else { return }
        var lines: [String] = []
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self else { return }
            let window = self.captureField.window
            lines.append("field.window attached: \(window != nil)")
            let becameFR = window?.makeFirstResponder(self.captureField) ?? false
            lines.append("makeFirstResponder returned: \(becameFR)")
            lines.append("window.firstResponder is the field: \(window?.firstResponder === self.captureField)")
            // currentEditor() is non-nil only when the field editor is attached,
            // i.e. the field can actually receive typed text.
            lines.append("field.currentEditor() attached (can type): \(self.captureField.currentEditor() != nil)")
            let report = lines.joined(separator: "\n")
            try? report.write(toFile: outPath, atomically: true, encoding: .utf8)
            FileHandle.standardError.write((report + "\n").data(using: .utf8)!)
            self.statusItem.menu?.cancelTracking()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { exit(0) }
        }
        button.performClick(nil)
    }

    /// Opens the menu and keeps it open (does not cancel tracking), writing the
    /// menu window's CGWindowID to `outPath` so an external `screencapture
    /// -l<id>` can grab exactly the menu for the visual review loop. Runs the
    /// window-id capture inside menu tracking via a main-queue block (GCD drains
    /// during tracking), then blocks in `performClick`.
    func showMenuForScreenshot(outPath: String) {
        guard let button = statusItem.button else { return }
        // Warm the usage cache so the screenshot shows real numbers, not
        // "Loading…". Spin the run loop so the async fetch completion can land.
        let deadline = Date().addingTimeInterval(3)
        while (usageSnapshot == nil && usageError == nil ||
               threadSnapshot == nil && threadError == nil) && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, let id = self.menuWindowID() else { return }
            try? String(id).write(toFile: outPath, atomically: true, encoding: .utf8)
            NSLog("HumanwareOS: menu window id \(id)")
        }
        button.performClick(nil)
    }

    /// The on-screen window owned by this process most likely to be the open
    /// menu: highest window layer, largest area (excludes the tiny status-bar
    /// button window).
    private func menuWindowID() -> CGWindowID? {
        let pid = ProcessInfo.processInfo.processIdentifier
        guard let infos = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
        ) as? [[String: Any]] else { return nil }
        var best: (id: CGWindowID, score: Double)?
        for info in infos {
            // CGWindowList numbers bridge to NSNumber (Int); cast through NSNumber
            // so pid_t/CGWindowID (Int32/UInt32) comparisons don't silently fail.
            guard let owner = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  owner == pid,
                  let number = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
                  let bounds = info[kCGWindowBounds as String] as? [String: Any],
                  let w = (bounds["Width"] as? NSNumber)?.doubleValue,
                  let h = (bounds["Height"] as? NSNumber)?.doubleValue,
                  w > 150 else { continue }
            let layer = (info[kCGWindowLayer as String] as? NSNumber)?.doubleValue ?? 0
            let score = layer * 1_000_000 + w * h
            if best == nil || score > best!.score { best = (number, score) }
        }
        return best?.id
    }
}
