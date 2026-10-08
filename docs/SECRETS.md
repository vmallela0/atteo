# Secrets

Who holds each production secret, how often to rotate it, and the command that stores it.
This page has names and booleans only. It does not contain secret values, and it does not rotate anything.

`/_ops` Overview and `GET /api/ops/overview` report each Worker secret as `set` or `missing`.
Those responses do not include the value. See [INFRA.md](INFRA.md) item 11 and [SELF_HOST.md](SELF_HOST.md).

## Rules

- Store Worker secrets with `npx wrangler secret put <NAME>` from the repo root (Worker `agent-board` in `wrangler.jsonc`). Wrangler prompts for the value. Do not put the value in the command line, a shell history you commit, `wrangler.jsonc` `vars`, this file, a board, or a chat.
- Local values go in `.dev.vars` or `secrets.txt`. Both are gitignored. `DEV_*` and `ALLOW_LOCAL_WEBHOOKS` are local-only and must not be set in production.
- Use a scoped token when the vendor allows one. A full-account key is not the default.
- Default cadence is **90 days**, and the same day someone who could read the value leaves, or the same day a leak is suspected. Exceptions are in the table.
- Holder of every Worker secret: **vedu**, on the Cloudflare account that deploys `agent-board`. **jxn** is an operator and should have a second login on each vendor dashboard before the next rotation, so one person leaving does not lock the key. The atteo.dev zone is on jxn's account ([INFRA.md](INFRA.md)); that zone is not where these Worker secrets live.
- After `wrangler secret put`, deploy is a separate step. This document does not deploy.

## Worker `agent-board`

