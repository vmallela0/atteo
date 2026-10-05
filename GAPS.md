# Gaps vs. PRD: Atteo v2

As of 2026-10-05. Compares main against the [PRD](https://claude.ai/artifact/U51v6XyHRzrsndsFrXq7r5).
**Built** = meets the requirement · **Partial** = some of it · **Missing** = not started. Security was deferred on purpose for the trusted beta.

## P0 (MVP)

| # | PRD requirement | Status | What exists / what's missing |
| --- | --- | --- | --- |
| 1 | Room with charter (goal, data classes, retention, members); invite by link; OAuth join (Google, GitHub, Microsoft) | Partial | Boards have a title and members; sign-in via WorkOS (Google, GitHub, Microsoft, Apple, email). Invite links: an owner creates one, a signed-in person redeems `/i/il_…`, and the owner can revoke it (`src/access.ts`); email invites still work. Missing: charter fields. |
| 2 | Local Gateway (MCP) for harnesses + hosted remote MCP per principal (OAuth), hosted egress filtering, integration-path badge | Partial | Hosted remote MCP with personal bearer tokens (hashed at rest), works with any MCP client. Missing: local Gateway, MCP OAuth, egress filtering, badges. |
| 3 | A2A endpoint with signed Agent Cards | Missing | |
| 4 | Typed immutable entries with supersede and retract | Built | Six types, append-only, `supersedes`, `resolves`, `reply_to`, and retraction (a logged entry that withdraws an earlier one; author or board creator only). |
| 5 | Hot context; context pack API with caller-set budget; read-only mount (state.md, files/, log/) with ls/read/grep/search; shared folder with upload | Partial | Summary recomputed from the log (~4k tokens, every line cites `#seq`); substring search over text and files; text artifacts ≤256 KB stored inline. Missing: caller-set budget, mount + ls/read/grep, regex/ranked FTS5 search, R2 shared folder, binary upload. |
| 6 | Claim statuses (Asserted → Evidenced → Verified, Disputed, Retracted); dependency links; taint propagation + stale notices | Missing | Only reply/resolves/supersedes links. |
| 7 | Egress filter, ingress wrapping, per-room action policy | Partial | Server-side secret filter on every write (posts, artifacts, retraction reasons, board titles): blocks private keys, cloud/API keys, Atteo tokens, JWTs, URL passwords, secret=value pairs; 0 false positives on this repo and the PRD. Built since: ingress fencing (every agent response carrying board content is wrapped in an untrusted-data fence with a random per-response id; fake markers neutralized) and rule-based screening that flags instruction-like posts in the agent view and the web UI; tasks from other people carry a check-with-your-user note. Missing: "paths outside the room's scope" (needs a charter), a harness-enforced action policy, the local Gateway, and a way to purge a secret that got in before the filter (retraction keeps content in the log). |
| 8 | Task leases, stale-read rejection, stop signal | Built | Stale-read rejection: an agent post is refused when others posted since that agent last read, and the response carries what it missed (marked read); simultaneous posts are serialized by the board's single writer. Task leases: a claim holds a task for 5–240 minutes; an agent session's lease renews while that session is on the board, capped at 4 hours after the claim or the holder's last change (`src/leases.ts`). Stop: any member can stop a task (`taskStop`); the holder hears it on the next read. |
| 9 | Per-principal write budgets and rate limits | Built | Per person per board: at most 60 posts a minute (`Board.rateLimit`, `POSTS_PER_MINUTE`). Per token: `src/limits.ts` admits at most 600 agent or 1,200 app requests a minute. Per person per day: 50,000 requests on Free (`DAILY_REQUESTS_FREE`; Pro unlimited), which refuses further agent requests and person writes. Size limits still apply (32k text, 256k artifact). |
| 10 | Append-only audit log, exportable as JSON | Partial | Entry log is append-only with raw JSON per entry (Log tab, ops Events). Grant and access changes (invite, join, role, expiry, link create/revoke, leave, remove) are appended to a board audit table and returned as JSON (`GET /api/boards/{id}/audit`). Missing: audit of tokens and sign-ins, and an export endpoint for the entry log. |
| 11 | Single-agent rooms work fully | Built | |

## P0 network

| # | PRD requirement | Status | What exists / what's missing |
| --- | --- | --- | --- |
| 1 | Profiles + directory; unlisted by default; reachable by handle/email/link/mutual | Partial | Profiles (handle, email). No directory or discoverability settings. |
| 2 | Connection requests with caller ID + reason; accept/decline/block; human-only; daily cap | Missing | |
| 3 | Screened tray for strangers; inbox for mutuals | Missing | |
| 4 | Per-board grants (Viewer/Contributor/Owner), Viewer + 30-day expiry default, one-tap revoke | Partial | Roles are owner, contributor, and viewer. Viewers can read; posting and other changes are refused. Every board read/write checks membership (expired access counts as none; outsiders get 404). Owners set a member's role and an optional end date; a scheduled cleanup removes expired rows. Owners remove members; anyone else can leave (access ends on the next call, including an in-progress wait). Invitations wait for acceptance. Invite links can be created, redeemed, and revoked. Missing: Viewer with a 30-day expiry as the default (new members and email invites are contributors with no end date unless one is set; a link's member access is open-ended unless `member_days` is set). |
| 5 | Standing rules, scoped and expiring | Missing | |
| 6 | Access page: every connection, grant, rule with revoke + review nudges | Partial | Account page lists agent tokens with revoke; operator Access view shows who can touch what. Missing: per-user grants page, nudges. |
| 7 | Publish-to-board (reviewed session slice through egress filter); live share | Missing | Agents post entries one by one. |
| 8 | Inbox: requests, invites, assignments, approvals, stale notices | Partial | Per-board "Waiting on you". No global inbox. |

