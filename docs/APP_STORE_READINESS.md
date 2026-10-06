# App Store readiness (iOS)

Backlog #4300 (vedu #4298): will the iOS app pass App Review and is it legal to ship? Checked against the
[App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) and Apple's
[export compliance](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations)
and [privacy manifest](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files) docs,
on main 2c95aa7 (Oct 5, 2026).

**Verdict: not ready yet.** Five items would get the app rejected as it stands (three are fixed on branch app-store-blockers: AI consent, in-app reporting, the privacy policy draft): no account deletion,
Google/GitHub sign-in with no privacy-preserving alternative, no in-app reporting of messages, voice going to a
third-party AI without an explicit OK, and a privacy policy that doesn't name every processor. The rest is met or
fixed on this branch.

| Item | Guideline | Status | Evidence / fix | Owner |
|---|---|---|---|---|
| Privacy manifest | Privacy manifest files; 5.1.2 | **Fixed** | `ios/AgentSoup/Resources/PrivacyInfo.xcprivacy` (new): no tracking, no tracking domains; UserDefaults CA92.1 (17 files use `UserDefaults`/`@AppStorage`); file timestamps C617.1 (`BoardPicture.swift:109–112`, own cache); collected data: name, email, user ID, other user content, photos, customer support (bug/feedback), all linked, not tracking, app functionality. No third-party SDKs in the app. | vedu's agent |
| Permission strings | 5.1.1(ii), 5.1.2(i) | **Fixed** | `Info.plist` + `InfoPlist.xcstrings` (8 languages): the mic string now also says that in a voice chat with Grok your voice is sent to xAI (`Talk.swift`, `src/voice.ts` → api.x.ai). Camera, photo-add and speech strings were already honest (speech is on-device: `Voice.swift:109 requiresOnDeviceRecognition`). | vedu's agent |
| Export compliance | Export regulations | **Fixed (confirm)** | `ITSAppUsesNonExemptEncryption = NO`: the app only uses encryption built into iOS (HTTPS; CryptoKit in `BoardCrypto.swift` for end-to-end boards), which Apple calls "typically exempt from export documentation upload". Apple notes exempt apps "might alternatively be required to submit a year-end self-classification report" (BIS, mass-market 5D992); end-to-end messaging is the case where that applies. | vedu: confirm, and file the annual self-classification report |
| Privacy policy in the app | 5.1.1(i) | **Fixed** | Settings → Privacy Policy / Terms of Service (`LegalRow.swift`, both Settings screens), linking atteo.dev/privacy and /terms (both 200). | vedu's agent |
| Privacy policy content | 5.1.1(i), 5.1.2(i) | **Drafted (review)** | Branch app-store-blockers rewrites /privacy (`src/html.ts` LEGAL.privacy): what's collected; every processor and what it gets (Cloudflare incl. Workers AI screening, WorkOS, Resend, xAI only after consent, Sentry, Stripe, Apple push); retention per data type from the code (board retention 1 day–10 years or forever, deleted boards 30 days, read notifications 30 days, usage 90 days, account log 1 year, sessions 30 days, backups 30 days); account deletion; not for under-16s; privacy@atteo.dev. Marked "Draft — review before publishing" in the source. e2e step pins the processors. | vedu: review, make privacy@atteo.dev real, confirm Resend |
| Account deletion | 5.1.1(v) | **Blocker** | No deletion anywhere: no API in `src/` (only `/api/me/avatar` and `/api/me/devices` have DELETE) and nothing in the app. Needed: `DELETE /api/me` that removes the user row, memberships, tokens and devices; anonymises or deletes their entries and files per the policy; ends WorkOS sessions; cancels Stripe. Plus Settings → Delete account (with confirmation) in the app and on the web. | vedu's agent (code) after vedu decides what happens to their messages on shared boards |
| Sign-in options | 4.8 | **Blocker (decision)** | The app offers "Continue with Google, GitHub or SSO" (`SignInView.swift:229`, WorkOS) beside Atteo's own email sign-in. 4.8 requires another login service that limits data to name + email, lets people hide their email, and doesn't track. The exemption is only for apps that *exclusively* use their own sign-in. Two ways out: add Sign in with Apple (WorkOS supports `AppleOAuth`; needs the paid developer account), or show only email + SSO in the app (enterprise SSO is fine; drop Google/GitHub on iOS). | vedu decides; vedu's agent builds |
| User-generated content | 1.2 | **Met (in branch)** | The app now has all four 1.2 tools: **report** a message (long-press → Report → a reason → `POST /api/boards/:id/entries/:seq/report`, `Moderation.swift`), **mute** on a board (profile → ⋯ → Mute on this board; muted posts fold to "Muted: name · Show", `/api/boards/:id/mutes`), **block** (`/api/friends/:name/block`, already there), and a **filter**: Hide offensive words, on by default (Settings → Safety and privacy), masks slurs and strong profanity in others' messages. Boards are private and invite-only; 1.2 asks for "a method for filtering objectionable material from being posted" — the filter plus reports acted on within 24h (now in /terms, and backed: each report is copied to the developers' "Atteo bugs" board with the reason and a link only) and the server's existing screen. Terms add "no tolerance for objectionable content or abusive users". | vedu: the 24h commitment in /terms |
| Third-party AI consent | 5.1.2(i) | **Met (in branch)** | The OK is the person's, on the server (`display.xai_ok`, jxn's agent #4386): `POST /api/app/tts` and starting a voice session answer 403 `{needs_consent}` without it (`src/tts.ts`, `src/voice.ts`; `test/xaiConsent.test.ts` checks no xAI fetch happens), so old app builds, stale web tabs and direct calls are covered; session end and autosend stay open so a call settles. App: a one-time "Voice uses xAI" sheet saves it (`AIConsent.swift`), a 403 brings the sheet back, Settings → Safety and privacy turns it off everywhere and ends a live call, and the voice Play sample waits for it. Web: the same sheet on Talk, a "Use xAI for voice" switch on /me, and Play gated. | — |
| Payments | 3.1.1, 3.1.3(b) | **Decision** | The app sells nothing and doesn't link to a purchase. But Pro, bought on the web (Stripe, $10/mo), raises daily limits that also apply in the app (`src/limits.ts:204–346`). 3.1.3(b) lets multiplatform apps honour web purchases only "provided those items are also available as in-app purchases within the app". Options: add Pro as an IAP subscription, or keep Pro out of the app's experience. Don't add any "Upgrade" link or price in the app either way (3.1.1). | vedu decides |
| Third-party marks | 5.2.1 | **Met** | ChatGPT, Claude, Grok and Meta (for Muse) logos are used only to identify the tool you connect (`BringAssistant.swift:35`, sources noted). No VS Code logo in the app (the web one is jxn's #4162). | — |
| Background modes | 2.5.4 | **Met** | Only `fetch` + one BGTask (`com.atteo.app.refresh`), used to refresh unread counts. No audio or location background modes. | — |
| Networking | 2.5.1 / ATS | **Met** | ATS on; only `NSAllowsLocalNetworking` (local dev), which review accepts. | — |
| Login not required for non-account features | 5.1.1(v) | **Met** | Atteo is account-based (boards, people, agents), so sign-in is core. | — |
| Build, signing, submission | 2.1, Program License | **Needs vedu** | Needs the paid Apple Developer account (pending), bundle id `com.atteo.app` registered, `DEVELOPMENT_TEAM` set, version 0.1.0 (1) bumped per upload, TestFlight build, then review. | vedu |

## What vedu does in App Store Connect

1. **Privacy label** (App Privacy), from what the app actually collects, *not used for tracking*, all *linked to you* except usage data:
   - Contact info: name, email address (app functionality).
   - Identifiers: user ID (app functionality).
   - Usage data: product interaction (analytics), *not linked to you*. PostHog records which features are used (sign
     in, board created, invite sent, first message, agent connected, voice used, screen names) under a random id made
     once per install, never the handle or any account id, and never message text or emails (Analytics.swift, vedu
     #4416), matching the web and /privacy. Settings → Safety and privacy → Share usage analytics turns it off.
   - User content: other user content (messages, files), photos or videos (pictures you send), customer support (bug
     reports and feedback).
   - Audio: answer *yes* only if you count Talk's realtime voice as collected. It's streamed to xAI for the
     conversation and not kept by Atteo. Apple counts data sent off the device to a third party, so declaring audio
     data (app functionality) is the safer answer.
   - Not collected: location, contacts, health, browsing or search history, purchases, diagnostics, advertising data.
     PostHog's crash and session-replay features are off.
2. **Age rating**: user-generated content and unrestricted messaging between people (yes); no mature content
   produced by the app itself. Expect 16+ under the current questionnaire. Confirm when filling it in.
3. **Export compliance**: answer "uses only exempt encryption" (matches the Info.plist key). File the annual
   self-classification report with BIS for end-to-end messaging if your counsel agrees.
4. **Review notes**: a demo account the reviewer can sign in with without a real inbox. Today sign-in is an emailed
   code, so either a review account whose code is fixed and shown in the notes, or SSO credentials for a test org.
   Explain that agents are AI assistants people connect themselves (ChatGPT, Claude, Grok, Muse, coding agents) and
   that Atteo itself doesn't generate content, except Talk (xAI) and the moderation screen.
5. **URLs**: privacy policy https://atteo.dev/privacy, support URL https://atteo.dev/support (contact
   privacy@atteo.dev, the address the privacy policy already publishes), marketing https://atteo.dev.
