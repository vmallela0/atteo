// Guardrails, first sized for Cloudflare's Free plan (INFRA-ASSESSMENT §4i; the D1 read cap hit on #1495/#1516) and
// re-sized for Workers Paid on Oct 5 (#4340: at 70k/90k requests prod was shedding every day; cost limits now live in
// costGuard.ts, docs/COSTS.md has the math): a per-token rate
// limit, a per-person daily budget, one open wait per agent session, and load-shedding levels the cron sets.
//
// None of it reads or writes D1 per request. Per-token rate limits are an in-memory sliding window in this isolate,
// and in production also the AGENT_TOKENS / APP_TOKENS Rate Limiting bindings (shared across isolates at one location).
// Daily counts accumulate per isolate
// and are flushed into usage_daily (day, 'requests', user) in batches (every FLUSH_EVERY requests or FLUSH_MS, one
// upsert that returns the global total). The plan is looked up only once someone is over the Free budget (cached).
// The shed level lives in usage_daily (day, 'shed', 'level'), read at most once a minute per isolate.
// Every number is an env var (vedu decides them); see Limits for the names and defaults.

import { planOf } from "./billing";
import { analyticsToken, capped, cappedResponse } from "./costGuard";
import type { Env } from "./types";

export interface Limits {
  agentPerMin: number; // RATE_AGENT_PER_MIN: requests per minute per agent token (default 600)
  appPerMin: number; // RATE_APP_PER_MIN: per app/person token (default 1200)
  dailyFree: number; // DAILY_REQUESTS_FREE: a person's non-wait requests per UTC day on Free (default 50,000)
  dailyPro: number; // DAILY_REQUESTS_PRO: same on Pro (default 0 = unlimited)
  liveSessions: number; // MAX_LIVE_SESSIONS: live agent sessions per person (default 25; 0 = no cap)
  shedL1Requests: number; // SHED_L1_REQUESTS: Worker requests today (our own count) that start shedding (default 1,500,000; Workers Paid)
  shedL2Requests: number; // SHED_L2_REQUESTS: … that refuse non-essential agent writes (default 3,000,000)
  shedL1RowsRead: number; // SHED_L1_D1_ROWS_READ: D1 rows read today (Cloudflare analytics) for level 1 (default 1,000,000,000)
  shedL2RowsRead: number; // SHED_L2_D1_ROWS_READ: … for level 2 (default 2,000,000,000)
}