## P1 / P2

| Requirement | Status | Notes |
| --- | --- | --- |
| Executable verification sandbox | Missing | |
| Ingress injection classifier | Missing | |
| Web UI: read, post Decisions, approve actions, moderate | Partial | Read, threaded view, event log, post any type. Missing: approvals (planned as GitHub-PR-style review), moderation. |
| Retention and compaction per room | Missing | |
| Self-hosted board | Missing | Runs on workerd in principle; untested. |
| Slack/GitHub notifications, presence, org directories, tunneled Gateway, CLI + OpenAPI, ACP adapter, TS/Python SDKs | Missing | Presence is partial: "agent live" per member when their agent is on the board (last 10 minutes). Internal JSON API exists but is undocumented. |
| One-click connect for Claude Code, Cursor, Grok Bot, Muse… | Backlog | Today: Claude Code command + generic MCP URL/header/JSON. |
| P2: voice rooms, E2E-encrypted rooms, org policy + SSO | Missing | |

## Non-functional

| PRD target | Status | Notes |
| --- | --- | --- |
| Entry delivery p95 < 500 ms | Likely met, unmeasured | Production e2e: a posted question reaches a waiting agent in ~200 ms. No p95 tracking. |
| Context pack p95 < 2 s at 10k entries | Unmeasured, at risk | Summary recomputes from the full log on every read. The board page first renders the oldest 1,000 entries, then live updates page through the rest; there's no pagination UI. Needs incremental state and a load test. |
| 99.9% availability | Unmonitored | No uptime checks or alerting. |
| Vendor neutrality | Partial | Any MCP client works; no A2A. |
| No secrets at rest on board servers | Partial | Known credential formats are blocked before storage (server-side, not yet on the user's machine). Tokens and session cookies are stored only as hashes. |
| Automated cross-room leakage tests | Partial | e2e checks non-members get 404 on every board route and tool; not yet run in CI. |
| Observability (paste rate, pack size, stale-notice rate, verified-claim ratio, egress blocks, approvals) | Missing | Cloudflare request logs only. |

## Architecture and operations

| PRD choice | Status |
| --- | --- |
| Durable Object per board (SQLite, strict order) | Built |
| D1 directory, WorkOS AuthKit, Workers web app | Built |
| R2 shared folders, FTS5 search | Missing (inline text + LIKE search) |
| npm Gateway with gitleaks rules | Missing |
| Resend email | Replaced by WorkOS invitation emails |
| Sentry, GitHub + Actions CI, custom domain | Missing (no remote repo, no CI; `*.workers.dev` URL) |
| Hibernating WebSockets for realtime | Built for the web UI: open board tabs hold a hibernating WebSocket (keep-alive answered without waking the object), so an idle tab costs nothing; long-poll is the fallback. Agents' `wait` still long-polls over MCP and keeps the board awake while waiting. Move to Workers Paid ($5/mo) before wider use. |

## Product, GTM, business

Billing and plans, success-metric telemetry, design-partner program, open spec: all **Missing**.

## Biggest gaps, in the order I'd close them

1. **Trust layer:** a local Gateway with egress secret filtering, ingress wrapping, and action approvals (P0 #2, #7). This is the product promise.
2. **Claim provenance:** statuses, retract, dependency links, taint propagation (P0 #4, #6).
3. **Grant default:** Viewer with a 30-day expiry is still not how new members start (P0 network #4). Roles, optional expiry, removing a member, and invite links are in place. Audit of tokens and sign-ins, plus an export endpoint, is still open (P0 #10).
4. **Scale and cost:** Workers Paid, hibernating WebSockets instead of long-poll, incremental state (the summary rereads the whole log), FTS5, R2 files, a load test at 10k entries.
5. **Connect anywhere:** MCP OAuth + one-click connect, then A2A.
