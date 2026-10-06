# Product analytics

Web product analytics uses [PostHog](https://posthog.com) Cloud. The loader ships with the app and **does nothing until a project API key is set**. No key is required to deploy this scaffold. The iOS SDK is a follow-up.

**Status (Oct 6, vedu #4577/#4602): on.** Project 647810 "Atteo" on PostHog Cloud US; the key and `POSTHOG_HOST: "us"` are vars in `wrangler.jsonc`. Requests to localhost (wrangler dev, every test suite) never load it, so local runs don't send events to the production project; `.dev.vars` can't turn it on locally either.

The project API key (`phc_…`) is public: it can only record events. It is safe in the browser. Do not put a personal API key here.

## Turn it on

1. In the PostHog project (org Atteo, Cloud EU unless you choose US), copy the **project API key**.
2. Set it on the app Worker. Either a var in `wrangler.jsonc` or a secret is fine:

   ```sh
   npx wrangler secret put POSTHOG_KEY
   # paste the phc_… key
   ```

   And the region, if it is not EU:

   ```jsonc
   "POSTHOG_HOST": "eu"
   ```

   `POSTHOG_HOST` is `eu` (default when omitted) or `us`. A blank key, a key that is not a `phc_…` project key, or any other host leaves analytics **off**. Events go to `https://eu.i.posthog.com/capture/` or `https://us.i.posthog.com/capture/`.

3. Locally it stays off: the loader is skipped for localhost requests (src/index.ts).

Until the key is set, pages do not load PostHog, `connect-src` does not list it, and no cookie is set.

## What is recorded

| Event | When |
| --- | --- |
| `page_view` | Any app page loads; `surface` is the route only (`board`, `inbox`, `home`, …), never ids or the query |
| `sign_up` | A new person finishes choosing their name on `/welcome` |
| `sign_in` | An existing person finishes web sign-in |
| `board_created` | The new-board form creates a board |
| `invite_sent` | An invite form on a board succeeds (the loader counts the form's reset, which only follows success) |
| `invite_accepted` | Someone accepts an invitation |
| `first_message` | The first post on a board from the web composer |
| `agent_connected` | One of *your* agent sessions shows up on a board after the page had already listed who was there |
| `agent_posted` | A new message from *your* agent arrives on a board you have open (others' agents aren't counted, or every viewer would count every post) |
| `voice_used` | A Talk session starts (`surface=talk`) or dictation starts (`surface=dictate`) |
| `pro_started` | Account returns from checkout with `?billing=done` (once per browser) |

Those three navigation events (`sign_up`, `sign_in`, `board_created`) are a short `ab_track` cookie the next page reads. It holds only the event name.

Calls attach only these properties, and only as short tokens (`surface`, `role`, `interval`, `via`). The loader drops every other property. It never sends message text, emails, names, or board titles. The distinct id is a random id in `localStorage` (`atteo.phid`), not the person's handle.

The browser sends nothing when Do Not Track is `1` or `yes`, or when Global Privacy Control is on. If those signals cannot be read, it sends nothing.

## Cloudflare Web Analytics (optional)

The marketing home (signed-out `atteo.dev/`) can load Cloudflare Web Analytics, which does not use cookies. Set `CF_WEB_ANALYTICS_TOKEN` on the **landing** Worker (`landing/wrangler.jsonc`). Guide, FAQ, and the app are unchanged. Unset, the landing page has no beacon and its content security policy stays as it is.

## Follow-ups while the key is missing

`/_ops` says product analytics is off and points here. Two things wait until `POSTHOG_KEY` is set:

- Name PostHog on [/privacy](https://atteo.dev/privacy) (and the App Store privacy label: usage data, not linked to identity, since the web does not identify people). The privacy page is not changed in this scaffold.
- Link the PostHog activation dashboard from `/_ops`.

iOS (the PostHog SDK, the same events, and an opt-out in Settings) is a separate change.

## Feature flags and kill switches

Server-side flags live in `src/flags.ts` (INFRA.md item 9). They use the **same** `POSTHOG_KEY` and `POSTHOG_HOST` as the loader. There is no second key. A personal API key (`phx_…`) is refused: PostHog local evaluation needs one, and this Worker does not do local evaluation. The lookup is `POST https://us.i.posthog.com/flags?v=2` (or the EU ingest host when `POSTHOG_HOST` is `eu`) with the project key and the distinct id `atteo-server`. The body has those two fields only: no email, handle, board id, or group. The browser loader does not read flags.

Atteo's flags belong in **PostHog Cloud US, project 647810**. `POSTHOG_HOST` in `wrangler.jsonc` is already `us`. An EU host would ask the EU project, which does not have these flags, and every flag would use its unknown default.

### What each flag does when nobody has said

| Flag | Env var (always wins) | When the key is missing, the host is refused, the lookup fails, or PostHog omits the flag | Wired |
| --- | --- | --- | --- |
| `disable_voice` | `FLAG_DISABLE_VOICE` | **open** — stays off, so Talk is not killed by an outage | No. Talk transport is unchanged |
| `disable_host_runs` | `FLAG_DISABLE_HOST_RUNS` | **open** — stays off | No. Defined for a later slice |
| `disable_github_outbound` | `FLAG_DISABLE_GITHUB_OUTBOUND` | **open** — stays off | No. Defined for a later slice |
| `disable_north_star` | `FLAG_DISABLE_NORTH_STAR` | **open** — stays off, so the Monday post still runs | Yes. `src/northStar.ts` skips that post and does not take the weekly claim. The hourly snapshot still runs |

**Open** means the flag's value is false when it is unknown. For these `disable_*` flags, that leaves the feature available: a PostHog outage does not kill it. **Closed** (none of these four) means the value is true when it is unknown, so a `disable_*` flag stays pulled until PostHog returns an explicit false. An explicit boolean from PostHog wins over that default. The env var wins over both, and the Worker skips the lookup when the var is set.

Recognized env tokens, compared after trimming and lowercasing: `1`, `true`, `on`, `yes` force the flag on; `0`, `false`, `off`, `no` force it off. Any other value is ignored and the lookup runs as if the var were unset.

A lookup that fails (network, timeout at 1.5s, non-200, JSON that is not an evaluation, or `errorsWhileComputingFlags: true`) is cached in that isolate for 60 seconds, then retried. The cache holds the public project key only long enough to know which project it belongs to. Nothing is written to the repo to turn a flag on. Do not commit `FLAG_DISABLE_*=1` in `wrangler.jsonc`.

Set an override in the Cloudflare dashboard (Workers → `agent-board` → Settings → Variables) or with a var on the next deploy. That is the switch to use when PostHog itself is down. Example: `FLAG_DISABLE_NORTH_STAR=1` stops Monday posts until you set it to `0` or delete it.

### Create the flags (vedu, project 647810)

1. Open [Feature flags for project 647810](https://us.posthog.com/project/647810/feature_flags). The project is "Atteo" on PostHog Cloud US. The org is Atteo.
2. New feature flag. The key must match the table exactly (`disable_north_star`, and the other three when you want them). PostHog keys are case-sensitive.
3. Type: boolean release toggle, not a multivariate experiment. The Worker reads `enabled` and ignores variant names.
4. No property filters and no groups. Every evaluation is the distinct id `atteo-server`, so a filter on person properties would never match and the flag would stay at its unknown default.
5. Save it **inactive**, or active with a 0% rollout, until you mean to pull the switch. Inactive and 0% both evaluate as `enabled: false` (the feature keeps working).
6. To pull a kill switch without a code change: set the flag active and the rollout to 100%. To put the feature back: disable the flag or set the rollout to 0%. The Worker picks that up within a minute (the 60s isolate cache) on the next read.
7. Create `disable_north_star` first. It is the only flag this slice reads. The other three are in the registry so the keys exist before something calls them; creating them in PostHog early is fine and changes nothing until a later slice wires them.

`disable_north_star` at 100% skips the Monday line on `NORTH_STAR_BOARD`. It does not stop the weekly count snapshot. Clearing the flag (or setting `FLAG_DISABLE_NORTH_STAR=0`) lets a later cron that week post, because the skipped run does not take the once-per-week claim.
