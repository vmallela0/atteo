# Sentry (error reporting)

The Worker already reports errors when `SENTRY_DSN` is set (`src/sentry.ts`). The iOS app can send crashes — and a couple of non-PII error kinds — to the **same** Sentry project. The SDK is linked; **it does nothing until a DSN is configured**. No DSN is required to build or ship the app. This repo's production iOS configs do **not** set one.

**Status (Oct 6, vedu #4640 / INFRA.md item 5): off by default.** Worker Sentry is unchanged. The iOS SDK stays off until someone puts a DSN in the build setting or the debug scheme. Do not commit a real DSN.

## Turn it on (iOS)

1. In the Sentry project that already receives Worker errors, open **Settings → Client Keys (DSN)** and copy the DSN (`https://…@….ingest.sentry.io/…`).
2. Pass it only at build time, never in git:

   ```sh
   cd ios && xcodegen
   xcodebuild -scheme Atteo -destination 'platform=iOS Simulator,name=iPhone 17' \
     SENTRY_DSN='https://public@oNNNN.ingest.sentry.io/PROJECT'
   ```

   Or set `SENTRY_DSN` in a local xcconfig / Xcode build setting (the empty default is in `ios/project.yml`). That value is copied into Info.plist as `AtteoSentryDSN`.

3. Debug / simulator: also set `ATTEO_SENTRY=1` in the scheme, **or** set `ATTEO_SENTRY_DSN` to the same DSN. Debug builds, unit tests and UI tests never start Sentry otherwise, so a leftover plist value cannot phone home from a test run.

Until a valid `https://…@…` DSN is present, `CrashReporting.start()` returns without calling `SentrySDK.start`. The binary still contains the SDK; it does not send.

The Worker DSN (`npx wrangler secret put SENTRY_DSN`) does **not** reach the phone. iOS needs its own copy of the DSN in the app build.

## What is recorded (when on)

| Event | What Sentry gets |
| --- | --- |
| Native crash / hang | Stack, app version, device class. No handle, no email. |
| `json_decode` | The kind and `surface=ios`. Not the payload (it can be a board). |
| `http_5xx` | The kind, `surface=ios`, and `status` (e.g. `500`). Not the path, body, or server message. |

`beforeSend` scrubs whatever else the SDK built: no `user`, no cookies, no query string, no `Authorization` / `Cookie` / token headers, no extras named `message` / `text` / `email` / `handle` / `body`. Emails, bearer tokens and JWT-shaped strings in leftover text become `[redacted]`. Breadcrumbs longer than 80 characters are dropped.

Never sent: message text, emails, tokens, board contents, Authorization headers, session replay, screenshots, view hierarchy, failed-request bodies, performance traces.

## App Store privacy

Default configs collect **no** crash data (no DSN → SDK never starts). The privacy manifest does not declare Crash Data yet.

When you add a DSN to a build you will ship:

1. App Store Connect → App Privacy: add **Diagnostics → Crash Data**, not linked to identity, not used for tracking, purpose App Functionality.
2. Add `NSPrivacyCollectedDataTypeCrashData` (linked `false`, tracking `false`, purpose App Functionality) to `ios/AgentSoup/Resources/PrivacyInfo.xcprivacy`.
3. Keep the /privacy line honest (it already names Sentry; say the phone sends crash stacks only when the app is built with a DSN).

See [APP_STORE_READINESS.md](APP_STORE_READINESS.md).

## Worker (unchanged)

```sh
npx wrangler secret put SENTRY_DSN
```

Absent, Worker Sentry stays off (`src/index.ts`, `docs/SELF_HOST.md`). Alert rules (new issue / spike → email or the bugs board) are still the rest of INFRA.md item 5.
