# Haptics and iOS-native extras for Atteo (research for #1053)

Research only; no app code changed. Date: 2026-10-03.

## Build first (the best 5)

1. **Haptics service + "Haptics" toggle (S).** Route every call through one `Haptics` type that checks a pref; add the toggle in Settings > Display. Today `Haptic.tap/done/warn` (Theme.swift:369-373) fire with no off switch. This is the ask in #1053 and unblocks everything else.
2. **Trim and retune the existing haptics (S).** About 40 call sites use only 3 feelings, and many are plain navigation taps (open profile, open tasks, open agents). Keep haptics for state changes, drop them from navigation. Add the missing moments: task tick/complete, approve/deny, reaction, shipped.
3. **Interactive notification actions: Approve / Deny / Reply (M).** The design language already promises this. Highest "decider" value: act without opening the app. Needs a push entitlement (paid account).
4. **Live Activity + Dynamic Island for "agent is working on your request" (M-L).** Matches the momentum principle. Local start/update works on a free team; push updates need the paid account.
5. **Effects pack with Reduce Motion + "Effects" toggle (S-M).** Shipped confetti (about 1 s), task ring completing, symbolEffect bounce on done. Free-team friendly, no server needed. Pairs with the shipped-celebration haptic.

Runner-up: App Intents / Shortcuts ("Ask my agent", "Open board", "What needs me?"), which also feed Spotlight and Siri and need no paid account.

## 1. What the app does today

One wrapper, `ios/AgentSoup/Sources/Theme.swift:369-373`:
- `Haptic.tap()` = UIImpactFeedbackGenerator(.light)
- `Haptic.done()` = UINotificationFeedbackGenerator .success
- `Haptic.warn()` = UINotificationFeedbackGenerator .warning

Other direct use: `SignInView.swift:154` UISelectionFeedbackGenerator on each code digit typed.

Not used anywhere: `sensoryFeedback`, CoreHaptics, `symbolEffect` triggers (only `.contentTransition(.symbolEffect(.replace))` at TasksView.swift:55, 743), TipKit, ActivityKit, WidgetKit, App Intents, CoreSpotlight, NSUserActivity, UNUserNotificationCenter (no push or notification-action code at all). No haptics settings toggle exists.

Call sites (file:line):
- **Send confirmed** (`done`): AppState.swift:415 (note send ack), :496, :550 (uploads). **Send failed** (`warn`): :425, :506, :510, :560, :565. The success buzz fires when the server acks, not on tap, so it lands late and on every message.
- Avatar saved `done` AppState.swift:315. Reaction: `tap` :637, `done` :655, `warn` :657. Take on `tap` :663.
- Human decision vote: HumanDecisions.swift:55 tap, :63 done if agree, :66 warn, :79-80 close decision done/warn.
- Swipe-to-reply threshold crossing `tap`: BoardsView.swift:802 (fires crossing in either direction).
- Navigation / chrome taps (`tap`): BoardsView.swift:131, 132, 221, 234, 242, 322, 331, 350, 379, 465, 478, 538, 571, 593, 1007; DocsView.swift:213, 225, 580; ChangeCard.swift:209, 220; SettingsView.swift:115.
- Copy: `tap` BoardsView.swift:793, 795; `done` BoardInfoView.swift:116 (link copied).
- Errors `warn`: BoardsView.swift:368, 570, 582; DocsView.swift:220, 227; SettingsView.swift:66 (revoke); AppState+Web.swift:41.
- No haptic at all: task tick (TasksView), the 🤔 -> ✅ flip, shipped cards. Pull to refresh (`.refreshable` at ChatsView:201, BoardsView:293, TasksView:284, ...) and `.contextMenu` get only the system's own feedback.

Settings: Display section `SettingsView.swift:52-59` has Text size / Density / Theme pickers. Stored by `AppState.setDisplay` (AppState.swift ~143): UserDefaults key `display-prefs` as JSON `DisplayPrefs` (Theme.swift:268: text, density, theme), debounced 400 ms and POSTed to `/api/me/profile` as `{display:{...}}`. Reduce Motion is read in only three places: Typing.swift:84, SignInView.swift:9, Theme.swift:170.

Project facts: `ios/project.yml` sets bundle id `com.atteo.app` (not com.agentsoup.app), iOS 18 target, `DEVELOPMENT_TEAM: ""`, automatic signing, iPhone only.

## 2. Apple's guidance (summarized)

