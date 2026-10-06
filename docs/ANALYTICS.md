# Product analytics

Product analytics uses [PostHog](https://posthog.com) Cloud. The same event plan covers the web and the iOS app (board #4418). **Both clients do nothing until a project API key is set.** No key is required to ship either scaffold.

The project API key (`phc_…`) is public: it can only record events. Do not put a personal API key here.

## Web

The web loader is a separate change (the Worker scaffold). When that is in place, set `POSTHOG_KEY` (`npx wrangler secret put POSTHOG_KEY`, or a var in `wrangler.jsonc`) and `POSTHOG_HOST` of `eu` (the default) or `us`. A blank key, a key that is not a `phc_…` project key, or any other host leaves the loader off: no script, no `connect-src` change, no cookie. Events go to `https://eu.i.posthog.com/capture/` or `https://us.i.posthog.com/capture/`. Locally, the same names go in `.dev.vars`.

The browser sends nothing when Do Not Track is `1` or `yes`, or when Global Privacy Control is on. The distinct id is a random id in `localStorage` (`atteo.phid`).

## iOS

The iOS app posts the same capture call from `ios/AgentSoup/Sources/Analytics.swift`. It is a no-op until a `phc_…` key is present. There is no PostHog SDK dependency.

The key is read from the first layer that has a non-empty value. An invalid key or host turns analytics **off** (it does not fall through to the next layer). An empty value, or the unsubstituted build placeholder `$(POSTHOG_KEY)`, counts as unset.

1. **Build time / Info.plist.** `POSTHOG_KEY` and `POSTHOG_HOST` are build settings (`ios/project.yml`) written into `ios/AgentSoup/Info.plist`. Both default to empty.

   ```sh
   cd ios && xcodegen
   xcodebuild -scheme Atteo -destination 'platform=iOS Simulator,name=iPhone 16' \
     POSTHOG_KEY=phc_… POSTHOG_HOST=eu
   ```

   `POSTHOG_HOST` is `eu` (default when empty) or `us`.

2. **Process environment**, when the plist value is empty (a simulator scheme, or a debug run):

   ```
   ATTEO_POSTHOG_KEY=phc_…
   ATTEO_POSTHOG_HOST=eu
   ```

   `AGENT_SOUP_POSTHOG_KEY` is accepted too, same as the app's other `ATTEO_` / `AGENT_SOUP_` environment names.

3. **Remote config.** `Analytics.applyRemote(key:host:)` overrides the plist for this launch when a config payload includes a project key. Nothing in the app calls it yet; there is no remote-config source. An empty key clears that override. It is not stored on disk.

Settings → **Opt out of analytics** (Everyday and Developer mode) stops every event and deletes the phone's analytics id. Turning it back on mints a new id on the next event. The switch is `UserDefaults` key `analytics-opt-out`.

### Verify

On a Mac, with Xcode:

```sh
cd ios && xcodegen
xcodebuild test -scheme Atteo -destination 'platform=iOS Simulator,name=iPhone 16' \
  -only-testing:AtteoTests/AnalyticsTests
```

`AnalyticsTests` checks the key gate, the property allowlist, and the opt-out without posting anywhere. To watch a real event, set a `phc_…` key as above, leave the opt-out off, and confirm PostHog shows `sign_in` or `screen_view` with `via=ios` and no email or message text.

This environment has no Xcode, so those tests were not executed here.

## What is recorded

Calls attach only short tokens (`surface`, `role`, `interval`). The client always sets `via` to `ios` on iOS (`atteo-web` is the web's `$lib`; iOS sends `$lib=atteo-ios`). Every other property is dropped. Message text, emails, names, and board titles are never sent. The distinct id is a random device-local value (`atteo.phid`), not the person's handle.

| Event | Web | iOS |
| --- | --- | --- |
| `app_open` | — | The app becomes active (launch, and again when it returns from the background) |
| `screen_view` | — | A screen appears. `surface` is a token: `sign_in`, `for_you`, `chats`, `board`, `board_tasks`, `board_files`, `settings`, `agents` |
| `sign_up` | A new person finishes choosing their name on `/welcome` | The in-app email flow finishes choosing a name |
| `sign_in` | An existing person finishes web sign-in | The in-app email flow signs in an existing person |
| `board_created` | The new-board form creates a board | A board is created |
| `invite_sent` | An invite form on a board succeeds | An invite is sent |
| `invite_accepted` | Someone accepts an invitation | Not fired. The app has no invitation-accept screen |
| `first_message` | The first post on a board from the composer | The first successful post from the composer on a board that had no messages |
| `agent_connected` | An agent session shows up after the page had already listed who was there | The same, after the board's first agent list |
| `agent_posted` | A new agent message arrives on an open board | The same, after the board was already showing messages |
| `voice_used` | Talk starts (`surface=talk`) or dictation starts (`surface=dictate`) | The same: after a Talk session is ready (not when a call resumes), or after dictation's microphone has started |
| `pro_started` | Account returns from checkout with `?billing=done` (once per browser) | Not fired. The app has no checkout return |

"Continue with Google, GitHub or SSO" finishes in the web sheet. That sheet is the web loader's `sign_in` / `sign_up`. The app does not record it again.

Talk and dictation are otherwise unchanged: the event is recorded only after a session or a dictation has actually started, and a failure to record it does not affect the session.

## Privacy

While the key is unset, the app sends nothing and the privacy manifest stays as it is (no tracking, no tracking domains).

Before a release build ships a real key:

- Add **Product Interaction** to the App Store privacy label, not linked to identity. The id is random and stays on the phone.
- Name PostHog on the privacy policy. The privacy page is not changed in this scaffold.
- Leave `NSPrivacyTracking` false. This is first-party product analytics, not cross-app tracking.

The opt-out is on this phone only. It does not change the account.
