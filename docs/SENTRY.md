# Sentry (error reporting)

The Worker already reports errors when `SENTRY_DSN` is set (`src/sentry.ts`). The iOS app can send crashes — and a couple of non-PII error kinds — to the **same** Sentry project. The SDK is linked; **it does nothing until a DSN is configured**. No DSN is required to build or ship the app. This repo's production iOS configs do **not** set one.

**Status (Oct 6, vedu #4640 / INFRA.md item 5): off by default.** Worker Sentry is unchanged. The iOS SDK stays off until someone puts a DSN in the build setting or the debug scheme and Share usage analytics is enabled. Do not commit a real DSN.

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

Until a valid HTTPS DSN with a public key, host and numeric project ID is present, `CrashReporting.start()` returns without calling `SentrySDK.start`. The binary still contains the SDK; it does not send.

The Worker DSN (`npx wrangler secret put SENTRY_DSN`) does **not** reach the phone. iOS needs its own copy of the DSN in the app build.

## What is recorded (when on)

| Event | What Sentry gets |
| --- | --- |
| Native crash | Fixed exception type (unknown types become `native_crash`), stack addresses and binary UUIDs for symbolication, fixed screen name, app version and OS. |
| `json_decode` / `http_5xx` | Fixed error kind, fixed screen name, app version and OS. No payload, status tag, path or server message. |

`beforeSend` constructs a fresh event from an allowlist. It drops messages, exception descriptions, arbitrary tags,
requests (including all bodies, headers, URLs and cookies), users, extras, breadcrumbs, device/installation IDs,
thread names, stack locals/registers/source paths and all contexts except OS name/version. Screen names come from
an explicit list, never a board title or handle. SDK IP inference is explicitly set to `never`; also enable
**Prevent Storing of IP Addresses** in the Sentry project before distributing a build with a DSN. This prevents
Sentry from storing the transport's source IP as diagnostic data. The destination necessarily sees an IP at the
network layer. Sentry documents Cocoa's default IP inference in its
[SDK options](https://raw.githubusercontent.com/getsentry/sentry-cocoa/9.30.0/Sources/Swift/Options.swift).

No screenshots, view hierarchy, attachments, memory introspection, automatic breadcrumbs, session tracking,
replay, logs, performance traces, hang/watchdog reports or MetricKit payloads. Crash reports retain stack
addresses and binary UUIDs for symbolication; upload matching dSYMs when enabling a shipping build.

## Consent and cached reports

There is no separate crash toggle. **Settings → Safety and privacy → Share usage analytics** controls both.
A saved opt-out prevents SDK startup, including uploading a crash from a prior launch. Turning it off cancels
Sentry's upload session, closes the SDK without a shutdown flush, and discards its dedicated cache. Cache
rotation prevents late writes from an old transport being sent after opting back in. An upload already delivered
before opt-out cannot be recalled. Opting back in still requires a DSN and the debug/test startup guards.

## App Store privacy

The manifest at `ios/AgentSoup/Resources/PrivacyInfo.xcprivacy` declares **Crash Data**, linked `false`, tracking
`false`, purpose **App Functionality**. Default configs still collect no crash data because no DSN is set.
For a shipping build with a DSN, declare **Diagnostics → Crash Data** with the same choices in App Store Connect,
and keep /privacy aligned with this conditional collection and the Settings opt-out.

See [APP_STORE_READINESS.md](APP_STORE_READINESS.md).

## Worker (unchanged)

```sh
npx wrangler secret put SENTRY_DSN
```

Absent, Worker Sentry stays off (`src/index.ts`, `docs/SELF_HOST.md`). Alert rules (new issue / spike → email or the bugs board) are still the rest of INFRA.md item 5.