- HIG "Playing haptics": haptics supplement visuals and sound; they should match what you see (a heavy thing feels heavy). Use them for meaningful moments (success, failure, something about to happen), not decoration; too much becomes noise and people tune out. Use the system-defined patterns consistently so the meaning is learned, and never make haptics the only signal (some devices and many people have them off).
- SwiftUI `.sensoryFeedback(_:trigger:)` (iOS 17+): declarative; fires when `trigger` changes. Types: `.success`, `.warning`, `.error`, `.selection`, `.increase`, `.decrease`, `.start`, `.stop`, `.alignment`, `.levelChange`, `.impact` (weight light/medium/heavy or flexibility soft/solid/rigid, plus intensity). A condition closure lets you fire only on certain transitions. No-ops where unsupported. Our target is iOS 18, so it is available.
- UIKit generators remain fine from non-view code such as AppState. Call `prepare()` shortly before an expected haptic (e.g. when a swipe starts) to cut latency. The system can suppress the Taptic Engine (Low Power, dictation, camera), so never depend on it.
- Core Haptics (`CHHapticEngine`, AHAP files): custom transient/continuous events with intensity and sharpness curves, synced with audio. Only worth it for a signature moment (shipped celebration). Check `CHHapticEngine.capabilitiesForHardware().supportsHaptics` and fall back to a system haptic. Engine lifecycle and interruptions add code, so avoid elsewhere.
- Accessibility: Reduce Motion governs animation, not haptics. iOS has Settings > Sounds & Haptics > System Haptics, which silences standard feedback globally; our own toggle is for people who want it off only in Atteo.

Sources: Apple HIG Playing haptics; WWDC21 "Practice audio haptic design" (10278); WWDC19 "Introducing Core Haptics" (520) and "Haptic design" (810); SwiftUI `SensoryFeedback` docs; community write-ups at swiftwithmajid.com and useyourloaf.com.

## 3. Proposed haptics map

Principle: one feeling per meaning. Success = completed thing, warning = needs attention or denied, error = failed, selection = discrete scrubbing, light impact = a physical touch. Nothing for navigation, scrolling, or incoming messages from others.

