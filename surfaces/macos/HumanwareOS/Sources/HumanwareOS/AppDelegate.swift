import AppKit
import Carbon.HIToolbox
import Sparkle

/// Thin app delegate: stands up the status-item menu controller and the ⌥Space
/// global hotkey. All UI is stock AppKit inside `StatusMenuController`.
///
/// `⌥Space` behavior depends on whether the in-menu capture field can take
/// keystrokes during menu tracking. AppKit does not deliver key events to a menu
/// item's custom view while the menu is open, so by default `⌥Space` routes to a
/// minimal borderless stock field (`CaptureField`) and left/right-click shows the
/// real menu — the build brief's sanctioned fallback. Set `useInMenuCapture` if a
/// focus diagnostic proves the in-menu field works on this OS.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: StatusMenuController!
    private var captureField: CaptureField!
    private var hotKey: HotKey?
    private var updaterController: SPUStandardUpdaterController!

    /// If true, ⌥Space opens the menu and focuses the in-menu field. If false
    /// (default — AppKit doesn't route key events to menu item views), ⌥Space
    /// shows the borderless stock capture field instead.
    var useInMenuCapture = false

    /// Set by `--diagnose-menu-focus`: run the in-menu field focus test and exit.
    var diagnoseMenuFocus = false

    /// Set by `--show-menu`: open the menu and hold it for a headless screenshot.
    var showMenuOnLaunch = false

    /// Set by `--show-capture`: open the floating input for a visual check.
    var showCaptureOnLaunch = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let isVisualDiagnostic = diagnoseMenuFocus || showMenuOnLaunch || showCaptureOnLaunch
        updaterController = SPUStandardUpdaterController(
            startingUpdater: !isVisualDiagnostic,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
        controller = StatusMenuController()
        controller.onCheckForUpdates = { [weak self] in
            self?.updaterController.checkForUpdates(nil)
        }

        if diagnoseMenuFocus {
            controller.focusDiagnostics(outPath: "/tmp/humanwareos-menu-focus.txt")
            return
        }

        captureField = CaptureField()
        controller.includeCaptureFieldInMenu = useInMenuCapture
        controller.onCaptureRequested = { [weak self] in
            guard let self else { return }
            self.captureField.present(relativeTo: self.controller.statusButton)
        }

        hotKey = HotKey(keyCode: UInt32(kVK_Space), modifiers: UInt32(optionKey)) { [weak self] in
            self?.triggerCapture()
        }

        if showMenuOnLaunch {
            // Called from the launch callback (not a GCD work item) so the
            // window-id capture scheduled inside can drain during menu tracking.
            controller.showMenuForScreenshot(outPath: "/tmp/humanwareos-menu-window.txt")
        } else if showCaptureOnLaunch {
            captureField.present(relativeTo: controller.statusButton)
            NSLog("HumanwareOS: capture window id \(captureField.windowNumber)")
        }
    }

    private func triggerCapture() {
        if useInMenuCapture {
            controller.openMenu()
            controller.focusCaptureField()
        } else {
            captureField.present(relativeTo: controller.statusButton)
        }
    }
}