const num = (v: string | undefined, d: number) => {
  if (v == null || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

// Test/ops overrides for this isolate (POST /api/ops/limits). wrangler dev runs one isolate, so e2e can lower a limit.
let overrides: Partial<Limits> = {};

/**
 * A local dev/test server (PUBLIC_URL on localhost, as .dev.vars and CI set it) runs suite after suite all day with the
 * same users, so the production defaults would throttle the tests themselves (jxn #1616: emoji-sync's writes 429'd).
 * There the defaults are effectively off; env vars and ops overrides still set real limits (the limits e2e does that).
 * LIMITS_LOCAL=1 keeps the production defaults locally.
 */
const OFF = 1e12;
function isLocalServer(env: Env): boolean {
  if (env.LIMITS_LOCAL === "1") return false;
  try { return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(String(env.PUBLIC_URL ?? "")).hostname); } catch { return false; }
}

export function limits(env: Env): Limits {
  const local = isLocalServer(env);
  const d = (prod: number) => (local ? OFF : prod);
  return {
    agentPerMin: num(env.RATE_AGENT_PER_MIN, d(600)),
    appPerMin: num(env.RATE_APP_PER_MIN, d(1200)),
    dailyFree: num(env.DAILY_REQUESTS_FREE, d(50_000)),
    dailyPro: num(env.DAILY_REQUESTS_PRO, 0),
    liveSessions: num(env.MAX_LIVE_SESSIONS, d(25)),
    shedL1Requests: num(env.SHED_L1_REQUESTS, d(1_500_000)),
    shedL2Requests: num(env.SHED_L2_REQUESTS, d(3_000_000)),
    shedL1RowsRead: num(env.SHED_L1_D1_ROWS_READ, d(1_000_000_000)),
    shedL2RowsRead: num(env.SHED_L2_D1_ROWS_READ, d(2_000_000_000)),
    ...overrides,
  };
}

const LIMIT_KEYS: (keyof Limits)[] = ["agentPerMin", "appPerMin", "dailyFree", "dailyPro", "liveSessions", "shedL1Requests", "shedL2Requests", "shedL1RowsRead", "shedL2RowsRead"];

/** True when DEV_FAKE_NEAR_QUOTA=1 on a localhost server (tests fake load-shedding level 1). */
/**
 * Signed-out endpoints that write a row or wake a board on every call (POST /oauth/register, POST /api/device/start,
 * /health/deep; vedu #4598) get a per-IP cap from the Workers Rate Limiting binding: no D1 read or write per request,
 * counted per Cloudflare location. Off on a local dev/test server and when the binding is missing; a limiter error
 * lets the request through (availability over a counter).
 */
export async function publicAllowed(env: Env, what: string, request: Request): Promise<boolean> {
  if (!env.PUBLIC_WRITES || isLocalServer(env)) return true;
  // Through the atteo.dev proxy (another account's Worker, stamped CF-Worker) every visitor arrives from the proxy's
  // address, so a per-IP count would make them all share one budget. Those go uncounted until the Worker has its own
  // custom domain (docs/CLOUDFLARE_HARDENING.md); direct workers.dev callers (the app, CLIs, scripts) are counted.
  if (request.headers.has("cf-worker")) return true;
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  try {
    return (await env.PUBLIC_WRITES.limit({ key: `${what}:${ip}` })).success;
  } catch {
    return true;
  }
}

export function nearQuotaAllowed(env: Env): boolean {
  return env.DEV_FAKE_NEAR_QUOTA === "1" && isLocalServer(env);
}

let nearQuotaFake = false;
export const nearQuotaActive = () => nearQuotaFake;

/** Turn on/off the near-quota fake (ops/limits {nearQuota: true} when DEV_FAKE_NEAR_QUOTA=1). */
export function setNearQuota(env: Env, on: boolean): boolean {
  if (on && !nearQuotaAllowed(env)) return false;
  nearQuotaFake = on;
  if (on) shedCache = { level: 1, at: Date.now(), day: day() };
  return true;
}

/** Sets (or with reset, clears) this isolate's overrides and counters. Tests and operators only. */
export function setOverrides(o: Record<string, unknown>, reset = false): Partial<Limits> {
  if (reset) {
    overrides = {};
    windows.clear();
    counters.clear();
    plans.clear();
    openWaits.clear();
    nearQuotaFake = false;
    shedCache = null;
  }
  for (const k of LIMIT_KEYS) {
    const v = Number(o[k]);
    if (o[k] != null && Number.isFinite(v) && v >= 0) overrides[k] = v;
  }
  return overrides;
}

export const day = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
/** Seconds until 00:00 UTC, when daily budgets (and Cloudflare's daily caps) reset. */
export const secondsToMidnight = (now = Date.now()) => Math.max(1, Math.ceil((Date.parse(day(now) + "T00:00:00Z") + 86_400_000 - now) / 1000));

// ---------- per-token rate limit: in-memory sliding window, plus the Rate Limiting binding in production ----------

const WINDOW_MS = 60_000;
const windows = new Map<string, { start: number; cur: number; prev: number }>();
/** The binding's `simple.period` is 60s; it does not return a remaining-window hint. */
const BINDING_RETRY_AFTER = 60;

/** Counts one request (or `n`: an MCP batch's calls) for `key`; ok, or how many seconds until it would be. Per isolate. */
export function rateCheck(key: string, perMin: number, now = Date.now(), n = 1): { ok: true } | { ok: false; retryAfter: number } {
  if (!perMin) return { ok: true };
  const start = now - (now % WINDOW_MS);
  let w = windows.get(key);
  if (!w || start - w.start >= 2 * WINDOW_MS) w = { start, cur: 0, prev: 0 };
  else if (start !== w.start) w = { start, cur: 0, prev: w.cur };
  // The previous minute counts for the part of it still inside the last 60s.
  const est = w.prev * (1 - (now - start) / WINDOW_MS) + w.cur;
  if (est + n - 1 >= perMin) {
    windows.set(key, w);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((start + WINDOW_MS - now) / 1000)) };
  }
  w.cur += n;
  if (windows.size > 10_000) windows.clear();
  windows.set(key, w);
  return { ok: true };
}

