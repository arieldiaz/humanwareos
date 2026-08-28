import AppKit
import AVFoundation
import UniformTypeIdentifiers

/// The ⌥Space capture surface: a centered, Spotlight-style floating panel with
/// one text field and two direct actions: a microphone records audio and a plus
/// imports media. The microphone becomes the stop control while recording.
///
/// ⏎ posts to the ingest service (leading `!` = task, handled server-side) and
/// closes; Esc closes. Audio and imported media enter the external stream inbox
/// and are picked up by the existing local ingest pipeline.
final class CaptureField: NSPanel, NSTextFieldDelegate, NSWindowDelegate {
    private let field = NSTextField()
    private let recordButton = NSButton()
    private let importButton = NSButton()
    private var recorder: AVAudioRecorder?
    private var statusReset: DispatchWorkItem?

    private static let panelSize = NSSize(width: 620, height: 68)
    private static let defaultPlaceholder = "Capture anything…"

    init() {
        super.init(
            contentRect: NSRect(origin: .zero, size: Self.panelSize),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: true
        )
        isFloatingPanel = true
        level = .floating
        hidesOnDeactivate = false
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        animationBehavior = .none
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        delegate = self

        field.placeholderString = Self.defaultPlaceholder
        field.isBezeled = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = .systemFont(ofSize: 20)
        field.delegate = self
        field.target = self
        field.action = #selector(submit)
        field.translatesAutoresizingMaskIntoConstraints = false

        recordButton.image = NSImage(systemSymbolName: "mic", accessibilityDescription: "Record audio")
        recordButton.bezelStyle = .circular
        recordButton.controlSize = .large
        recordButton.target = self
        recordButton.action = #selector(toggleRecording)
        recordButton.toolTip = "Record audio"
        recordButton.setAccessibilityLabel("Record audio")
        recordButton.translatesAutoresizingMaskIntoConstraints = false

        importButton.image = NSImage(systemSymbolName: "plus", accessibilityDescription: "Import file")
        importButton.bezelStyle = .circular
        importButton.controlSize = .large
        importButton.target = self
        importButton.action = #selector(importFile)
        importButton.toolTip = "Import file"
        importButton.setAccessibilityLabel("Import file")
        importButton.translatesAutoresizingMaskIntoConstraints = false

        let content = NSVisualEffectView(frame: NSRect(origin: .zero, size: Self.panelSize))
        content.material = .hudWindow
        content.blendingMode = .behindWindow
        content.state = .active
        content.wantsLayer = true
        content.layer?.cornerRadius = 17
        content.layer?.masksToBounds = true
        content.addSubview(field)
        content.addSubview(recordButton)
        content.addSubview(importButton)
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            field.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            field.trailingAnchor.constraint(equalTo: recordButton.leadingAnchor, constant: -14),
            recordButton.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            recordButton.widthAnchor.constraint(equalToConstant: 36),
            recordButton.heightAnchor.constraint(equalToConstant: 36),
            importButton.leadingAnchor.constraint(equalTo: recordButton.trailingAnchor, constant: 8),
            importButton.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -18),
            importButton.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            importButton.widthAnchor.constraint(equalToConstant: 36),
            importButton.heightAnchor.constraint(equalToConstant: 36),
        ])
        contentView = content
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    func present(relativeTo anchor: NSStatusBarButton?) {
        positionOnActiveScreen(anchor)
        statusReset?.cancel()
        field.placeholderString = Self.defaultPlaceholder
        NSApp.activate(ignoringOtherApps: true)
        makeKeyAndOrderFront(nil)
        makeFirstResponder(field)
    }

    @objc private func submit() {
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        field.stringValue = ""
        orderOut(nil)
        guard !text.isEmpty else { return }
        IngestClient.shared.send(text: text) { result in
            if case .failure(let error) = result {
                NSLog("HumanwareOS capture failed: \(error.localizedDescription)")
            }
        }
    }

    @objc private func toggleRecording() {
        if recorder?.isRecording == true {
            finishRecording()
        } else {
            beginRecording()
        }
    }

    private func beginRecording() {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            startRecording()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted { self?.startRecording() }
                    else { self?.showStatus("Microphone access is off") }
                }
            }
        default:
            showStatus("Microphone access is off")
        }
    }

    private func startRecording() {
        do {
            let destination = try captureDestination(extension: "m4a", prefix: "humanwareos-audio")
            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 96_000,
            ]
            let recorder = try AVAudioRecorder(url: destination, settings: settings)
            guard recorder.prepareToRecord(), recorder.record() else {
                showStatus("Couldn’t start recording")
                return
            }
            self.recorder = recorder
            if !isVisible {
                positionOnActiveScreen(nil)
                NSApp.activate(ignoringOtherApps: true)
                makeKeyAndOrderFront(nil)
            }
            field.stringValue = ""
            field.placeholderString = "Recording…"
            field.isEnabled = false
            importButton.isEnabled = false
            recordButton.image = NSImage(systemSymbolName: "stop.fill", accessibilityDescription: "Stop recording")
            recordButton.contentTintColor = .systemRed
            recordButton.toolTip = "Stop recording"
            recordButton.setAccessibilityLabel("Stop recording")
        } catch {
            showStatus("Couldn’t start recording")
            NSLog("HumanwareOS audio capture failed: \(error.localizedDescription)")
        }
    }

    private func finishRecording() {
        recorder?.stop()
        recorder = nil
        restoreRecordButton()
        field.isEnabled = true
        importButton.isEnabled = true
        showStatus("Audio captured")
        makeFirstResponder(field)
    }

    @objc private func importFile() {
        let picker = NSOpenPanel()
        picker.title = "Import to HumanwareOS"
        picker.prompt = "Import"
        picker.allowsMultipleSelection = false
        picker.canChooseDirectories = false
        picker.allowedContentTypes = [.audio, .image, .movie]
        picker.begin { [weak self] response in
            guard response == .OK, let source = picker.url else { return }
            do {
                let destination = try self?.captureDestination(
                    extension: source.pathExtension,
                    prefix: "humanwareos-import"
                )
                guard let destination else { return }
                try FileManager.default.copyItem(at: source, to: destination)
                self?.showStatus("Imported \(source.lastPathComponent)")
            } catch {
                self?.showStatus("Couldn’t import that file")
                NSLog("HumanwareOS file import failed: \(error.localizedDescription)")
            }
        }
    }

    private func captureDestination(extension fileExtension: String, prefix: String) throws -> URL {
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("humanware-data/working/inbox/recordings", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss-SSS"
        let suffix = fileExtension.isEmpty ? "" : ".\(fileExtension.lowercased())"
        return directory.appendingPathComponent("\(prefix)-\(formatter.string(from: Date()))\(suffix)")
    }

    private func restoreRecordButton() {
        recordButton.image = NSImage(systemSymbolName: "mic", accessibilityDescription: "Record audio")
        recordButton.contentTintColor = nil
        recordButton.toolTip = "Record audio"
        recordButton.setAccessibilityLabel("Record audio")
    }

    private func showStatus(_ text: String) {
        statusReset?.cancel()
        if !isVisible {
            positionOnActiveScreen(nil)
            NSApp.activate(ignoringOtherApps: true)
            makeKeyAndOrderFront(nil)
        }
        field.placeholderString = text
        let reset = DispatchWorkItem { [weak self] in
            self?.field.placeholderString = Self.defaultPlaceholder
        }
        statusReset = reset
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: reset)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            if recorder?.isRecording == true { finishRecording() }
            field.stringValue = ""
            orderOut(nil)
            return true
        }
        return false
    }

    func windowDidResignKey(_ notification: Notification) {
        if recorder?.isRecording != true { orderOut(nil) }
    }

    private func positionOnActiveScreen(_ anchor: NSStatusBarButton?) {
        let size = frame.size
        guard let screen = anchor?.window?.screen ?? NSScreen.main else {
            center()
            return
        }
        let visible = screen.visibleFrame
        let x = visible.midX - size.width / 2
        let y = visible.midY - size.height / 2
        setFrameOrigin(NSPoint(x: x, y: y))
    }
}
