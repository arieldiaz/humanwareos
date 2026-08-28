import AppKit
import Carbon.HIToolbox

/// A global hotkey via Carbon's RegisterEventHotKey. Carbon hotkeys are
/// system-wide and, unlike CGEventTap, need no Accessibility permission.
final class HotKey {
    private var ref: EventHotKeyRef?
    private let id: UInt32
    private let callback: () -> Void

    private static var nextID: UInt32 = 1
    private static var instances: [UInt32: HotKey] = [:]
    private static var handlerInstalled = false

    init(keyCode: UInt32, modifiers: UInt32, callback: @escaping () -> Void) {
        self.callback = callback
        self.id = HotKey.nextID
        HotKey.nextID += 1
        HotKey.instances[id] = self

        HotKey.installHandlerIfNeeded()

        // Signature 'HwOS'
        let hotKeyID = EventHotKeyID(signature: OSType(0x48774F53), id: id)
        let status = RegisterEventHotKey(
            keyCode,
            modifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &ref
        )
        if status == noErr {
            NSLog("HumanwareOS: registered global hotkey (keyCode \(keyCode), modifiers \(modifiers))")
        } else {
            NSLog("HumanwareOS: hotkey registration FAILED with OSStatus \(status)")
        }
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
        HotKey.instances[id] = nil
    }

    private static func installHandlerIfNeeded() {
        guard !handlerInstalled else { return }
        handlerInstalled = true
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        InstallEventHandler(
            GetApplicationEventTarget(),
            { _, event, _ -> OSStatus in
                var hkID = EventHotKeyID()
                GetEventParameter(
                    event,
                    EventParamName(kEventParamDirectObject),
                    EventParamType(typeEventHotKeyID),
                    nil,
                    MemoryLayout<EventHotKeyID>.size,
                    nil,
                    &hkID
                )
                DispatchQueue.main.async {
                    HotKey.instances[hkID.id]?.callback()
                }
                return noErr
            },
            1,
            &eventType,
            nil,
            nil
        )
    }
}