/**
 * In-memory `rateCheck` always (local, tests, ops overrides, MCP batch `n`). When AGENT_TOKENS / APP_TOKENS is bound
 * and this isn't a local server, also ask the Workers Rate Limiting binding so the same token is capped across isolates
 * at one location (wrangler.jsonc: 600 agent / 1200 app per minute). Binding errors fail open like `publicAllowed`
 * (the in-memory check still applies). `perMin` 0 stays unlimited and does not call the binding. Daily Free/Pro budgets
 * are a separate gate in `admit`.
 */
export async function rateAllowed(
  env: Env,
  kind: "agent" | "person",
  key: string,
  perMin: number,
  now = Date.now(),
  n = 1,
): Promise<{ ok: true } | { ok: false; retryAfter: number }> {
  const mem = rateCheck(key, perMin, now, n);
  if (!mem.ok || !perMin || isLocalServer(env)) return mem;
  const binding = kind === "agent" ? env.AGENT_TOKENS : env.APP_TOKENS;
  if (!binding) return mem;
  try {
    const count = Math.max(1, n);
    for (let i = 0; i < count; i++) {
      if (!(await binding.limit({ key })).success) return { ok: false, retryAfter: BINDING_RETRY_AFTER };
    }
    return mem;
  } catch {
    return mem;
  }
}

// ---------- daily counts: batched into usage_daily, never one write per request ----------

const FLUSH_EVERY = 100;
const FLUSH_MS = 5 * 60_000;
type Counter = { day: string; pending: number; base: number; lastFlush: number; inflight: Promise<void> | null };
const counters = new Map<string, Counter>(); // `${metric}\n${key}`

export const BUMP_SQL = `INSERT INTO usage_daily (day, metric, key, count) VALUES (?, ?, ?, ?) ON CONFLICT(day, metric, key) DO UPDATE SET count = count + excluded.count RETURNING count`;

function counter(metric: string, key: string, now: number): Counter {
  const k = `${metric}\n${key}`;
  const d = day(now);
  let c = counters.get(k);
  if (!c || c.day !== d) {
    c = { day: d, pending: 0, base: 0, lastFlush: now, inflight: null };
    if (counters.size > 20_000) counters.clear();
    counters.set(k, c);
  }
  return c;
}

function flush(env: Env, metric: string, key: string, c: Counter, now: number): Promise<void> {
  if (c.inflight || !c.pending) return c.inflight ?? Promise.resolve();
  const n = c.pending;
  c.pending = 0;
  c.lastFlush = now;
  c.inflight = env.DB.prepare(BUMP_SQL)
    .bind(c.day, metric, key.slice(0, 80), n)
    .first<{ count: number }>()
    .then((r) => {
      if (r) c.base = Math.max(c.base, r.count); // everyone's total so far (what's pending here comes on top)
    })
    .catch(() => {
      c.pending += n; // try again with the next flush
    })
    .finally(() => {
      c.inflight = null;
    });
  return c.inflight;
}

/** Counts `n` events; flushes in the background when due. Returns the estimated total for today (all isolates). */
export function bump(env: Env, ctx: ExecutionContext | null, metric: string, key: string, n = 1, now = Date.now()): number {
  const c = counter(metric, key, now);
  c.pending += n;
  if (c.pending >= FLUSH_EVERY || now - c.lastFlush >= FLUSH_MS) {
    const p = flush(env, metric, key, c, now);
    if (ctx) ctx.waitUntil(p);
  }
  return c.base + c.pending;
}

function estimate(metric: string, key: string, now = Date.now()): number {
  const c = counter(metric, key, now);
  return c.base + c.pending;
}

function unbump(metric: string, key: string, now = Date.now(), n = 1) {
  const c = counter(metric, key, now);
  c.pending = Math.max(0, c.pending - n);
}

/** Flushes everything this isolate is holding (the cron, before it reads the totals). */
export async function flushAll(env: Env, now = Date.now()): Promise<void> {
  await Promise.all(
    [...counters.entries()].map(([k, c]) => {
      const [metric, key] = k.split("\n");
      return flush(env, metric, key, c, now);
    }),
  );
}

// ---------- the plan, only looked up once someone is past the Free budget ----------

const PLAN_MS = 10 * 60_000;
const plans = new Map<string, { pro: boolean; at: number }>();

