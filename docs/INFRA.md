# Infrastructure: what Atteo runs on, and what a big launch still needs

Written Oct 6 2026 for vedu #4598 ("research any other infra we might need, ex posthog"). Prices are the vendors'
published list prices as of writing; check them before buying. Load and cost limits are in
[CLOUDFLARE_HARDENING.md](CLOUDFLARE_HARDENING.md) and [COSTS.md](COSTS.md).

## What we have today

| Piece | What it does | Where it's set up |
|---|---|---|
| Cloudflare Worker `agent-board` (Workers Paid, $5/mo) | every page, the API, MCP, A2A, OAuth, the CLI download | `wrangler.jsonc`, `src/index.ts` |
| Durable Object `Board` (SQLite) | one per board: its log, files, WebSockets (hibernating), long-poll waits | `src/board.ts` |
| D1 `agent-board` (4.6 MB, WNAM, no read replicas) | people, sessions, membership, inbox, invites, OAuth, usage counters | `migrations/` |
| Static assets | `public/mermaid.min.js` only; CSS/JS/fonts are built into the Worker | `assets` in `wrangler.jsonc` |
| atteo.dev | a proxy Worker **on jxn's account** that fetches the workers.dev host | outside this repo |
| WorkOS | web sign-in, app magic codes, SSO, Sign in with Apple (off until the dashboard step and `WORKOS_APPLE_OAUTH=1`; [SIGN_IN_WITH_APPLE.md](SIGN_IN_WITH_APPLE.md)) | `WORKOS_*` |
| Resend | email (invites, codes, notifications) | `RESEND_API_KEY` secret |
| Sentry | Worker error reporting, scrubbed of cookies/IPs. iOS SDK linked, **off until a DSN is set** (no DSN in repo configs) | Worker: `SENTRY_DSN` secret, `src/sentry.ts`. iOS: `CrashReporting.swift`, [SENTRY.md](SENTRY.md) |
| xAI | read-aloud TTS and voice chat, capped per person and globally | `XAI_API_KEY`, `VOICE_*`/`TTS_*` vars |
| Cloudflare TURN | voice call relay | `TURN_KEY_*` secrets |
| Stripe | billing (checkout, portal, webhook) | `STRIPE_*` secrets |
| PostHog (landing now) | product analytics | PR 78, `POSTHOG_KEY` |
| Cost guard + load shedder | caps a runaway loop; sheds load by level | `src/costGuard.ts`, `src/limits.ts` |
| Workers observability | Workers Logs on | `"observability": { "enabled": true }` |
| Backups | nightly encrypted export **outside Cloudflare** (B2/S3), code done, **off until a bucket exists** | `src/backup.ts`, `docs/BACKUPS.md` |
| CI | local gate (`scripts/ship.sh`) on every landing; GitHub Actions backstop (refused until Actions billing is fixed, #1981) | `docs/ci.md` |

## What's missing for a launch with lots of users, most important first

| # | Need | Recommendation | Why | Rough cost | Effort |
|---|---|---|---|---|---|
| 1 | **Backups actually running** | Create the B2 (or S3) bucket and the `BACKUP_*` secrets (#3478), then run the restore drill once | The code is done but nothing is being backed up. A bad migration or account problem today loses everything | B2: ~$6/TB-month; we're at MBs, so cents | vedu 15 min, then 1 drill |
| 2 | **One account and zone for atteo.dev** | Move atteo.dev's zone (or a `api.atteo.dev` subdomain) to vedu's account and attach the Worker as a Custom Domain; turn workers.dev off for pages | Today every web request runs two Workers (proxy + ours), and the WAF, rate rules, Bot Fight Mode and caching for our traffic can't be set from our account. The app and CLIs call workers.dev directly, which has no WAF at all | $0 (Free zone is enough to start; Pro $20–25/mo adds WAF managed rules) | jxn + vedu 30 min; app/CLI base URL change after |
| 3 | **Uptime alerts** | Better Stack or UptimeRobot on `/health/deep` every 1 min, alert to phone + email | Nothing pages anyone when prod is down; we find out from the board | Free tier (UptimeRobot 50 monitors / 5 min; Better Stack free 10 monitors) | 10 min |
| 4 | **Cost guard on** | Already done by this branch: `CF_ACCOUNT_ID` var + the `CF_ANALYTICS_TOKEN` secret (already set). Plus Cloudflare billing notifications (dashboard) | Cloudflare has no spending cap; the guard is our cap | $0 | landing + 5 min dashboard |
| 5 | **Sentry alerts that reach someone** | Sentry is wired on the Worker. The iOS SDK is in the app and stays **off** until a DSN is set ([SENTRY.md](SENTRY.md); do not commit one). Still needed: an alert rule (new issue / spike → email + Slack or the bugs board) | Worker errors are recorded but only seen when someone opens Sentry; iOS crashes are not sent until a DSN is configured | Free (5k errors/mo); Team $26/mo | 20 min alerts; iOS SDK is the first slice |
| 6 | **Email capacity** | Check the Resend plan; verify the sending domain (SPF/DKIM/DMARC on atteo.dev) | Free Resend is ~100 emails/day. A launch with invites + codes blows through that, and sign-in codes then fail | Resend Pro $20/mo (50k/mo) | 15 min |
| 7 | **Status page** | Better Stack / Instatus status page fed by the uptime monitors, at status.atteo.dev | Users and investors check it during an incident; it cuts support load | Free tier | 15 min |
| 8 | **Product analytics** | PostHog (web landing now, iOS next) with the funnel events vedu named for the seed round: weekly active boards, boards with 2+ people, invites per user, retention | Can't measure growth without it | Free to 1M events/mo | in progress |
| 9 | **Feature flags / kill switches** | Use PostHog flags for risky launches; keep the server-side switches we have (cost cap, shed levels, voice caps) | Lets us turn a feature off without a deploy | Included in PostHog free tier | 1 h when first needed |
| 10 | **Log retention** | Keep Workers Logs (7 days); add Logpush to R2 only if we need longer history for incidents or audits | 7 days is enough to debug; longer is a compliance question | Logpush to R2: storage cents/month | 30 min, later |
| 11 | **Secrets hygiene** | A short rotation list (WorkOS, Stripe, xAI, Resend, Sentry, ADMIN_KEY) and who holds each; scoped API tokens only | Leaked keys are the cheapest way in | $0 | 30 min doc |
| 12 | **CI backstop** | Fix GitHub Actions billing (#1981) or drop it and rely on the local gate | The local gate already blocks bad landings; Actions only catches drift | $0–4/mo | vedu 5 min |

Not needed yet: a queue (Durable Objects already serialize per board), KV (D1 + DO cover it), a CDN in front
(Cloudflare is the CDN), a separate database (D1 is 4.6 MB; the per-board data lives in Durable Objects).

## Decisions for vedu

1. Create the backup bucket (#1).
2. Agree with jxn on moving atteo.dev (#2). It's the change that makes every Cloudflare protection usable.
3. Pick an uptime tool (#3) and a Resend plan (#6).
