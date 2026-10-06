// Explicit OK before anything goes to xAI (App Review 5.1.2(i): "obtain explicit permission" before sharing personal
// data with third-party AI; docs/APP_STORE_READINESS.md). Talk to Atteo streams your voice and the board's messages to
// xAI's Grok voice API, and read-aloud's server voice sends a message's text to xAI's text-to-speech (src/voice.ts,
// src/tts.ts). The OK is the person's, kept on the server (display.xai_ok, jxn's agent #4386): the server refuses those
// routes without it (403 needs_consent), whatever the client, and every device follows it. This phone keeps a copy
// (UserDefaults) so it can ask before calling at all: until the OK, Talk shows the consent sheet instead of connecting and
// read-aloud uses the phone's own voice. Settings → Safety and privacy turns it off everywhere and ends a live call. The
// fake voice of local UI tests (ATTEO_FAKE_VOICE=1) never reaches xAI, so it needs no OK.

import SwiftUI

enum AIConsent {
    static let key = "ai-consent-xai"

    /// Whether the person has OK'd sending voice and messages to xAI (this phone's copy of display.xai_ok).
    static var xai: Bool {
        get { UserDefaults.standard.bool(forKey: key) || TalkAPI.fake }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    /// Saves the OK (or its withdrawal) for the person on the server, then here. False when the server didn't take it.
    @discardableResult
    static func save(_ on: Bool) async -> Bool {
        let ok = (try? await API.shared.send("/api/app/prefs", body: ["display": ["xai_ok": on]], retries: false)) != nil
        if ok || !on { xai = on } // withdrawing always takes effect on this phone, even offline
        return ok
    }

    /// The server's word (GET /api/app/voice/status and /tts/status carry `consent`), so a change on another device lands here.
    static func sync(_ consent: Any?) { if let c = consent as? Bool { xai = c } }

    /// The routes that reach xAI: starting a voice session (a client secret for xAI's socket) and server text-to-speech.
    /// Ending a session, the autosend check and status are our server's only, so a call open at revoke still settles.
    static func sendsToXAI(_ path: String) -> Bool {
        let p = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        return p == "/api/app/voice/session" || p == "/api/app/voice/briefing" || p == "/api/app/tts" // the briefing goes on to xAI in session.update
    }

    /// The server's refusal for want of the OK (403 {needs_consent: true}).
    static func isRefusal(_ code: Int, _ j: [String: Any]) -> Bool { code == 403 && j["needs_consent"] as? Bool == true }

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
    var problem: String? = nil

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
            if let problem { Text(problem).font(Typo.meta).foregroundStyle(Theme.warn).accessibilityIdentifier("ai-consent-error") }
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