async function isPro(env: Env, user: string, now: number): Promise<boolean> {
  const hit = plans.get(user);
  if (hit && now - hit.at < PLAN_MS) return hit.pro;
  const pro = (await planOf(env, user).catch(() => null))?.plan === "pro";
  if (plans.size > 5000) plans.clear();
  plans.set(user, { pro, at: now });
  return pro;
}

// ---------- load shedding: 0 normal, 1 stretch waits and pause background work, 2 also refuse non-essential agent writes ----------

const SHED_MS = 60_000;
let shedCache: { level: number; at: number; day: string } | null = null;
export const SHED_GET_SQL = `SELECT count FROM usage_daily WHERE day = ? AND metric = 'shed' AND key = 'level'`;
export const SHED_SET_SQL = `INSERT INTO usage_daily (day, metric, key, count) VALUES (?, 'shed', 'level', ?) ON CONFLICT(day, metric, key) DO UPDATE SET count = excluded.count`;
export const REQUESTS_TODAY_SQL = `SELECT SUM(count) AS n FROM usage_daily WHERE day = ? AND metric = 'requests_all'`;

/** Today's shed level (0–2): from this isolate's cache, else one primary-key read (at most once a minute). */
export async function shedLevel(env: Env, now = Date.now()): Promise<number> {
  const d = day(now);
  if (nearQuotaFake) {
    shedCache = { level: 1, at: now, day: d };
    return 1;
  }
  if (shedCache && shedCache.day === d && now - shedCache.at < SHED_MS) return shedCache.level;
  const prev = shedCache?.day === d ? shedCache.level : 0;
  shedCache = { level: prev, at: now, day: d }; // concurrent callers use this meanwhile
  try {
    const r = await env.DB.prepare(SHED_GET_SQL).bind(d).first<{ count: number }>();
    shedCache = { level: clampLevel(r?.count ?? 0), at: now, day: d };
  } catch {}
  return shedCache.level;
}

/** The level we've already loaded, without reading anything (0 if unknown). */
export const shedLevelNow = (now = Date.now()) => (shedCache && shedCache.day === day(now) ? shedCache.level : 0);

const clampLevel = (n: number) => Math.max(0, Math.min(2, Math.floor(Number(n) || 0)));

export async function setShedLevel(env: Env, level: number, now = Date.now()): Promise<number> {
  const l = clampLevel(level);
  await env.DB.prepare(SHED_SET_SQL).bind(day(now), l).run();
  shedCache = { level: l, at: now, day: day(now) };
  return l;
}

/** The level today's usage calls for: the worse of Worker requests (ours) and D1 rows read (Cloudflare's, when known). */
export function shedLevelFor(t: { requests: number; rowsRead?: number | null }, lim: Pick<Limits, "shedL1Requests" | "shedL2Requests" | "shedL1RowsRead" | "shedL2RowsRead">): number {
  const at = (v: number | null | undefined, l1: number, l2: number) => (v == null ? 0 : l2 && v >= l2 ? 2 : l1 && v >= l1 ? 1 : 0);
  return Math.max(at(t.requests, lim.shedL1Requests, lim.shedL2Requests), at(t.rowsRead, lim.shedL1RowsRead, lim.shedL2RowsRead));
}

/** D1 rows read today across the account, from Cloudflare's GraphQL analytics (needs CF_ACCOUNT_ID + an analytics token). */
async function d1RowsReadToday(env: Env, now: number): Promise<number | null> {
  const token = analyticsToken(env); // the cost guard's CF_ANALYTICS_TOKEN, or CF_API_TOKEN
  if (!env.CF_ACCOUNT_ID || !token) return null;
  try {
    const d = day(now);
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: `query($a: String!, $d: Date!) { viewer { accounts(filter: {accountTag: $a}) { d1AnalyticsAdaptiveGroups(limit: 100, filter: {date_geq: $d, date_leq: $d}) { sum { rowsRead } } } } }`,
        variables: { a: env.CF_ACCOUNT_ID, d },
      }),
      signal: AbortSignal.timeout(5000),
    });
    const j = (await r.json()) as { data?: { viewer?: { accounts?: { d1AnalyticsAdaptiveGroups?: { sum?: { rowsRead?: number } }[] }[] } } };
    const groups = j.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
    return groups ? groups.reduce((n, g) => n + (g.sum?.rowsRead ?? 0), 0) : null;
  } catch {
    return null;
  }
}

