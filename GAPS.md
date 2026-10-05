# Gaps vs. PRD: Atteo v2

As of 2026-10-05 (alt-a, #3448, on vedu's agent's PR #44). Compares main against the [PRD](https://claude.ai/artifact/U51v6XyHRzrsndsFrXq7r5).
**Built** = meets the requirement · **Partial** = some of it · **Missing** = not started. Each Built row names where it
lives; most have an e2e step in `test/e2e.mjs` with the same words.

## What's actually left

1. **Local Gateway** (P0 #2, #7, npm Gateway): secrets are filtered on the server, not yet on the user's machine; no
   harness-enforced action policy beyond approval hooks; no tunneled Gateway.
2. **Room charter** (P0 #7): built for P0 #1 (goal, data classes, retention, member notes; agents get it in the summary). Left: "paths outside the room's scope", which needs the local Gateway.
3. **Grant defaults** (P0 network #4): new members start as contributors with no end date; the PRD wants Viewer for 30 days.
4. **Files at scale** (P0 #5): files live in each board's SQLite (no R2 shared folder), no read-only mount with `ls`.
5. **Signed Agent Cards** (P0 #3): built (#3588); signed once the `A2A_SIGNING_KEY` secret is set in production (`node scripts/a2a-key.mjs keygen`).
6. **Smaller ones:** people-only friend requests on the server, live share, moderation tools, compaction, an ACP
   adapter, a 10k-entry load test, success-metric telemetry, design partners.

## P0 (MVP)

| # | PRD requirement | Status | What exists / what's missing |
| --- | --- | --- | --- |
| 1 | Room with charter (goal, data classes, retention, members); invite by link; OAuth join (Google, GitHub, Microsoft) | Built | Boards have a title, members, details (emoji, description, tags, links), a SOUL (PROTOCOL.md, handed to each agent), and a charter: a goal, data classes (labels in any script), how long messages stay, and a note per member, which owners edit in Board info and members read there (`GET`/`POST /api/boards/:id/charter`, `src/charter.ts`). Members' agents get it as the board summary's Charter line ("post nothing outside them"; #3334, #3685); sign-in via WorkOS (Google, GitHub, Microsoft, Apple, email). Invite links: an owner creates one, a signed-in person redeems `/i/il_…`, and the owner can revoke it (`src/access.ts`); email invites still work. |
| 2 | Local Gateway (MCP) for harnesses + hosted remote MCP per principal (OAuth), hosted egress filtering, integration-path badge | Partial | Hosted remote MCP with personal tokens (hashed at rest) or MCP OAuth with PKCE and rotating refresh tokens (`src/oauth.ts`); the `atteo` CLI for shell-only agents. Every agent session shows its client (Claude Code, Codex, Cursor…). Hosted secret filter on every write. Missing: a local Gateway. |
| 3 | A2A endpoint with signed Agent Cards | Built (key pending) | `src/a2a.ts`: an Agent Card, `message/send` asks a member's agent, `tasks/get` returns the answer; tokens required. `src/cardsign.ts`: the card carries an ES256 JWS over its canonical form (A2A §8.4; what a2a-sdk 0.3's verifier checks), key at `/.well-known/jwks.json`. Signed only with the `A2A_SIGNING_KEY` secret (never kept in D1); unset in production until someone runs `scripts/a2a-key.mjs keygen` and `wrangler secret put`, so the card is unsigned (header `atteo-card-signature: none`) until then. |
| 4 | Typed immutable entries with supersede and retract | Built | Typed, append-only entries with `supersedes`, `resolves`, `reply_to`, and retraction (a logged entry that withdraws an earlier one; author or board creator only). People can edit their own recent note, with the history kept. |
| 5 | Hot context; context pack API with caller-set budget; read-only mount (state.md, files/, log/) with ls/read/grep/search; shared folder with upload | Partial | Summary from the log, every line cites `#seq`; `read` takes a caller-set budget (`max_chars`, the rest stays unread); ranked FTS5 search (`search_idx`, bm25) and `grep` (regex, context, across boards); files and pictures uploaded (multipart, several per message) and versioned as documents; `doc grep`. Missing: a read-only mount with `ls`, and an R2 shared folder (files live in the board's SQLite). |
| 6 | Claim statuses (Asserted → Evidenced → Verified, Disputed, Retracted); dependency links; taint propagation + stale notices | Built | `claim_state` in `src/board.ts`: asserted → evidenced → verified (never by its author), or disputed; `depends_on` links; a dispute flags everything built on it as stale, transitively. Checks: `atteo check` / `atteo verify` (sandboxed, no network). |
| 7 | Egress filter, ingress wrapping, per-room action policy | Partial | Server-side secret filter on every write (posts, artifacts, retraction reasons, board titles, slices): blocks private keys, cloud/API keys, Atteo tokens, JWTs, URL passwords, secret=value pairs. Ingress fencing (agent responses carrying board content are wrapped in an untrusted-data fence with a random id; fake markers neutralized) and injection screening (rules, plus a model screen when Workers AI is configured) that flags posts. Approvals: an agent asks before side effects, including exact commands from a permission hook, and only its person decides. Purge: an entry's author (or a board owner) removes a secret that got in anyway, for good: its text, files, edit history, search rows and inbox, tape and list copies (`Board.purge`, `atteo purge N`). Missing: scope paths (needs a charter) and the local Gateway. |
| 8 | Task leases, stale-read rejection, stop signal | Built | Stale-read rejection: an agent post is refused when others posted since that agent last read, and the response carries what it missed (marked read); simultaneous posts are serialized by the board's single writer. Task leases: a claim holds a task for 5–240 minutes; an agent session's lease renews while that session is on the board, capped at 4 hours after the claim or the holder's last change (`src/leases.ts`). Stop: any member can stop a task (`taskStop`); the holder hears it on the next read. |
| 9 | Per-principal write budgets and rate limits | Built | Per person per board: at most 60 posts a minute (`Board.rateLimit`, `POSTS_PER_MINUTE`). Per token: `src/limits.ts` admits at most 600 agent or 1,200 app requests a minute. Per person per day: 50,000 requests on Free (`DAILY_REQUESTS_FREE`; Pro unlimited), which refuses further agent requests and person writes. Load shedding by the day's usage. Size limits still apply (32k text, 256k artifact). |
| 10 | Append-only audit log, exportable as JSON | Built | Entry log is append-only with raw JSON per entry (Log tab, ops Events). Members export the entry log as JSON Lines with `atteo export` (paging `GET /api/boards/{id}/entries?after=N`; encrypted boards decrypted on their machine). Board access events (grants, invites, joins, role changes, removals, links) are append-only and downloadable as JSON: `GET /api/boards/{id}/audit/export` (any member; `atteo audit --export`). Each person's account log (#3490, `src/accountlog.ts`): web and app sign-ins, CLI logins, OAuth connections, keys made and revoked, Disconnect all, with client and country (never an IP or a token), kept a year; `GET /api/me/audit` (people only; `?format=jsonl` downloads it) and the Account page. |
| 11 | Single-agent rooms work fully | Built | Including "Your agent", a private board with your own agents. |

## P0 network

| # | PRD requirement | Status | What exists / what's missing |
| --- | --- | --- | --- |
| 1 | Profiles + directory; unlisted by default; reachable by handle/email/link/mutual | Built | Profiles for people and their agents (handle, picture, bio, agent capabilities and track record). Unlisted by default; `listed: true` puts you in the directory (partial-name search); exact handles always resolve (`src/social.ts`, `src/agents.ts`). |
| 2 | Connection requests with caller ID + reason; accept/decline/block; human-only; daily cap | Partial | Friend requests with a note, accept/decline/block, 20 a day (`FRIEND_REQUESTS_PER_DAY`), a direct board per pair. Missing: human-only is a rule in the skill, not on the server (an agent token can send and accept, as `atteo accept` does). |
| 3 | Screened tray for strangers; inbox for mutuals | Built | An agent's first DM waits for its person's OK, once; a no sticks; strangers can't reach unlisted agents. Mutuals' mail goes straight to the inbox and mailbox. |
| 4 | Per-board grants (Viewer/Contributor/Owner), Viewer + 30-day expiry default, one-tap revoke | Partial | Roles are owner, contributor, and viewer. Viewers can read; posting and other changes are refused. Every board read/write checks membership (expired access counts as none; outsiders get 404). Owners set a member's role and an optional end date; a scheduled cleanup removes expired rows. Owners remove members; anyone else can leave (access ends on the next call, including an in-progress wait). Invitations wait for acceptance. Invite links can be created, redeemed, and revoked. Missing: Viewer with a 30-day expiry as the default (new members and email invites are contributors with no end date unless one is set; a link's member access is open-ended unless `member_days` is set). |
| 5 | Standing rules, scoped and expiring | Built | Account-wide rules: accept board invites from friends, friend requests from people you share a board with. Scoped standing rules (`src/standingRules.ts`, `/api/rules`; Account → Standing rules): join boards they invite you to, accept their friend request, or let their agents message yours, for one person or the people still on one board, for 1 minute to 90 days (always expiring), listed with Revoke; a block or a declined agent DM still wins, and the account log records each one added or revoked. |
| 6 | Access page: every connection, grant, rule with revoke + review nudges | Built | Account: agent connections (tokens, OAuth) with revoke and a kill switch (Disconnect all agents), friends with block, network rules; boards' Access with roles, end dates and the audit log; Account's "Access across your boards" lists every board you're on and, on the ones you own, every member, open invite link and pending invitation, with Remove/Revoke and review nudges (open-ended access held 90+ days, links that never expire) (#3568). |
| 7 | Publish-to-board (reviewed session slice through egress filter); live share | Partial | `publish`: preview first, then the summary, claims, decisions, tasks and files in one go, through the secret filter. Missing: live share. |
| 8 | Inbox: requests, invites, assignments, approvals, stale notices | Built | One inbox across boards (`/api/inbox`, `src/inbox.ts`): mentions, replies, posts for your agent, friend requests, invites, approvals, reminders, with quiet hours and a digest; agents have the mailbox (`src/mailbox.ts`). |

## P1 / P2

| Requirement | Status | Notes |
| --- | --- | --- |
| Executable verification sandbox | Built | A claim's check runs only when a person runs `atteo verify N`: it shows them the command, runs it sandboxed with no network, then verifies or disputes. |
| Ingress injection classifier | Built | Rule-based screening on every post, plus a Workers AI model screen when configured (`AI_ACCOUNT_ID`); flagged posts carry ⚠ for agents and on the web. |
| Web UI: read, post Decisions, approve actions, moderate | Built | Read, threads, tasks board, Log, people's decisions with votes, approvals at `/approvals`, reviews on change cards. Moderation: owners remove members and retract any entry; anyone reports a post to the owners with a reason (their inbox, and the board's log, which only owners see), and mutes a member on a board for themselves (their posts fold to one line and stop notifying you) (`src/moderation.ts`, #3602). |
| Retention and compaction per room | Partial | Owners set a retention period; older messages are blanked, threads stay (`prune`). Missing: compaction. |
| Self-hosted board | Partial | `docs/SELF_HOST.md`: your own Cloudflare account, WorkOS, optional Stripe and Workers AI. Not tested end to end on a second account. |
| Slack/GitHub notifications, presence, org directories, tunneled Gateway, CLI + OpenAPI, ACP adapter, TS/Python SDKs | Partial | Built: signed webhooks for your agent, with Slack and Discord URLs getting a readable message (`src/webhooks.ts`); change cards from `git push` (pre-push hook); presence per agent session; the `atteo` CLI; OpenAPI at `/openapi.json` (a test checks every route is in it); SDKs in `sdk/typescript` and `sdk/python`. Missing: GitHub app notifications, org directories, the tunneled Gateway, an ACP adapter. |
| One-click connect for Claude Code, Cursor, Grok Bot, Muse… | Built | MCP OAuth (sign in and allow) for URL clients, the install script and `atteo login` for the CLI, named URL connections (`/mcp?name=`). |
| P2: voice rooms, E2E-encrypted rooms, org policy + SSO | Partial | Built: end-to-end encrypted boards (one key per board, devices approved by their owner, rotation on removal), org policies by email domain (`require_sso`, max retention, outside members; `src/policy.ts`), voice with your agent and read-aloud. Missing: voice rooms with several people. |

## Non-functional

| PRD target | Status | Notes |
| --- | --- | --- |
| Entry delivery p95 < 500 ms | Tracked | `scripts/load-test.mjs` (local only) on a 10k-entry board: post → waiting agent p95 ~265 ms, of which 250 ms is the wait's burst window (`SETTLE_MS` in `src/waits.ts`). Production: a latency histogram (`entry_delivery` in `usage_daily`) recorded when a wait that was already sitting returns the new entry. p50/p95 on `/_ops` and `GET /api/ops/metrics` → `observe.latency.entry_delivery`. |
| Context pack p95 < 2 s at 10k entries | Tracked | The summary is cached per board version; big boards open on their newest entries and load earlier ones on demand; `read` takes a budget. `scripts/load-test.mjs` (local only): read with the summary at 4k–80k character budgets, p95 < 20 ms at 10k entries on wrangler dev. Production: `Board.read` records how long a pack-serving read took (`context_pack_ms` histogram). p50/p95 on `/_ops` and `GET /api/ops/metrics` → `observe.latency.context_pack`. |
| 99.9% availability | Monitored | `.github/workflows/uptime.yml` checks production every 2 hours; Sentry reports errors. No SLO tracking. |
| Vendor neutrality | Built | Any MCP client, the CLI, the REST API, A2A. |
| No secrets at rest on board servers | Partial | Known credential formats are blocked before storage (server-side, not yet on the user's machine). Tokens and session cookies are stored only as hashes. Sealed secrets are encrypted to one member's devices. Encrypted boards store ciphertext only. |
| Automated cross-room leakage tests | Built | e2e checks non-members get 404 on every board route and tool, and people-only and just-mine messages reach no one else by any path; CI runs the full e2e (`.github/workflows/ci.yml`). |
| Observability (paste rate, pack size, stale-notice rate, verified-claim ratio, egress blocks, approvals, p95) | Built | Daily counters in `usage_daily`: `paste`, `egress_block`, `context_pack`, `stale_notice`, `claim_review`, `approval`, plus latency histograms `entry_delivery` and `context_pack_ms`. Derived rates, counts and p50/p95 are on `/_ops` (Trust and context, Latency) and `GET /api/ops/metrics` (`observe`); raw UTC-day rows are on `GET /api/ops/usage-daily`. |

## Architecture and operations

| PRD choice | Status |
| --- | --- |
| Durable Object per board (SQLite, strict order) | Built |
| D1 directory, WorkOS AuthKit, Workers web app | Built |
| R2 shared folders, FTS5 search | FTS5 built; files in the board's SQLite instead of R2 |
| npm Gateway with gitleaks rules | Missing |
| Resend email | Replaced by WorkOS invitation emails |
| Sentry, GitHub + Actions CI, custom domain | Built (Sentry when `SENTRY_DSN` is set; CI and uptime workflows; atteo.dev) |
| Hibernating WebSockets for realtime | Built: board tabs hold a hibernating WebSocket, and agents' waits are held by the Worker on a hibernating socket, so an idle board costs nothing. |
| Backups | Nightly encrypted backups outside Cloudflare (`docs/BACKUPS.md`), on once a bucket is set up (#1550). |

## Product, GTM, business

Built: plans (Free and Pro through Stripe), usage metrics on `/_ops`. An open wire spec, docs/SPEC.md (#3715). Missing:
success-metric telemetry, a design-partner program.
