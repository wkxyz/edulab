import AppKit
import Foundation
import Darwin

// Local-only credential handoff. No networking, clipboard access or credential logging.
final class KeyInput: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    let field = NSSecureTextField()
    let message = NSTextField(wrappingLabelWithString: "")
    let save = NSButton(title: "保存并继续", target: nil, action: nil)
    let destination: String
    let provider: String

    init(destination: String, provider: String) { self.destination = destination; self.provider = provider }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 510, height: 260),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "题解 · 安全输入 \(provider) 密钥"
        window.isReleasedWhenClosed = false
        window.delegate = self
        let content = window.contentView!
        let title = NSTextField(labelWithString: "输入 \(provider) API Key")
        title.font = .boldSystemFont(ofSize: 21)
        title.frame = NSRect(x: 28, y: 193, width: 450, height: 29)
        let note = NSTextField(wrappingLabelWithString: "仅保存到服务器 43.173.94.201 的私有配置，用于单题验收。\n密钥不进入聊天；传输完成后删除本机临时副本。")
        note.font = .systemFont(ofSize: 13)
        note.textColor = .secondaryLabelColor
        note.frame = NSRect(x: 28, y: 137, width: 450, height: 43)
        field.placeholderString = provider == "MiniMax" ? "在这里粘贴 MiniMax 按量计费 API Key" : "在这里粘贴 KIE API Key"
        field.setAccessibilityLabel("\(provider) API Key")
        field.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
        field.frame = NSRect(x: 28, y: 91, width: 450, height: 30)
        message.font = .systemFont(ofSize: 12)
        message.textColor = .secondaryLabelColor
        message.frame = NSRect(x: 28, y: 57, width: 450, height: 26)
        save.target = self
        save.action = #selector(storeKey)
        save.bezelStyle = .rounded
        save.keyEquivalent = "\r"
        save.frame = NSRect(x: 350, y: 17, width: 130, height: 32)
        let cancel = NSButton(title: "取消", target: self, action: #selector(closeInput))
        cancel.bezelStyle = .rounded
        cancel.frame = NSRect(x: 253, y: 17, width: 90, height: 32)
        [title, note, field, message, save, cancel].forEach { content.addSubview($0) }
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(field)
    }

    @objc func storeKey() {
        let key = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard key.range(of: "^[A-Za-z0-9._-]{24,4096}$", options: .regularExpression) != nil else {
            message.textColor = .systemRed
            message.stringValue = "密钥格式不正确，请复制完整的 API Key。"
            return
        }
        let fd = Darwin.open(destination, O_WRONLY | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
        guard fd >= 0 else {
            message.textColor = .systemRed
            message.stringValue = "无法安全保存，请返回聊天说明情况。"
            return
        }
        let data = Data(key.utf8)
        let written = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, data.count) }
        let closed = Darwin.close(fd)
        guard written == data.count && closed == 0 else {
            Darwin.unlink(destination)
            message.stringValue = "保存未完成，请重新尝试。"
            return
        }
        field.stringValue = ""
        field.isEnabled = false
        save.isEnabled = false
        message.textColor = .systemGreen
        message.stringValue = "已安全保存。请回到聊天回复「已保存」。"
    }

    @objc func closeInput() { NSApplication.shared.terminate(nil) }
    func windowWillClose(_ notification: Notification) { NSApplication.shared.terminate(nil) }
}

let destination = CommandLine.arguments.dropFirst().first ?? (Bundle.main.object(forInfoDictionaryKey: "EdulabSecretPath") as? String)
guard let destination = destination else { exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let provider = CommandLine.arguments.dropFirst(2).first ?? (Bundle.main.object(forInfoDictionaryKey: "EdulabProvider") as? String) ?? "KIE"
guard ["KIE", "MiniMax"].contains(provider) else { exit(2) }
let delegate = KeyInput(destination: destination, provider: provider)
app.delegate = delegate
app.run()
