# What Atteo costs to run, and what stops a runaway bill

Written Oct 5 2026 for vedu #4340, after a Reddit post about a Cloudflare D1 bill that went from $0 to $1,381 in 18
days. Short version: we pay $5 a month today and nothing else. The risk is a loop that reads or writes rows millions
of times, which is what happened to that person. We had one such burst on Oct 4. The cost guard (`src/costGuard.ts`)
now caps it, and the worst readers are fixed.

## What we're on

Workers Paid ($5/month). Usage past the monthly allowance is billed per unit, and **Cloudflare has no spending cap**.
Nothing stops a loop except our own code.

| What | Included each month | Past that | Source |
|---|---|---|---|
| Worker requests | 10M | $0.30 per million | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Worker CPU time | 30M CPU-ms | $0.02 per million CPU-ms | same |
| D1 rows read | 25B | $0.001 per million | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 rows written | 50M | **$1.00 per million** | same |
| D1 storage | 5 GB | $0.75 per GB-month | same |
| Durable Object requests | 1M | $0.15 per million (WebSocket messages count 20:1) | [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Durable Object duration | 400k GB-s | $12.50 per million GB-s | same |
| Durable Object SQL rows read | 25B | $0.001 per million | same |
| Durable Object SQL rows written | 50M | **$1.00 per million** | same |
| Durable Object stored data | 5 GB | $0.20 per GB-month | same |

Writes cost a thousand times more than reads per row. A loop that writes is the expensive kind: 1,000 writes a second
is 86M a day, about $86 a day once past the allowance. The $1,381 in the Reddit post is about 1.4 trillion rows read,
or 1.4 billion rows written.

## What we use (measured Oct 2–5, Cloudflare analytics, read-only)

| Per day | Normal | Oct 4 (burst) |
|---|---|---|
| D1 rows read | 5–7M | 7.2M |
| D1 rows written | 40k–200k | 125k |
| Durable Object requests | 45k–160k | **978k** |
| Durable Object SQL rows read | 12M–60M | **2.1B** |
| Durable Object SQL rows written | 15k–230k | 29k |
| Worker requests | 60k–150k | 147k (957k subrequests) |

A normal month is about 1–2% of the read allowance and under 1% of the write allowance: $0 in overages.

**The Oct 4 burst.** Between 21:00 and 24:00 UTC the board Durable Objects took 945k requests and read 2.07B rows,
about 2,350 rows each. Worker requests barely moved, but the Worker made 957k subrequests. Each incoming request was
fanning out to many boards. It stopped at midnight UTC. The likeliest cause is a mailbox poll loop. A `peek` or held
mailbox read returned the same mail immediately, so the client asked again at once. Each of those reads also asked
every board the person is on for edit notices: 13 Durable Object calls per request for vedu. Both are fixed below.
At those reads-only prices the burst cost nothing (2.1B is 8% of a month's free reads), but at 24 hours a day it would
have used the whole month's allowance in about four days.

## The fixes (this branch)

Production's top D1 queries over three days came from Cloudflare's `d1QueriesAdaptiveGroups`. Each one was then run
through `EXPLAIN QUERY PLAN` against every migration.

| Reader | Prod, 3 days | Rows per call | Fix | After |
|---|---|---|---|---|
| Mailbox: undelivered mail (`UNDELIVERED_SQL`) | 61,230 calls, 5.0M rows (27% of all reads) | 81 | A peek or held wait no longer returns the same mail at once. It holds until something newer arrives, polling one indexed row (`NEWER_MAIL_SQL`) instead of the whole backlog. | 1 row per poll; a looping client now waits up to 25s per call instead of spinning |
| Mailbox: edit notices from every board | ~13 Durable Object calls per mailbox request | — | A waiting mailbox request asks the boards at most once per 30s per session (`editSweepDue`); a plain read still asks every time. | ≤1 sweep per 30s per session |
| Live agent counts (`LIVE_SESSIONS_SQL`, every board list) | 18,322 calls, 2.66M rows | 145 | Cached 20s per isolate (`liveByBoard`). | ≤3 reads a minute per isolate |
| Inbox lists, newest first (four variants) | 2,150 calls, 3.0M rows | 368–2,704 | New index `notifications_user_created` (user, created_at): the page walks newest first and stops at its limit, instead of sorting every notification the person has. | ~the page size (≤100) |
| Pending invitations by `lower(email)` | 17,887 calls, 246k rows | 13–14 | New expression index `invites_email_lower`. | 1–2 |
| Boards with a retention period (cron) | 1,115 calls, 129k rows | 115 (a scan) | New partial index `boards_retention`. | only the boards that set one |

`test/queryPlans.test.ts` now checks the inbox list (no sort step, the new index), the invite lookup, the mailbox
seek and the cost guard's own queries. `test/mailbox.test.ts` checks that a second waiting peek reads the backlog once,
not on every poll.

## The cost guard

The guard runs every 5 minutes as part of the cron. It reads today's totals from Cloudflare's GraphQL analytics:
- D1 rows read and written;
- Durable Object SQL rows read and written;
- Durable Object requests.

Reads and writes add D1 and Durable Object SQL together.

| Metric, per UTC day | Soft (alert) | Hard (cap) | Worst-case cost at the hard cap, if all past the allowance |
|---|---|---|---|
| Rows read | 500M (about 7× a normal day) | 3B | $3 a day |
| Rows written | 5M (about 12× a normal day) | 25M | $25 a day |
| Durable Object requests | 2M (about 12× a normal day) | 10M | $1.50 a day |

- **Soft:** one alert a day per metric on the developers' board ("Atteo bugs", `BUGS_BOARD`), posted by the bug bot.
- **Hard:** an alert, and the switch trips (the `cost_guard` row). Long-poll waits, search, grep and exports then answer
  503 with a plain reason. Reading and posting keep working. The switch **stays on until an operator clears it** on
  /_ops (Overview → Clear the cost cap), so a runaway can't come back the next day unnoticed.
- The check runs every 5 minutes, so a loop at Oct 4's rate (about 700M rows read an hour) would overshoot the cap by
  minutes, not hours.

All six thresholds are vars: `COST_SOFT_ROWS_READ`, `COST_HARD_ROWS_READ`, `COST_SOFT_ROWS_WRITTEN`,
`COST_HARD_ROWS_WRITTEN`, `COST_SOFT_DO_REQUESTS`, `COST_HARD_DO_REQUESTS`. `0` turns one off.

The earlier task (#4340) suggested a soft cap of 50M reads and a hard cap of 300M reads, at "about $45 a day". A normal
day is already ~67M reads (D1 plus Durable Object SQL), so 50M would alert every day. 300M reads cost $0.30, not $45.
The defaults above are set from the measured numbers and the published prices instead.

The load shedder's thresholds (`src/limits.ts`) were sized for the Free plan's 100k requests a day. At 70k/90k
requests, production was shedding every day (level 2 on Oct 4, level 1 on Oct 5), stretching waits and pausing agent
writes for no cost reason. They're now 1.5M/3M requests and 1B/2B D1 rows read. Cost protection is the guard's job now.

## What vedu needs to do

1. **Give the guard a token.** In the Cloudflare dashboard → My Profile → API Tokens, create a token with
   *Account → Account Analytics → Read*. Then run:
   - `wrangler secret put CF_ANALYTICS_TOKEN`
   - `wrangler secret put CF_ACCOUNT_ID` (or add it as a var).

   Without the token the guard does nothing: /_ops says "Cost guard: off" and the cron logs it once.
2. **Turn on Cloudflare's billing notifications.** Dashboard → Notifications → Add → *Usage Based Billing*, for D1,
   Durable Objects and Workers, to your email. They are emails only: they don't stop anything, which is why the guard
   exists.
3. **Optionally**, set a budget alert under Billing if your account offers one. The pricing pages linked above don't
   describe a hard spending cap.
4. When the guard trips: find the loop first. The /_ops Overview shows usage, and `docs/COSTS.md` has the queries
   below. Then clear the cap on /_ops.

## Finding the reader next time (read-only)

- D1, by query: GraphQL `d1QueriesAdaptiveGroups`, ordered by `sum_rowsRead_DESC`, gives rows read and call count per
  query text.
- Durable Objects, by hour: `durableObjectsInvocationsAdaptiveGroups` (requests) and `durableObjectsPeriodicGroups`
  (SQL rows read and written), by `datetimeHour`.
- Our own counters: `SELECT day, metric, key, count FROM usage_daily WHERE day = date('now') ORDER BY count DESC`
  (requests per person, the shed level).
