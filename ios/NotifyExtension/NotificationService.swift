// Atteo's notification extension (E2E-EVERYWHERE.md §4): a push for an end-to-end encrypted board carries the
// message's ciphertext and says only "New message on <board>" (src/pushPayload.ts). iOS runs this before showing it;
// with the board's key from the Keychain group it shares with the app (Shared/SealedOpen.swift), the notification
// shows the real words. Without the key, or anything else amiss, the generic text shows as it came.

import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        handler = contentHandler
        let c = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        content = c
        if let shown = PushContent.decrypted(request.content.userInfo, key: { SealedKeys.read(board: $0, epoch: $1) }) {
            c.title = shown.title
            c.body = shown.body
        }
        contentHandler(c)
    }

    // Out of time: the push as it came (generic, never ciphertext).
    override func serviceExtensionTimeWillExpire() {
        if let handler, let content { handler(content) }
    }
}