| Moment | Feedback | Why / change from today |
|---|---|---|
| Send | `.impact(flexibility: .soft)` on tap of send; nothing on server ack | Feels like pressing a key. The ack buzz now lands late on every message, so move or drop it. |
| Reply lands (someone else's message arrives) | none while viewing the board; notification sound/haptic only when backgrounded | Incoming chatter must stay quiet. |
| Reaction | `.impact(flexibility: .rigid, intensity: 0.6)` when applied; `.error` only on failure | Small pop matching the reaction animation. Replaces the tap+done pair (AppState:637/655). |
| 🤔 on it -> ✅ done (on a message I sent) | `.success`, only if foreground with that board open; skip for others' messages | The payoff of delegating, not a buzz per receipt. |
| Task tick (checklist item) | `.selection` | Discrete toggle. |
| Task complete (all items done) | `.success` + ring completion animation | A real outcome. |
| Approve | `.success` | Confirms a grant. Optionally `.impact(.medium)` on swipe commit, success on server ok. |
| Deny | `.warning` | Distinct from approve so the thumb can tell without looking. |
| Human decision vote | agree `.success`; disagree `.warning`; drop the extra tap (HumanDecisions:55) | Same vocabulary as approvals. |
| Swipe-to-reply threshold | `.impact(.light)` once when crossing into armed; nothing (or `.selection`) crossing back; `prepare()` at drag start | Matches iMessage. Today it fires both directions (BoardsView:802). |
| Pull to refresh | none | System already ticks; do not double up. |
| Long-press menu | none (system provides it); `.selection` per emoji if we build a custom reaction tray | Free. |
| Error / send failed | `.error` | Distinct from `.warning`; today `warn` covers both errors and denials. |
| Shipped celebration | Core Haptics: 2-3 soft transients ramping up, light tail, about 1 s, synced to confetti; fallback `.success` | The one place a custom pattern earns its keep. |
| Tick-wheel scrub | `.selection` per detent, `.alignment` at snap points | The standard picker feel. |
| Navigation taps (open profile, tasks, agents, etc.) | none | Remove about 20 of today's `Haptic.tap()` calls; keep a small `.success` for Copy. |
| Sign-in code digit | keep `.selection` (SignInView:154) | Fine as is. |

Implementation shape: `enum Haptics { static func play(_ kind: Kind) }` that no-ops when the pref is off, with kinds named by meaning (`.sent`, `.reacted`, `.approved`, `.denied`, `.ticked`, `.completed`, `.failed`, `.shipped`, `.armed`). Views use `.sensoryFeedback` where there is a natural trigger; AppState and other non-view code call `Haptics.play`. Collapse two haptics within about 100 ms into one.

## 4. Other iOS-native features

The paid Apple Developer Program ($99/yr) is required for push (APNs) and anything that rides on it, Associated Domains (universal links), TestFlight/App Store, and in practice for App Groups shared with extensions. A free personal team can build to a device (signing expires every 7 days) with a small set of capabilities. "Free" below means buildable on our free team.

| Feature | Value | Effort | Requirements |
|---|---|---|---|
| Interactive notifications (Approve / Deny / Reply) | Very high: decide from the lock screen | M | Needs APNs, so **paid**. Server needs an APNs sender (a Worker can sign the JWT). Category + `UNNotificationAction` (text input for Reply). Local notifications work free. |
| Live Activity + Dynamic Island (agent working, 🤔 -> ✅, task ring) | High: matches "momentum" | M-L | ActivityKit + Widget Extension. Local start/update **free**; remote push-to-update/start needs **paid**. |
| Interactive widgets (Home/Lock Screen: "N need you" with Approve/Deny via App Intents) | High | M | Widget Extension + App Intents + App Group for shared data (**paid** to be reliable). Push-driven refresh **paid**. |
| App Intents / Shortcuts / Siri ("Ask my agent", "Open board", "What needs me?") | High, cheap; makes the app scriptable | S-M | **Free**. `AppShortcutsProvider` gives zero-setup Siri and Spotlight phrases; base for widgets, Control Center, Action button. |
| Spotlight (CoreSpotlight / App Intents entities: boards, docs, people) | Medium | S-M | **Free**. Do not index encrypted boards' content. |
| Control Center controls (iOS 18 `ControlWidget`: "Ask agent", "Inbox") | Medium | S-M | Widget Extension + App Intents; possible on **free**, App Group helps. |
| Focus filters (hide some boards in a Work focus) | Medium: a differentiator | S-M | **Free** (`SetFocusFilterIntent`). |
| Share extension (send text/link/image to a board) | High: capture from anywhere | M | Extension + App Group + shared keychain: effectively **paid**. |
| Context menus with previews | Medium; menus exist (BoardsView:780, TasksView:312, DocsView:150) | S | **Free**. Add `preview:` for docs and change cards. |
| Drag and drop (files into composer, messages out) | Medium on iPad, low on iPhone | S-M | **Free** (`.draggable` / `.dropDestination`). |
| TipKit (first-run hints for swipe-to-reply, hold for reactions) | Medium: surfaces hidden gestures | S | **Free**, iOS 17+. Add a "Reset tips" row. |
| Handoff | Low until there is an iPad/Mac client | S | **Free** (`NSUserActivity`). |
| SF Symbol animations (`symbolEffect`: bounce on done, pulse on 🤔, variableColor while an agent works) | Medium: cheap polish | S | **Free**. Today only `.replace` in TasksView. |
| Reduce Motion handling | Required | S | **Free**. Audit `withAnimation`/springs (e.g. PressStyle, Theme.swift:361) through a shared `Motion` helper returning nil when Reduce Motion or Effects is off. Only 3 places check it now. |
| Universal links for board invites | High for growth | S-M | Associated Domains = **paid**. |

## 5. Settings design

Add two rows in Settings > Display (`SettingsView.swift`, after Theme), or a small "Feel" section just below:
- **Haptics** (toggle, default on). Footer: "Taps and buzzes for sends, approvals and finished work. Your iPhone's System Haptics setting still applies."
- **Effects** (toggle, default on). Footer: "Celebrations and extra animation. Follows your iPhone's Reduce Motion setting." When system Reduce Motion is on, show it off and disabled with "Off because Reduce Motion is on."
- Later: a "Reset tips" row for TipKit.

Behavior:
- `Haptics.enabled` = pref on AND hardware supports haptics. `Effects.enabled` = pref on AND NOT `UIAccessibility.isReduceMotionEnabled` (observe `reduceMotionStatusDidChangeNotification`). The shipped buzz follows Haptics, the confetti follows Effects, each independently.
- Under Reduce Motion, also swap springs for short fades, not just hide effects.

Storage and sync:
- Display prefs today: `DisplayPrefs` (Theme.swift:268), cached in UserDefaults `display-prefs`, saved by `AppState.setDisplay` to profile `display`. The server validates keys strictly: `src/social.ts:311-340` (`Display` type, `DISPLAY_DEFAULTS`, `DISPLAY_VALUES`); an unknown key returns 400 ("use text, density or theme"). There is no `display_prefs` name; the column is `display`.
- Recommendation: **Haptics is per device**: `@AppStorage("haptics")` in UserDefaults, not synced. Only phones have a Taptic Engine, the preference is physical and device-specific, and it needs no server change, so it can ship immediately.
- **Effects** can sync like Display: add `effects: "on" | "off"` to `DisplayPrefs` and to `Display`/`DISPLAY_VALUES`/`DISPLAY_DEFAULTS` in src/social.ts so the web can honor it for its own animations. Needs a server deploy; `DisplayPrefs.init(from:)` already defaults missing keys, so old payloads decode. If we want zero server work first, ship Effects local and migrate later.
- For tests: pin both off under a DEBUG env var like `ATTEO_DISPLAY`, and run UI tests with haptics off.

## 6. Suggested order

1. `Haptics` wrapper + toggle + retune call sites, then the new moments.
2. `Motion` helper (Reduce Motion + Effects), then shipped confetti, ring and symbolEffect polish.
3. App Intents + Spotlight + TipKit (all free).
4. Once the paid account exists: push, notification actions, Live Activity pushes, interactive widgets, share extension, universal links.
