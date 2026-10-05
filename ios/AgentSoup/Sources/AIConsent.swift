// Explicit OK before anything goes to xAI (App Review 5.1.2(i): "obtain explicit permission" before sharing personal
// data with third-party AI; docs/APP_STORE_READINESS.md). Talk to Atteo streams your voice and the board's messages to
// xAI's Grok voice API, and read-aloud's server voice sends a message's text to xAI's text-to-speech (src/voice.ts,
// src/tts.ts). Until the person agrees on this phone, neither route is called: Talk shows the consent sheet instead of
// connecting, and read-aloud uses the phone's own voice. Settings → Voice turns it back off. Per device (a phone's
// microphone is per device), stored in UserDefaults. The fake voice of local UI tests (ATTEO_FAKE_VOICE=1) never
// reaches xAI, so it needs no OK.

import SwiftUI

enum AIConsent {
    static let key = "ai-consent-xai"

    /// Whether the person has OK'd sending voice and messages to xAI on this phone.
    static var xai: Bool {
        get { UserDefaults.standard.bool(forKey: key) || TalkAPI.fake }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    /// The routes that send voice or message text to xAI: the voice session and its tools, and server text-to-speech.
    /// Status checks (…/status) send nothing and stay allowed.
    static func sendsToXAI(_ path: String) -> Bool {
        let p = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        if p.hasSuffix("/status") { return false }
        return p.hasPrefix("/api/app/voice/") || p == "/api/app/tts"
    }

    /// Refuses a call that would reach xAI without the person's OK (thrown before any request is made).
    static func check(_ path: String) throws {
        if sendsToXAI(path), !xai { throw Missing() }
    }

    struct Missing: LocalizedError {
        var errorDescription: String? { String(localized: "Voice chat needs your OK first.", bundle: .l10n) }
    }
}

/// The one-time sheet: what goes to xAI, why, and how to turn it off. Agree records the OK; Not now changes nothing.
struct AIConsentView: View {
    var onAgree: () -> Void
    var onDecline: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            Image(systemName: "waveform.circle").font(.system(size: 40, weight: .regular)).foregroundStyle(Theme.muted)
                .accessibilityHidden(true)
            Text("Voice uses xAI").font(Typo.headline(24)).foregroundStyle(Theme.text)
            VStack(alignment: .leading, spacing: Space.m) {
                Text("Voice chat and read-aloud are powered by xAI's Grok voice service. When you use them, your voice and the messages being read or discussed are sent to xAI so it can listen and answer.")
                Text("xAI processes them to run the conversation. Atteo doesn't keep your voice recordings.")
                Text("You can turn this off any time in Settings → Safety and privacy.")
            }
            .font(Typo.body).foregroundStyle(Theme.muted)
            Link("Privacy Policy", destination: URL(string: "https://atteo.dev/privacy")!)
                .font(Typo.meta).foregroundStyle(Theme.text)
            Spacer(minLength: 0)
            Button { Haptics.play(.touch); onAgree() } label: {
                Text("Agree and continue").fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 48)
                    .foregroundStyle(Theme.onPrimary).background(Theme.primary, in: Capsule())
            }
            .buttonStyle(PressStyle())
            .accessibilityIdentifier("ai-consent-agree")
            Button { onDecline() } label: { Text("Not now").frame(maxWidth: .infinity, minHeight: 44).foregroundStyle(Theme.text) }
                .buttonStyle(.plain)
                .accessibilityIdentifier("ai-consent-decline")
        }
        .padding(Space.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.bg.ignoresSafeArea())
    }
}