| Secret | What it unlocks | Scope | Holder | Rotation | Command |
| --- | --- | --- | --- | --- | --- |
| `WORKOS_API_KEY` | Web sign-in, app magic codes, invitation email (WorkOS sends the mail) | The Atteo AuthKit environment only | vedu (WorkOS dashboard + Worker) | 90 days | `npx wrangler secret put WORKOS_API_KEY` |
| `ADMIN_KEY` | Operator API (`x-admin-key` on `/api/ops/*` and `/api/admin/*`) | This deployment only. CI's `ci-admin-key` is not production | vedu | 90 days, and when someone who knew it leaves. Update the operator shell; never commit the new value | `npx wrangler secret put ADMIN_KEY` |
| `STRIPE_SECRET_KEY` | Checkout, customer portal, subscription state | Restricted key: only the billing calls in `src/billing.ts`, when Stripe allows a restricted key | vedu (Stripe dashboard + Worker) | 90 days | `npx wrangler secret put STRIPE_SECRET_KEY` |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature check | That webhook endpoint only | vedu | When the endpoint's signing secret is rolled (with the secret key, or sooner if it leaks). `scripts/stripe-setup.sh` writes this secret; do not commit its output | `npx wrangler secret put STRIPE_WEBHOOK_SECRET` |
| `XAI_API_KEY` | Server read-aloud and Grok voice. Unset: both stay off | The xAI project used for those routes | vedu | 90 days | `npx wrangler secret put XAI_API_KEY` |
| `SENTRY_DSN` | Worker error reports (`src/sentry.ts`). Unset: Sentry stays off. Stored as a secret so dev and CI do not report | That Sentry project | vedu | On compromise (a DSN is an ingest URL once the Worker has it; still never commit it) | `npx wrangler secret put SENTRY_DSN` |
| `GITHUB_WEBHOOK_SECRET` | `POST /github/webhook` HMAC. Unset: the route is 503 | This GitHub App's webhook | vedu | 90 days. Change the App's webhook secret in GitHub in the same step | `npx wrangler secret put GITHUB_WEBHOOK_SECRET` |
| `GITHUB_APP_ID` | Outbound Checks and PR comments, with the private key. Unset: no call to api.github.com | This GitHub App | vedu | With the private key. Not a `wrangler.jsonc` var | `npx wrangler secret put GITHUB_APP_ID` |
| `GITHUB_APP_PRIVATE_KEY` | App JWT for outbound Checks. PEM; GitHub shows it once | Checks: read and write. Pull requests: read and write, only if PR comments are on | vedu | 90 days or on compromise. Generate a new key, put it, then revoke the old key | `npx wrangler secret put GITHUB_APP_PRIVATE_KEY` |
| `GITHUB_APP_INSTALLATION_ID` | Optional. Skips the install lookup | One installation | vedu | When the App is reinstalled | `npx wrangler secret put GITHUB_APP_INSTALLATION_ID` |
| `LINEAR_CLIENT_ID` | The Linear OAuth app (`src/linear.ts`), with the three below. Unset: the `/api/integrations/linear` routes are 503 | That Linear OAuth app | vedu | With the client secret | `npx wrangler secret put LINEAR_CLIENT_ID` |
| `LINEAR_CLIENT_SECRET` | Exchanging Linear OAuth codes; also signs the OAuth state | That Linear OAuth app | vedu (Linear settings → API + Worker) | 90 days. Rotate in Linear, then put the new value | `npx wrangler secret put LINEAR_CLIENT_SECRET` |
| `LINEAR_TOKEN_KEY` | Encrypts Linear tokens in D1 (32 random bytes, base64: `openssl rand -base64 32`) | This deployment | vedu | On compromise only: a new key makes stored tokens unreadable, so every board reconnects Linear | `npx wrangler secret put LINEAR_TOKEN_KEY` |
| `LINEAR_WEBHOOK_SECRET` | `POST /api/integrations/linear/webhook` signature check. Unset: the webhook is 503 | That Linear webhook | vedu | 90 days. Change it in Linear in the same step | `npx wrangler secret put LINEAR_WEBHOOK_SECRET` |
| `DISCORD_APPLICATION_ID` | The Discord integration (`src/discord.ts`), with the two below. Unset: the `/api/integrations/discord` routes are 503. Not a credential (it's in the install link) | That Discord application | vedu | Never, unless the application is replaced | `npx wrangler secret put DISCORD_APPLICATION_ID` |
| `DISCORD_PUBLIC_KEY` | Checks the Ed25519 signature on every `POST /api/integrations/discord/interactions` (hex, from the portal's General Information) | Not a credential; a wrong value refuses every interaction | vedu | When Discord shows a new one | `npx wrangler secret put DISCORD_PUBLIC_KEY` |
| `DISCORD_BOT_TOKEN` | Posts board messages to linked channels; leaves servers when their last link goes | The bot: View Channel, Send Messages, Read Message History in servers that added it | vedu (Developer Portal → Bot → Reset Token) | 90 days or on compromise. Reset in the portal, then put the new value | `npx wrangler secret put DISCORD_BOT_TOKEN` |
| `NOTION_CLIENT_ID` | The Notion public integration (`src/notion.ts`), with the two below. Unset: the `/api/integrations/notion` routes are 503. Not a credential (it's in the consent link) | That Notion integration | vedu | Never, unless the integration is replaced | `npx wrangler secret put NOTION_CLIENT_ID` |
| `NOTION_CLIENT_SECRET` | Exchanging Notion OAuth codes, refreshing and revoking tokens (HTTP Basic) | That Notion integration | vedu (notion.so/profile/integrations → the integration → Configuration) | 90 days or on compromise. Rotate in Notion, then put the new value | `npx wrangler secret put NOTION_CLIENT_SECRET` |
| `NOTION_TOKEN_KEY` | Encrypts Notion tokens in D1 (32 random bytes, base64: `openssl rand -base64 32`) | This deployment | vedu | On compromise only: a new key makes stored tokens unreadable, so every board reconnects Notion | `npx wrangler secret put NOTION_TOKEN_KEY` |
| `TEAMS_APP_ID` | The Microsoft Teams integration (`src/teams.ts`, [TEAMS.md](TEAMS.md)), with the one below. The audience every inbound Bot Framework token must carry. Unset: the `/api/integrations/teams` routes are 503. Not a credential (it's in the app manifest) | That Azure bot | vedu | Never, unless the bot is replaced | `npx wrangler secret put TEAMS_APP_ID` |
| `TEAMS_APP_PASSWORD` | The app registration's client secret: gets the bot's token to post to linked channels and answer commands; also keys the link-code hash | The bot in teams that added the Atteo app | vedu (Azure portal → the bot's app registration → Certificates & secrets) | Before it expires (Azure caps secrets at 24 months), or on compromise. Add a new secret, put it, then delete the old one | `npx wrangler secret put TEAMS_APP_PASSWORD` |
| `TEAMS_TENANT_ID` | Optional. Set for a single-tenant bot: tokens come from this tenant, and activities from any other tenant are refused | Not a credential | vedu | When the bot moves tenant | `npx wrangler secret put TEAMS_TENANT_ID` |
| `BACKUP_PUBLIC_KEY` | Turns nightly backups on. The public half only; the Worker cannot read a backup back | Not a credential. It is a secret so local and test Workers that share `wrangler.jsonc` do not upload | vedu | When the offline private key is replaced. Old nights open only with the old private key | `npx wrangler secret put BACKUP_PUBLIC_KEY` |
| `BACKUP_S3_KEY_ID` | Optional outside bucket (B2 or S3). Unused while nights go to R2 | Write-only on that one bucket (`s3:PutObject` or B2 Write Only) | vedu | 90 days, if the outside bucket is on | `npx wrangler secret put BACKUP_S3_KEY_ID` |
| `BACKUP_S3_SECRET` | Signs those write-only uploads | Same bucket, write-only | vedu | With the key id | `npx wrangler secret put BACKUP_S3_SECRET` |
| `POSTHOG_KEY` | Product analytics loader. Public project key (`phc_…`), already a var. A blank or non-`phc_` key leaves analytics off | Ingest only. Do not put a personal API key here | vedu (PostHog project 647810) | Revoke in PostHog if the project is spammed. Not a 90-day secret | `npx wrangler secret put POSTHOG_KEY` or the `POSTHOG_KEY` var |
| `CF_ANALYTICS_TOKEN` | Cost guard (`src/costGuard.ts`) | Account Analytics: Read | vedu | 90 days | `npx wrangler secret put CF_ANALYTICS_TOKEN` |
| `CF_API_TOKEN` | Older fallback for the same analytics read (cost guard and the load shedder) | Account Analytics: Read. Do not keep a broader token | vedu | 90 days. Prefer `CF_ANALYTICS_TOKEN` and drop this if both are set | `npx wrangler secret put CF_API_TOKEN` |
| `AI_ACCOUNT_ID` | Workers AI injection screen, with `AI_TOKEN` | The account id for that REST call | vedu | With `AI_TOKEN` | `npx wrangler secret put AI_ACCOUNT_ID` |
| `AI_TOKEN` | Workers AI injection screen. Unset: the screen is skipped | Workers AI: Read | vedu | 90 days | `npx wrangler secret put AI_TOKEN` |
| `APNS_KEY` | iOS push (Apple `.p8`). Unset: devices can register, sending stays off | That push key | vedu (Apple Developer account, when it exists) | On compromise or when the Apple team changes. Apple allows few keys, so there is no 90-day clock | `npx wrangler secret put APNS_KEY` |
| `A2A_SIGNING_KEY` | Signed Agent Card. Unset: the card is served unsigned | ES256 private JWK from `node scripts/a2a-key.mjs keygen` | vedu | Yearly, or on compromise. Cards signed with the old key stop verifying | `npx wrangler secret put A2A_SIGNING_KEY` |

`WORKOS_CLIENT_ID`, `CF_ACCOUNT_ID`, `POSTHOG_HOST`, and the other `wrangler.jsonc` vars are not secrets. Do not move a secret into `vars` to make it easier to see.

`BACKUP_R2` is an R2 binding (`atteo-backups`), not a secret. Nights use it until every required `BACKUP_S3_*` setting is present ([BACKUPS.md](BACKUPS.md)).

## Not on this Worker

| Name | What it is | Holder | Rotation | How it is stored |
| --- | --- | --- | --- | --- |
| Backup private key | Decrypts nightly backups. The Worker never has it | vedu, offline (password manager plus the machine that ran `node scripts/backup.mjs keygen`) | No calendar. Nights already written open only with this file. Replace it only with a plan that keeps old ciphertext readable | Not a Worker secret. Do not `wrangler secret put` it |
| S3 read-only restore key | Lists and downloads an outside bucket during a drill | vedu, operator machine | 90 days if that bucket exists | Operator environment for `scripts/backup.mjs`. Not a Worker secret |
| `CLOUDFLARE_API_TOKEN` | `scripts/ship.sh` deploy. Not the Worker's `CF_API_TOKEN` | vedu | 90 days | Operator shell. Scope it to deploy (Workers scripts, D1, and R2 on the backup bucket). `CLOUDFLARE_ACCOUNT_ID` next to it is an account id, not this token |
| `CF_WEB_ANALYTICS_TOKEN` | Cloudflare Web Analytics beacon on the signed-out landing page. Unset: no snippet | vedu | On compromise | `npx wrangler secret put CF_WEB_ANALYTICS_TOKEN -c landing/wrangler.jsonc` |
| iOS Sentry DSN | Phone crashes, same Sentry project as the Worker, only if a DSN is set on the app build | vedu | On compromise, with the Worker DSN | Not in this repo. [SENTRY.md](SENTRY.md). Do not commit a DSN |
| `RESEND_API_KEY` | Count-only browser-agent alerts and connection security notices (`src/agentEmail.ts`). Invitation and sign-in mail stays on WorkOS | vedu | 90 days | `npx wrangler secret put RESEND_API_KEY`; never put it in vars or this repo |
| `TURN_KEY_*` | Named in [INFRA.md](INFRA.md) for voice relay. There is no `TURN` binding on `Env`. Voice uses `XAI_API_KEY` | — | — | Do not invent a Worker secret for TURN from this page |

## `GET /api/ops/overview`

The `secrets` array is `{ "name": "<NAME>", "set": true }` or `"set": false`. One boolean per row in the Worker `agent-board` table. Names that are not on this Worker are absent. No other fields.