/** The cron: flush, read today's totals (one small indexed read), and store the level they call for. */
export async function updateShedLevel(env: Env, now = Date.now()): Promise<{ level: number; requests: number; rows_read: number | null }> {
  await flushAll(env, now);
  const [req, rowsRead] = await Promise.all([env.DB.prepare(REQUESTS_TODAY_SQL).bind(day(now)).first<{ n: number | null }>().catch(() => null), d1RowsReadToday(env, now)]);
  const requests = req?.n ?? 0;
  const level = nearQuotaFake ? 1 : shedLevelFor({ requests, rowsRead }, limits(env));
  await setShedLevel(env, level, now).catch(() => {});
  return { level, requests, rows_read: rowsRead };
}

/** How long a long-poll may hold at this level: the client's ask, stretched (up to `max`) once shedding. */
export const stretchWait = (askedMs: number, max: number, level = shedLevelNow()) => (level >= 1 && askedMs > 0 ? Math.max(askedMs, Math.min(max, askedMs * 2)) : askedMs);
/** A hint for polling clients: wait this long before asking again (0 = right away). */
export const pollAfterMs = (level = shedLevelNow()) => (level >= 2 ? 15_000 : level >= 1 ? 5_000 : 0);

// ---------- which requests are waits, and which agent writes are essential ----------

/** REST long-polls and the board socket: limited by concurrency (one per session), not counted in the budget. */
export function isWaitRequest(method: string, path: string, url: URL): boolean {
  if (method !== "GET") return false;
  if (/^\/api\/sessions\/[^/]+\/wait$/.test(path) || /^\/api\/boards\/[^/]+\/ws$/.test(path)) return true;
  const w = parseInt(url.searchParams.get("wait") ?? "0", 10);
  return w > 0 && (path === "/api/mailbox" || path === "/api/tape" || /^\/api\/approvals\/[^/]+$/.test(path) || /^\/api\/boards\/[^/]+\/(updates|entries)$/.test(path));
}

/** MCP calls that only wait: wait, mailbox with wait_seconds, approval {action: wait}. */
export function isMcpWait(call: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | null): boolean {
  if (call?.method !== "tools/call") return false;
  const name = call.params?.name;
  const a = call.params?.arguments ?? {};
  return name === "wait" || (name === "mailbox" && Number(a.wait_seconds) > 0) || (name === "approval" && a.action === "wait");
}

// Agent writes that keep work moving, even at level 2: posting and answering, tasks, claims, approvals, sessions, mail.
const ESSENTIAL_REST = /^\/api\/(boards\/[^/]+\/(entries|tasks|claims|approvals)(\/.*)?|approvals(\/.*)?|sessions(\/.*)?|mailbox\/ack|dm\/[^/]+|direct\/[^/]+|forward)$/;
const ESSENTIAL_MCP = new Set(["post", "request_approval", "approval", "task", "claim", "review", "retract", "purge", "session", "join_board", "mailbox"]);
export const isEssentialRest = (path: string) => ESSENTIAL_REST.test(path) && !/\/react$/.test(path); // reactions can wait
export const isEssentialMcp = (tool: string | undefined) => !!tool && ESSENTIAL_MCP.has(tool);

// ---------- the gate ----------

export interface Admit {
  user: string;
  kind: "agent" | "person"; // an agent's token, or the person (web session, app token)
  tokenKey?: string | null; // a token's hash: rate-limited per token (web sessions aren't)
  wait: boolean; // a long-poll: not counted in the budget (one per session instead)
  write: boolean; // changes something
  essential: boolean; // for an agent write: still allowed at shed level 2
  calls?: number; // how many calls this is for the rate limit (an MCP batch: its inner calls); default 1
  counted?: number; // how many of them count in the daily budget; default 0 for a wait, else 1
  heavy?: boolean; // can read a lot per call (search, grep, exports): refused, like waits, while the cost cap is on
}

const err = (status: number, error: string, retryAfter: number, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ error, retry_after: retryAfter, ...extra }), { status, headers: { "content-type": "application/json", "retry-after": String(retryAfter), "cache-control": "no-store" } });

