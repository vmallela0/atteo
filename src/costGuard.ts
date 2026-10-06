// The cost guard (vedu #4340, after a Reddit post about a D1 bill going from $0 to $1,381 in 18 days): Cloudflare bills
// Workers Paid by usage past the monthly allowance, and nothing in the platform caps spend. This watches what we pay for
// and stops a runaway before it becomes a bill.
//
// Every cron tick (5 minutes) it reads today's totals from Cloudflare's GraphQL analytics: D1 rows read and written,
// Durable Object SQL rows read and written, Durable Object requests. Past a soft threshold it posts one alert a day per
// metric on the developers' board (BUGS_BOARD). Past a hard cap it trips a switch (the cost_guard row) that makes the
// expensive paths answer 503 (long-poll waits, search, grep, exports) until an operator clears it on /_ops. Ordinary
// reading and posting keep working, so people aren't locked out, only the loops that can run up a bill.
//
// It needs a token that can read account analytics: CF_ANALYTICS_TOKEN (or CF_API_TOKEN, which the load shedder in
// limits.ts already uses) plus CF_ACCOUNT_ID. Without them the guard does nothing and says so once per isolate.
// Every threshold is a var (vedu decides); docs/COSTS.md has the prices behind the defaults.

import type { Env } from "./types";

export type Metric = "rows_read" | "rows_written" | "do_requests";

export interface Usage {
  d1RowsRead: number;
  d1RowsWritten: number;
  doRowsRead: number;
  doRowsWritten: number;
  doRequests: number;
}

/** Per UTC day. Reads and writes add D1 and Durable Object SQL together (both are billed per row at the same price). */
export interface Thresholds {
  softRowsRead: number; // COST_SOFT_ROWS_READ (default 500M: ~7x a normal day)
  hardRowsRead: number; // COST_HARD_ROWS_READ (default 3B: $3 a day at $0.001 per million past the allowance)
  softRowsWritten: number; // COST_SOFT_ROWS_WRITTEN (default 5M: ~12x a normal day)
  hardRowsWritten: number; // COST_HARD_ROWS_WRITTEN (default 25M: $25 a day at $1.00 per million past the allowance)
  softDoRequests: number; // COST_SOFT_DO_REQUESTS (default 2M: ~12x a normal day)
  hardDoRequests: number; // COST_HARD_DO_REQUESTS (default 10M: $1.50 a day at $0.15 per million past the allowance)
}

