# App Store readiness (iOS)

Backlog #4300 (vedu #4298): will the iOS app pass App Review and is it legal to ship? Checked against the
[App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) and Apple's
[export compliance](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations)
and [privacy manifest](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files) docs,
on main 2c95aa7 (Oct 5, 2026); re-checked against the ios/ sources and src/ on main 93ec7fe7 (Oct 8, 2026).

**Verdict: not ready yet, and what's left is vedu's.** The code blockers from Oct 5 are all on main now: account
deletion in the app and on the web, in-app reporting, muting, blocking and an offensive-words filter, an explicit OK
before anything goes to xAI, and a rewritten privacy policy. What still stands between the app and review is three
decisions for vedu: **4.8 sign-in** (the app still offers Google and GitHub with no privacy-preserving alternative,
which would be rejected as it stands: add Sign in with Apple, or drop Google/GitHub on iOS), **payments 3.1.1 / 3.1.3(b)**
(nothing is sold while Atteo is free for now; before paid plans start, Pro as an IAP or Pro kept out of the app), and
**builds**, which need the paid Apple Developer account. Before submitting, vedu also reviews the two legal drafts
(/privacy and /terms are still marked "Draft — review before publishing"), and privacy@atteo.dev has to be a real inbox.

| Item | Guideline | Status | Evidence / fix | Owner |
|---|---|---|---|---|
| Privacy manifest | Privacy manifest files; 5.1.2 | **Fixed** | `ios/AgentSoup/Resources/PrivacyInfo.xcprivacy`: no tracking, no tracking domains; UserDefaults CA92.1; file timestamps C617.1 (`BoardPicture.swift`); collected data: name, email, user ID, other user content, photos, product interaction (PostHog, not linked), crash data (Sentry, not linked, App Functionality), customer support. Third-party SDKs: PostHog (analytics) and Sentry Cocoa (**does not start** without a DSN or when Share usage analytics is off; [SENTRY.md](SENTRY.md)). | vedu's agent |
| Permission strings | 5.1.1(ii), 5.1.2(i) | **Fixed** | `Info.plist` + `InfoPlist.xcstrings` (8 languages): the mic string now also says that in a voice chat with Grok your voice is sent to xAI (`Talk.swift`, `src/voice.ts` → api.x.ai). Camera, photo-add and speech strings were already honest (speech is on-device: `Voice.swift:109 requiresOnDeviceRecognition`). | vedu's agent |
| Export compliance | Export regulations | **Fixed (confirm)** | `ITSAppUsesNonExemptEncryption = NO`: the app only uses encryption built into iOS (HTTPS; CryptoKit in `BoardCrypto.swift` for end-to-end boards), which Apple calls "typically exempt from export documentation upload". Apple notes exempt apps "might alternatively be required to submit a year-end self-classification report" (BIS, mass-market 5D992); end-to-end messaging is the case where that applies. | vedu: confirm, and file the annual self-classification report |
| Privacy policy in the app | 5.1.1(i) | **Met** | Settings → Privacy Policy / Terms of Service (`LegalRow.swift`, both Settings screens), linking atteo.dev/privacy and /terms. | — |
| Privacy policy content | 5.1.1(i), 5.1.2(i) | **Drafted (review)** | On main (`src/html.ts` LEGAL.privacy, last updated Oct 6): what's collected; the services that process it; retention per data type (messages per the board's 1 day–10 years setting, deleted boards 30 days, read notifications 30 days, usage 90 days, account log 1 year, sessions 30 days, backups 30 days, error reports 90 days); account deletion; not for under-16s; privacy@atteo.dev. Processors are named **by category, not vendor** (vedu #5410/#5412): hosting and the message safety check (Cloudflare), sign-in and email (WorkOS, Resend), voice only after consent (xAI, named on the consent screen instead), error reports (Sentry), product analytics (PostHog), payments (Stripe), Apple push, backups; the vendor list goes out on request. So every processor the server calls is covered by a category except one: **connected integrations** (Slack, Linear, Notion, Microsoft Teams, Discord get a board's posts once its owner connects them) aren't mentioned. Still marked "Draft — review before publishing". | vedu: review the draft (and the integrations gap), make privacy@atteo.dev real |
| Account deletion | 5.1.1(v) | **Fixed** | App: Settings → Delete account in both Settings screens (`DeleteAccount.swift`, `SettingsView.swift:49`, `EverydaySettings.swift:64`): type the handle back, then a code emailed to the account (`POST /api/me/delete-code`), then `DELETE /api/me` and the phone signs out; tests `ios/AtteoTests/DeleteAccountTests.swift`. Web: the same on /me (`src/html.ts`, "Delete account"). Server: `src/accountDelete.ts` (`test/accountDelete.test.ts`): the profile, sessions, tokens, devices, agents, private boards and integration links go; messages on shared boards stay under a random "Deleted user" tombstone; the handle is never reissued. An active Stripe subscription is **not** cancelled automatically (`stripe_followup`, ids kept in `deleted_handles` for ops): a manual follow-up, moot while nothing is sold. | — |
| Sign-in options | 4.8 | **Blocker (decision)** | Unchanged on main: the app offers "Continue with Google, GitHub or SSO" (`SignInView.swift:229`, WorkOS) beside Atteo's own email sign-in. 4.8 requires another login service that limits data to name + email, lets people hide their email, and doesn't track. The exemption is only for apps that *exclusively* use their own sign-in. Two ways out: add Sign in with Apple (WorkOS supports `AppleOAuth`; needs the paid developer account), or show only email + SSO in the app (enterprise SSO is fine; drop Google/GitHub on iOS). | vedu decides; vedu's agent builds |
| User-generated content | 1.2 | **Met** | On main, all four 1.2 tools (`Moderation.swift`; tests `ios/AtteoTests/AppStoreModerationTests.swift`, `test/moderation.test.ts`): **report** a message (long-press → Report → a reason → `POST /api/boards/:id/entries/:seq/report`), **mute** on a board (muted posts fold to one line, `/api/boards/:id/mutes`), **block** (`/api/friends/:name/block`, PeopleView), and a **filter**: Hide offensive words, on by default (Settings → Safety and privacy), masking slurs and strong profanity in others' messages. Boards are private and invite-only. /terms says "no tolerance for objectionable content or abusive users" and commits to acting on reports within 24 hours (each report is also copied to the developers' "Atteo bugs" board with the reason and a link only); /terms is still marked draft. | vedu: review the draft /terms (the 24h commitment) |
| Third-party AI consent | 5.1.2(i) | **Met** | On main. The OK is the person's, on the server (`display.xai_ok`): `POST /api/app/tts` and starting a voice session answer 403 `{needs_consent}` without it (`src/tts.ts`, `src/voice.ts`; `test/xaiConsent.test.ts` checks no xAI fetch happens), so old builds, stale web tabs and direct calls are covered; session end and autosend stay open so a call settles. App: a one-time "Voice uses xAI" sheet saves it (`AIConsent.swift`; consent cases in `AppStoreModerationTests.swift`), a 403 brings the sheet back, Settings → Safety and privacy turns it off everywhere and ends a live call. Web: the same sheet on Talk and a "Use xAI for voice" switch on /me. | — |
| Payments | 3.1.1, 3.1.3(b) | **Decision** | The app sells nothing and doesn't link to a purchase. Atteo is free for now (`freeForNow`, `src/billing.ts`: on unless `FREE_FOR_NOW=0`), so nothing is sold anywhere and everyone has Pro's limits. Once paid plans start: Pro, bought on the web (Stripe), raises limits that also apply in the app (`src/limits.ts`). 3.1.3(b) lets multiplatform apps honour web purchases only "provided those items are also available as in-app purchases within the app". Options: add Pro as an IAP subscription, or keep Pro out of the app's experience. Don't add any "Upgrade" link or price in the app either way (3.1.1). | vedu decides |
| Third-party marks | 5.2.1 | **Met** | ChatGPT, Claude, Grok and Meta (for Muse) logos are used only to identify the tool you connect (`BringAssistant.swift:35`, sources noted). No VS Code logo in the app (the web one is jxn's #4162). | — |
| Background modes | 2.5.4 | **Met** | Only `fetch` + one BGTask (`com.atteo.app.refresh`), used to refresh unread counts. No audio or location background modes. | — |
| Networking | 2.5.1 / ATS | **Met** | ATS on; only `NSAllowsLocalNetworking` (local dev), which review accepts. | — |
| Login not required for non-account features | 5.1.1(v) | **Met** | Atteo is account-based (boards, people, agents), so sign-in is core. | — |
| Build, signing, submission | 2.1, Program License | **Needs vedu** | Needs the paid Apple Developer account (pending). `ios/project.yml` on main: `DEVELOPMENT_TEAM: ""`, bundle id `com.atteo.app` (to register), version 0.1.0 (1), bumped per upload; then a TestFlight build, then review. | vedu |

## What vedu does in App Store Connect

1. **Privacy label** (App Privacy), from what the app actually collects, *not used for tracking*, all *linked to you* except usage and crash data:
   - Contact info: name, email address (app functionality).
   - Identifiers: user ID (app functionality).
   - Usage data: product interaction (analytics), *not linked to you*. PostHog records which features are used (sign
     in, board created, invite sent, first message, agent connected, voice used, screen names) under a random id made
     once per install, never the handle or any account id, and never message text or emails (Analytics.swift, vedu
     #4416), matching the web and /privacy. Settings → Safety and privacy → Share usage analytics turns off both
     analytics and crash reporting, cancels queued uploads and discards cached crash reports.
   - User content: other user content (messages, files), photos or videos (pictures you send), customer support (bug
     reports and feedback).
   - Audio: answer *yes* only if you count Talk's realtime voice as collected. It's streamed to xAI for the
     conversation and not kept by Atteo. Apple counts data sent off the device to a third party, so declaring audio
     data (app functionality) is the safer answer.
   - Diagnostics: **Crash Data**, *not linked to you*, not tracking, purpose App Functionality. Declared in
     `ios/AgentSoup/Resources/PrivacyInfo.xcprivacy`. Collection requires both a configured `SENTRY_DSN` /
     `AtteoSentryDSN` and Share usage analytics enabled; default configs contain no DSN, so Sentry stays off.
     Reports contain only a fixed error kind or native stack addresses, a fixed screen name, app version and OS.
     No message text, emails, handles, request bodies/headers/cookies, IPs, user/device identifiers, breadcrumbs,
     screenshots, replay or performance data. See [SENTRY.md](SENTRY.md), including Sentry's IP-storage setting.
     Match the App Store Connect label to the shipping build's configuration.
   - Not collected: location, contacts, health, browsing or search history, purchases, advertising data.
     PostHog's crash and session-replay features remain off.
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
