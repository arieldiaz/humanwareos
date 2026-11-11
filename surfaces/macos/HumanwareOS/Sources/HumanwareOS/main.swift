import AppKit
import ServiceManagement

// HumanwareOS menu bar app — Milestone 1 shell.
// A menu bar accessory: butterfly template icon, ⌥Space global hotkey opens a
// focused capture field, ⏎ posts the capture to the ingest service (which owns
// the Slack token and posts to #inbox). The app never speaks to Slack directly.

// Self-test mode: `HumanwareOS --selftest "some text"` drives the real
// IngestClient once and exits with the send result. It exercises the same
// posting path a ⏎ in the capture field takes — used for headless end-to-end
// verification where a synthetic keypress isn't available.
if let index = CommandLine.arguments.firstIndex(of: "--register-service") {
    guard CommandLine.arguments.count > index + 1 else {
        FileHandle.standardError.write("register-service: missing plist name\n".data(using: .utf8)!)
        exit(2)
    }
    let plistName = CommandLine.arguments[index + 1]
    let service = SMAppService.agent(plistName: plistName)
    do {
        try service.register()
        print("registered \(plistName): \(service.status.rawValue)")
        exit(0)
    } catch {
        FileHandle.standardError.write("register-service: \(error.localizedDescription)\n".data(using: .utf8)!)
        exit(1)
    }
}

if let index = CommandLine.arguments.firstIndex(of: "--unregister-service") {
    guard CommandLine.arguments.count > index + 1 else {
        FileHandle.standardError.write("unregister-service: missing plist name\n".data(using: .utf8)!)
        exit(2)
    }
    let plistName = CommandLine.arguments[index + 1]
    let service = SMAppService.agent(plistName: plistName)
    do {
        try service.unregister()
        print("unregistered \(plistName)")
        exit(0)
    } catch {
        FileHandle.standardError.write("unregister-service: \(error.localizedDescription)\n".data(using: .utf8)!)
        exit(1)
    }
}

if let index = CommandLine.arguments.firstIndex(of: "--selftest") {
    let text = CommandLine.arguments.count > index + 1 ? CommandLine.arguments[index + 1] : "HumanwareOS selftest capture"
    let semaphore = DispatchSemaphore(value: 0)
    var exitCode: Int32 = 0
    IngestClient.shared.send(text: text) { result in
        switch result {
        case .success:
            FileHandle.standardError.write("selftest: capture posted\n".data(using: .utf8)!)
        case .failure(let error):
            FileHandle.standardError.write("selftest: FAILED — \(error.localizedDescription)\n".data(using: .utf8)!)
            exitCode = 1
        }
        semaphore.signal()
    }
    semaphore.wait()
    exit(exitCode)
}

// Self-test the network layer under ATS enforcement. Unlike a bare CLI run, an
// app launched through LaunchServices (`open HumanwareOS.app --args
// --selftest-net`) DOES enforce App Transport Security using the bundle's
// Info.plist — so this is the honest test of the NSAllowsArbitraryLoads
// exception. It POSTs one `/capture`, then writes
// the outcome to a file (open() detaches stdout) and exits. Optional trailing
// argument overrides the capture text.
if let index = CommandLine.arguments.firstIndex(of: "--selftest-net") {
    let text = CommandLine.arguments.count > index + 1
        ? CommandLine.arguments[index + 1]
        : "HumanwareOS ATS selftest — /capture via GUI-launched app"
    let outPath = "/tmp/humanwareos-selftest-net.txt"
    var lines: [String] = []
    let group = DispatchGroup()

    group.enter()
    IngestClient.shared.send(text: text) { result in
        switch result {
        case .success: lines.append("capture: OK — posted")
        case .failure(let error): lines.append("capture: FAIL — \(error.localizedDescription)")
        }
        group.leave()
    }

    let semaphore = DispatchSemaphore(value: 0)
    group.notify(queue: .global()) { semaphore.signal() }
    _ = semaphore.wait(timeout: .now() + 30)
    let report = lines.isEmpty ? "selftest-net: no results (timeout)" : lines.joined(separator: "\n")
    try? report.write(toFile: outPath, atomically: true, encoding: .utf8)
    FileHandle.standardError.write((report + "\n").data(using: .utf8)!)
    exit(report.contains("FAIL") ? 1 : 0)
}

let app = NSApplication.shared
let delegate = AppDelegate()

// --appearance light|dark forces a per-app appearance (no global defaults change)
// so both light and dark menus can be screenshotted on one GUI session.
if let index = CommandLine.arguments.firstIndex(of: "--appearance"),
   CommandLine.arguments.count > index + 1 {
    switch CommandLine.arguments[index + 1] {
    case "light": app.appearance = NSAppearance(named: .aqua)
    case "dark": app.appearance = NSAppearance(named: .darkAqua)
    default: break
    }
}

// --diagnose-menu-focus opens the menu and reports whether the in-menu capture
// field can take keyboard focus during menu tracking (see AppDelegate), then
// exits. This decides in-menu capture vs. the borderless-field fallback.
delegate.diagnoseMenuFocus = CommandLine.arguments.contains("--diagnose-menu-focus")

// --in-menu-capture forces the in-menu field capture path (only correct if the
// focus diagnostic shows the field can type on this OS).
if CommandLine.arguments.contains("--in-menu-capture") {
    delegate.useInMenuCapture = true
}

// --show-menu opens the real menu and keeps it up for a headless screenshot,
// writing the menu window id to /tmp so `screencapture -l<id>` can target it.
delegate.showMenuOnLaunch = CommandLine.arguments.contains("--show-menu")

// --show-capture opens the centered floating input for visual verification.
delegate.showCaptureOnLaunch = CommandLine.arguments.contains("--show-capture")

app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