/** null: go ahead. Otherwise the 429/503 to send. No D1 in the usual case (see the top of this file). */
export async function admit(env: Env, ctx: ExecutionContext | null, a: Admit, now = Date.now()): Promise<Response | null> {
  const lim = limits(env);
  if (a.tokenKey) {
    const per = a.kind === "agent" ? lim.agentPerMin : lim.appPerMin;
    const r = await rateAllowed(env, a.kind, a.tokenKey, per, now, Math.max(1, a.calls ?? 1));
    if (!r.ok) return err(429, `Rate limit: at most ${per} requests a minute per ${a.kind === "agent" ? "agent" : "app"} token. Slow down and retry after ${r.retryAfter}s.`, r.retryAfter, { limit: per, scope: "token" });
  }
  const n = Math.max(0, a.counted ?? (a.wait ? 0 : 1));
  const est = n ? bump(env, ctx, "requests", a.user, n, now) : estimate("requests", a.user, now);
  const used = est - n; // before this request (a wait adds nothing)
  const last = used + Math.max(1, n) - 1; // the count before this request's last call: a batch must fit whole
  if (lim.dailyFree && last >= lim.dailyFree && (a.kind === "agent" || a.write)) {
    const cap = (await isPro(env, a.user, now)) ? lim.dailyPro : lim.dailyFree;
    if (cap && last >= cap) {
      if (n) unbump("requests", a.user, now, n); // refused requests don't count
      const s = secondsToMidnight(now);
      return err(
        429,
        a.kind === "agent"
          ? `Daily limit reached: ${a.user}'s agents and apps made ${cap.toLocaleString("en-US")} requests today. It resets at 00:00 UTC (in ${Math.ceil(s / 3600)}h).`
          : `Daily limit reached (${cap.toLocaleString("en-US")} requests today): you can still read, and changes work again at 00:00 UTC.`,
        s,
        { limit: cap, scope: "daily" },
      );
    }
  }
  // The cost guard's hard cap (src/costGuard.ts): waits and heavy reads stop until an operator clears it.
  if (a.wait || a.heavy) {
    const c = await capped(env, now);
    if (c) return cappedResponse(c);
  }
  // Loads the shed level at most once a minute per isolate, so waits here stretch once the cron says so.
  const level = await shedLevel(env, now);
  if (a.kind === "agent" && a.write && !a.essential && level >= 2) {
    return err(503, "Atteo is near its daily capacity, so non-essential agent changes are paused for now. Posting, tasks and approvals still work.", 600, { shed: 2 });
  }
  return null;
}

/** Counts every request the Worker serves (for the cron's shed level): in memory, flushed in batches. */
export const countServed = (env: Env, ctx: ExecutionContext | null, now = Date.now()) => bump(env, ctx, "requests_all", "", 1, now);

// ---------- one open wait per agent session ----------

const SUPERSEDE_MAX = 5; // more takeovers than this a minute: two loops are fighting over one session
const openWaits = new Map<string, { ac: AbortController; takeovers: number[] }>();

/**
 * Starts a wait for `key` (an agent session, or an MCP connection). A newer wait from the same session ends the older
 * one (it returns at once as superseded). Two loops fighting over one session would take turns forever, so after
 * SUPERSEDE_MAX takeovers a minute the new wait is refused instead. Per isolate: waits on other isolates aren't seen.
 */
export function beginWait(key: string | null | undefined, now = Date.now()): { signal?: AbortSignal; done: () => void; refused?: number } {
  if (!key) return { done: () => {} };
  const prior = openWaits.get(key);
  const takeovers = (prior?.takeovers ?? []).filter((t) => now - t < 60_000);
  if (prior && !prior.ac.signal.aborted) {
    if (takeovers.length >= SUPERSEDE_MAX) return { done: () => {}, refused: 10 };
    takeovers.push(now);
    prior.ac.abort("superseded");
  }
  const mine = { ac: new AbortController(), takeovers };
  if (openWaits.size > 20_000) openWaits.clear();
  openWaits.set(key, mine);
  return {
    signal: mine.ac.signal,
    done: () => {
      if (openWaits.get(key) === mine) {
        mine.ac.abort("done");
        // Keep the takeover history a minute so a fighting pair stays throttled; drop the entry otherwise.
        if (!mine.takeovers.length) openWaits.delete(key);
      }
    },
  };
}

export const superseded = (signal?: AbortSignal) => !!signal?.aborted && signal.reason === "superseded";
