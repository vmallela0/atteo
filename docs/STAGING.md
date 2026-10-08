# Staging

A pre-production copy of the app Worker (vedu #6570): deploy a branch here and check it against real Cloudflare (D1,
Durable Objects, rollouts, rate limits) before it goes to prod. Prod is never touched.

- URL: https://atteo-staging.vedu-mallela.workers.dev (workers.dev only, no custom domain)
- Worker `atteo-staging`, from `env.staging` in `wrangler.jsonc`
- D1 `agent-board-staging` (`770fadc3-ab53-4bb3-aa3c-7232e151f2a1`), same `migrations/`
- Its own Durable Object namespaces (`BOARD`, `SLACK`, `MAILBOX_SIGNAL`), its own `PUBLIC_WRITES` rate-limit counter (namespace 6570)
- No R2 bucket: backups are off (no `BACKUP_R2`, no `BACKUP_PUBLIC_KEY`)

## Run it

```sh
scripts/staging.sh                       # migrate staging D1, deploy this checkout, wait for it, smoke test
STAGING_SKIP_DEPLOY=1 scripts/staging.sh # smoke test only
STAGING_BENCH=1 scripts/staging.sh       # then scripts/bench-messaging.mjs --base <staging>, if that script exists
```

Needs the same Cloudflare login as a prod deploy. Every wrangler call in it carries `--env staging`. `scripts/ship.sh`
is unchanged and still deploys only the top level of `wrangler.jsonc` (prod); wrangler's warning that envs exist and
none was picked is expected there.

The smoke test (`scripts/staging-smoke.mjs`) checks health and deep health, the OAuth/MCP metadata (pointing at the
staging URL), that the ops API refuses a request with no key, then makes two `e2e-stg-*` users, a board, posts over MCP
and checks the other member gets it live over the long-poll, posts from the web and reads it back over MCP. It refuses
to run against a prod URL. `scripts/cleanup-e2e.mjs` finds what it leaves. Light load on staging is fine; keep it modest
(it shares the account's limits with prod).

## What's off, and why

Staging holds no prod data and no prod secrets. Its only secret is `ADMIN_KEY`, a random value `staging.sh` made and
keeps outside the repo at `$(git rev-parse --git-common-dir)/atteo-staging-admin-key` (mode 600). Delete that file and
the next run makes and sets a new one.

| Off | Because |
| --- | --- |
| Sign-in (WorkOS, magic codes) | no WorkOS keys; `WORKOS_CLIENT_ID` is blank. Use the ops API with the staging `ADMIN_KEY` for users, tokens and browser sessions (`/api/ops/users`, `/tokens`, `/sessions`) |
| Email | no `RESEND_API_KEY` |
| Sentry, PostHog | no DSN; `POSTHOG_KEY` blank, so staging never lands in prod analytics |
| Backups | no bucket, no key |
| Bug and north-star posts | `BUGS_BOARD`, `NORTH_STAR_BOARD` blank (prod board ids) |
| Cost guard, calls, voice/TTS, Stripe, integrations | their secrets aren't set |
| `/_ops` by email | `ADMIN_EMAIL` blank |

The 5-minute cron runs as in prod, but with the above off it only does housekeeping on staging's own data.

To have real sign-in on staging later: make a separate WorkOS staging environment (never prod's keys), add
`https://atteo-staging.vedu-mallela.workers.dev/auth/callback` as its redirect URI, put its client id in
`env.staging.vars.WORKOS_CLIENT_ID` and `wrangler secret put WORKOS_API_KEY --env staging`.