const num = (v: string | undefined, d: number) => {
  if (v == null || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export function thresholds(env: Env): Thresholds {
  return {
    softRowsRead: num(env.COST_SOFT_ROWS_READ, 500_000_000),
    hardRowsRead: num(env.COST_HARD_ROWS_READ, 3_000_000_000),
    softRowsWritten: num(env.COST_SOFT_ROWS_WRITTEN, 5_000_000),
    hardRowsWritten: num(env.COST_HARD_ROWS_WRITTEN, 25_000_000),
    softDoRequests: num(env.COST_SOFT_DO_REQUESTS, 2_000_000),
    hardDoRequests: num(env.COST_HARD_DO_REQUESTS, 10_000_000),
  };
}

/** Today's totals per metric. */
export const totals = (u: Usage): Record<Metric, number> => ({
  rows_read: u.d1RowsRead + u.doRowsRead,
  rows_written: u.d1RowsWritten + u.doRowsWritten,
  do_requests: u.doRequests,
});

const LIMITS: Record<Metric, [keyof Thresholds, keyof Thresholds]> = {
  rows_read: ["softRowsRead", "hardRowsRead"],
  rows_written: ["softRowsWritten", "hardRowsWritten"],
  do_requests: ["softDoRequests", "hardDoRequests"],
};

/** Which metrics are past their soft threshold, and which past the hard cap (0 = that threshold is off). */
export function judge(u: Usage, t: Thresholds): { soft: Metric[]; hard: Metric[] } {
  const now = totals(u);
  const soft: Metric[] = [];
  const hard: Metric[] = [];
  for (const m of Object.keys(LIMITS) as Metric[]) {
    const [s, h] = LIMITS[m];
    if (t[h] && now[m] >= t[h]) hard.push(m);
    else if (t[s] && now[m] >= t[s]) soft.push(m);
  }
  return { soft, hard };
}

// ---------- reading today's usage from Cloudflare (read-only GraphQL) ----------

export const ANALYTICS_QUERY = `query($a: String!, $d: Date!) { viewer { accounts(filter: {accountTag: $a}) {
  d1: d1AnalyticsAdaptiveGroups(limit: 100, filter: {date_geq: $d, date_leq: $d}) { sum { rowsRead rowsWritten } }
  dosql: durableObjectsPeriodicGroups(limit: 100, filter: {date_geq: $d, date_leq: $d}) { sum { rowsRead rowsWritten } }
  doreq: durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: {date_geq: $d, date_leq: $d}) { sum { requests } }
} } }`;

type Groups = { sum?: Record<string, number | undefined> }[] | undefined;
const sum = (g: Groups, k: string) => (g ?? []).reduce((n, x) => n + (x.sum?.[k] ?? 0), 0);

export const analyticsToken = (env: Env) => env.CF_ANALYTICS_TOKEN || env.CF_API_TOKEN || "";

let warned = false;
let warnedFail = false;

/** What one read of today's usage came to: the totals, why it failed (never the token), or off without the settings. */
export type Reading = { usage: Usage } | { error: string } | { off: true };

const short = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

export async function readUsage(env: Env, now = Date.now(), fetcher: typeof fetch = fetch): Promise<Reading> {
  const token = analyticsToken(env);
  if (!env.CF_ACCOUNT_ID || !token) {
    if (!warned) console.log("cost guard: off (set CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN to watch D1 and Durable Object usage)");
    warned = true;
    return { off: true };
  }
  // Said once per isolate; every failure is still recorded for /_ops (check below).
  const failed = (error: string): Reading => {
    if (!warnedFail) console.warn(`cost guard: can't read today's usage (${error})`);
    warnedFail = true;
    return { error };
  };
  try {
    const r = await fetcher("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: ANALYTICS_QUERY, variables: { a: env.CF_ACCOUNT_ID, d: new Date(now).toISOString().slice(0, 10) } }),
      signal: AbortSignal.timeout(8000),
    });
    const j = (await r.json().catch(() => ({}))) as { data?: { viewer?: { accounts?: { d1?: Groups; dosql?: Groups; doreq?: Groups }[] } }; errors?: { message?: unknown }[] | null };
    const gql = Array.isArray(j.errors) && j.errors.length ? short(String(j.errors[0]?.message ?? "unknown error")) : "";
    if (!r.ok) return failed(short(`Cloudflare answered HTTP ${r.status}${gql ? `: ${gql}` : ""}`));
    if (gql) return failed(`Cloudflare analytics error: ${gql}`);
    const a = j.data?.viewer?.accounts?.[0];
    if (!a) return failed("Cloudflare returned no data for this account (check CF_ACCOUNT_ID and the token's Account Analytics: Read)");
    return {
      usage: {
        d1RowsRead: sum(a.d1, "rowsRead"),
        d1RowsWritten: sum(a.d1, "rowsWritten"),
        doRowsRead: sum(a.dosql, "rowsRead"),
        doRowsWritten: sum(a.dosql, "rowsWritten"),
        doRequests: sum(a.doreq, "requests"),
      },
    };
  } catch (e) {
    return failed(e instanceof Error && e.name === "TimeoutError" ? "Cloudflare analytics timed out" : short(`request failed: ${e instanceof Error ? e.message : String(e)}`));
  }
}

/** Today's usage so far, or null when there's no token or Cloudflare didn't answer. */
export async function usageToday(env: Env, now = Date.now(), fetcher: typeof fetch = fetch): Promise<Usage | null> {
  const r = await readUsage(env, now, fetcher);
  return "usage" in r ? r.usage : null;
}

// ---------- the switch: one row, set by the cron past a hard cap, cleared by an operator ----------

export const CAP_GET_SQL = `SELECT capped_at, reason FROM cost_guard WHERE id = 1 AND capped_at IS NOT NULL`;
export const CAP_SET_SQL = `INSERT INTO cost_guard (id, capped_at, reason, cleared_at, cleared_by) VALUES (1, ?, ?, NULL, NULL)
  ON CONFLICT(id) DO UPDATE SET capped_at = excluded.capped_at, reason = excluded.reason, cleared_at = NULL, cleared_by = NULL WHERE cost_guard.capped_at IS NULL`;
export const CAP_CLEAR_SQL = `UPDATE cost_guard SET capped_at = NULL, cleared_at = ?, cleared_by = ? WHERE id = 1`;
// Each check's outcome on the same row (migration 0068, vedu #4665): the last good read with its totals, or the last error.
export const STATUS_OK_SQL = `INSERT INTO cost_guard (id, checked_ok_at, usage_json) VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET checked_ok_at = excluded.checked_ok_at, usage_json = excluded.usage_json`;
export const STATUS_ERR_SQL = `INSERT INTO cost_guard (id, error_at, error) VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET error_at = excluded.error_at, error = excluded.error`;
export const STATUS_GET_SQL = `SELECT checked_ok_at, usage_json, error_at, error FROM cost_guard WHERE id = 1`;
// One alert per metric per UTC day (usage_daily is (day, metric, key) → count; INSERT OR IGNORE is the once-only).
export const ALERT_ONCE_SQL = `INSERT OR IGNORE INTO usage_daily (day, metric, key, count) VALUES (?, 'cost_alert', ?, 1)`;

const CAP_MS = 60_000;
let capCache: { at: number; capped: { at: number; reason: string } | null } | null = null;

/** Whether the hard cap has tripped: this isolate's cached answer, else one primary-key read (at most once a minute). */
export async function capped(env: Env, now = Date.now()): Promise<{ at: number; reason: string } | null> {
  if (capCache && now - capCache.at < CAP_MS) return capCache.capped;
  const prev = capCache?.capped ?? null;
  capCache = { at: now, capped: prev }; // concurrent callers use this meanwhile
  try {
    const r = await env.DB.prepare(CAP_GET_SQL).first<{ capped_at: number; reason: string | null }>();
    capCache = { at: now, capped: r ? { at: r.capped_at, reason: r.reason ?? "" } : null };
  } catch {}
  return capCache.capped;
}

export const resetCapCache = () => {
  capCache = null;
  warned = false;
  warnedFail = false;
};

export async function clearCap(env: Env, by: string, now = Date.now()): Promise<void> {
  await env.DB.prepare(CAP_CLEAR_SQL).bind(now, by).run();
  capCache = { at: now, capped: null };
}

export interface Status {
  last_ok: { at: number; totals: Record<Metric, number> } | null;
  last_error: { at: number; message: string } | null;
}

/** The last check's outcome for /_ops (nulls before the first check, or on a database without migration 0068). */
export async function status(env: Env): Promise<Status> {
  try {
    const r = await env.DB.prepare(STATUS_GET_SQL).first<{ checked_ok_at: number | null; usage_json: string | null; error_at: number | null; error: string | null }>();
    let t: Record<Metric, number> | null = null;
    try {
      t = r?.usage_json ? (JSON.parse(r.usage_json) as Record<Metric, number>) : null;
    } catch {}
    return {
      last_ok: r?.checked_ok_at && t ? { at: r.checked_ok_at, totals: t } : null,
      last_error: r?.error_at && r.error ? { at: r.error_at, message: r.error } : null,
    };
  } catch {
    return { last_ok: null, last_error: null };
  }
}

const fmt = (n: number) => n.toLocaleString("en-US");
const LABEL: Record<Metric, string> = { rows_read: "rows read (D1 + Durable Object SQL)", rows_written: "rows written (D1 + Durable Object SQL)", do_requests: "Durable Object requests" };

export function describe(m: Metric, value: number, limit: number): string {
  return `${LABEL[m]} today: ${fmt(value)} (threshold ${fmt(limit)})`;
}

export interface Tick {
  usage: Usage | null;
  soft: Metric[];
  hard: Metric[];
  alerted: Metric[];
  capped: boolean;
  error?: string; // why today's usage couldn't be read (also recorded for /_ops)
}

/**
 * The cron: read today's usage, post an alert per new soft breach (once a day each), trip the switch on a hard one.
 * `post` writes the alert (the developers' board); injected so tests needn't run a board.
 */
export async function check(env: Env, post: (text: string) => Promise<unknown>, now = Date.now(), fetcher: typeof fetch = fetch): Promise<Tick> {
  const reading = await readUsage(env, now, fetcher);
  if (!("usage" in reading)) {
    const error = "error" in reading ? reading.error : undefined;
    if (error) await env.DB.prepare(STATUS_ERR_SQL).bind(now, error).run().catch(() => {});
    return { usage: null, soft: [], hard: [], alerted: [], capped: !!(await capped(env, now)), error };
  }
  const usage = reading.usage;
  const t = thresholds(env);
  const { soft, hard } = judge(usage, t);
  const vals = totals(usage);
  await env.DB.prepare(STATUS_OK_SQL).bind(now, JSON.stringify(vals)).run().catch(() => {});
  const d = new Date(now).toISOString().slice(0, 10);
  const alerted: Metric[] = [];
  for (const m of [...hard, ...soft]) {
    const first = await env.DB.prepare(ALERT_ONCE_SQL).bind(d, m).run().then((r) => (r.meta?.changes ?? 0) > 0).catch(() => false);
    if (!first) continue;
    const isHard = hard.includes(m);
    const [s, h] = LIMITS[m];
    const line = describe(m, vals[m], t[isHard ? h : s]);
    await post(
      isHard
        ? `🛑 Cost guard tripped: ${line}. Long-poll waits, search, grep and exports now answer 503 until an operator clears it on /_ops (Overview → Cost guard). Find the loop first (docs/COSTS.md).`
        : `⚠️ Cost guard: ${line}. Still under the hard cap; see docs/COSTS.md for what's normal and how to find the reader.`,
    ).catch(() => {});
    alerted.push(m);
  }
  if (hard.length) {
    const reason = hard.map((m) => describe(m, vals[m], t[LIMITS[m][1]])).join("; ");
    await env.DB.prepare(CAP_SET_SQL).bind(now, reason).run().catch(() => {});
    capCache = null;
  }
  return { usage, soft, hard, alerted, capped: !!(await capped(env, now)) };
}

// ---------- which requests the switch stops ----------

/** REST paths that can read a lot per call: search and grep, exports and downloads (long-poll waits are flagged separately). */
export function isHeavyRest(method: string, path: string): boolean {
  if (method !== "GET" && method !== "POST") return false;
  return /\/(search|grep)$/.test(path) || /\/export(\/|$)/.test(path) || /\.jsonl$/.test(path) || /\/(download|log\.jsonl)$/.test(path);
}

/** MCP tools that can read a lot per call. */
export const HEAVY_MCP = new Set(["search", "grep", "export"]);

/** The 503 a heavy request gets while the switch is on. */
export function cappedResponse(c: { at: number; reason: string }): Response {
  return new Response(
    JSON.stringify({
      error: "Atteo paused waiting, search and exports because today's database use passed its safety cap. Reading and posting still work. The team has been told.",
      cost_cap: true,
      since: c.at,
      retry_after: 600,
    }),
    { status: 503, headers: { "content-type": "application/json", "retry-after": "600", "cache-control": "no-store" } },
  );
}
