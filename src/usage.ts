// Operations: the PRD's usage metrics as daily counters, and server errors grouped by route and message.
// Writes are fire-and-forget (waitUntil) and throttled per isolate, so they never slow a request down.

import { observability, SUCCESS_ONCE_DAY, successMetrics, type Observability, type SuccessMetrics } from "./observe";
import { northStar, type NorthStar } from "./northStar";
import type { Env } from "./types";

const day = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
const once = new Map<string, number>();

const USAGE_RETENTION_DAYS = 90;

/** Cron sweep: delete usage_daily rows older than 90 days (shared with test/queryPlans.test.ts). Lifetime uniqueness rows (day = SUCCESS_ONCE_DAY) stay. */
export const PRUNE_USAGE_DAILY_SQL = `DELETE FROM usage_daily WHERE day < ? AND day != '${SUCCESS_ONCE_DAY}'`;

/** Deletes usage_daily rows past the retention window; recent days stay. */
export async function pruneUsageDaily(env: Env, now = Date.now(), days = USAGE_RETENTION_DAYS): Promise<number> {
  const r = await env.DB.prepare(PRUNE_USAGE_DAILY_SQL).bind(day(now - days * 86_400_000)).run();
  return r.meta.changes ?? 0;
}

/** Count an event. `unique`: count each key once per day (active people, active agents). */
export function track(env: Env, metric: string, key: string, unique = false): Promise<unknown> | null {
  const d = day();
  if (unique) {
    const k = `${d}:${metric}:${key}`;
    if (once.has(k)) return null;
    once.set(k, 1);
    if (once.size > 20_000) once.clear();
    return env.DB.prepare(`INSERT OR IGNORE INTO usage_daily (day, metric, key, count) VALUES (?, ?, ?, 1)`).bind(d, metric, key.slice(0, 80)).run();
  }
  return env.DB.prepare(`INSERT INTO usage_daily (day, metric, key, count) VALUES (?, ?, ?, 1) ON CONFLICT(day, metric, key) DO UPDATE SET count = count + 1`).bind(d, metric, key.slice(0, 80)).run();
}

/**
 * Count an event under a key that outsiders choose (CSP reports): at most `cap` distinct keys per metric per day. Once
 * the cap is reached, a key that isn't already counted today goes to `overflow`, so nobody can fill the table or bury
 * the real rows under made-up ones.
 */
export function trackCapped(env: Env, metric: string, key: string, cap: number, overflow: string): Promise<unknown> {
  const d = day();
  return env.DB.prepare(
    `INSERT INTO usage_daily (day, metric, key, count)
     SELECT ?1, ?2, CASE WHEN EXISTS (SELECT 1 FROM usage_daily WHERE day = ?1 AND metric = ?2 AND key = ?3)
                           OR (SELECT COUNT(*) FROM usage_daily WHERE day = ?1 AND metric = ?2) < ?4 THEN ?3 ELSE ?5 END, 1
     WHERE true
     ON CONFLICT(day, metric, key) DO UPDATE SET count = count + 1`,
  )
    .bind(d, metric, key.slice(0, 80), cap, overflow.slice(0, 80))
    .run();
}

/** "GET /api/boards/b_x/entries/12" → "GET /api/boards/:board/entries/:n", so errors group by route. */
export const routeKey = (route: string) => route.replace(/\/b_[a-z0-9]+/g, "/:board").replace(/\/\d+/g, "/:n").slice(0, 120);

export function recordError(env: Env, route: string, e: unknown): Promise<unknown> {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  const r = routeKey(route);
  const now = Date.now();
  return env.DB.prepare(
    `INSERT INTO errors (key, route, message, count, first_at, last_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(key) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
  )
    .bind(`${r} ${message}`.slice(0, 400), r, message, now, now)
    .run();
}

/** Pro's list price (USD/month), for the MRR estimate on /_ops. Keep in step with the pricing on the landing page. */
export const PRO_MONTHLY_USD = 10;

/** The numbers worth knowing at a glance. Test accounts (e2e-*) and test boards are left out. */
export interface Kpis {
  users: number;
  users_7d: number; // signed up in the last 7 days
  users_30d: number;
  active_1d: number; // people seen on the web, through an agent or a watcher
  active_7d: number;
  active_30d: number;
  pro: number; // paying (active or trialing)
  cancelling: number; // Pro, ending at the period end
  mrr: number; // USD, estimated from list price
  boards: number;
  boards_active_7d: number;
  agents_7d: number; // people whose agent or CLI used a token in the last 7 days
  posts_7d: number;
  errors_24h: number; // kinds of server error seen in the last 24 hours
  errors_24h_total: number; // how often those kinds have happened, all time
}

export interface Metrics {
  kpis: Kpis;
  days: { day: string; people: number; agents: number; posts_person: number; posts_agent: number; new_users: number; new_boards: number }[];
  clients: { client: string; agents: number }[];
  errors: { route: string; message: string; count: number; last_at: number }[];
  csp: { key: string; count: number; last_day: string }[]; // CSP reports (blocked, or would-be-blocked while report-only), last 7 days ("directive blocked")
  observe: Observability; // trust/context counters, derived rates, latency p95, and request wall time (src/observe.ts)
  success: SuccessMetrics; // product activation: boards created, first agent post, invite redeemed, friend accepted
  north_star?: NorthStar; // boards where 2+ outside people were active, per week (src/northStar.ts)
}

export async function metrics(env: Env, n = 14): Promise<Metrics> {
  const since = day(Date.now() - (n - 1) * 86_400_000);
  const sinceMs = Date.parse(since + "T00:00:00Z");
  const now = Date.now(),
    D = 86_400_000;
  const [u, nu, nb, cl, er, ku, kb, ka, ke, observe, success] = await Promise.all([
    env.DB.prepare(`SELECT day, metric, key, SUM(count) AS c, COUNT(*) AS k FROM usage_daily WHERE day >= ? GROUP BY day, metric, CASE WHEN metric = 'posts' THEN key ELSE '' END`).bind(since).all<{ day: string; metric: string; key: string; c: number; k: number }>(),
    env.DB.prepare(`SELECT strftime('%Y-%m-%d', first_seen / 1000, 'unixepoch') AS day, COUNT(*) AS c FROM users WHERE first_seen >= ? AND name NOT LIKE 'e2e-%' GROUP BY day`).bind(sinceMs).all<{ day: string; c: number }>(),
    env.DB.prepare(`SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS c FROM boards WHERE created_at >= ? AND title NOT LIKE 'e2e %' AND created_by NOT LIKE 'e2e-%' GROUP BY day`).bind(sinceMs).all<{ day: string; c: number }>(),
    // agent_client keys are "client|user": distinct people's agents per client.
    env.DB.prepare(`SELECT substr(key, 1, instr(key, '|') - 1) AS client, COUNT(DISTINCT substr(key, instr(key, '|') + 1)) AS agents FROM usage_daily WHERE metric = 'agent_client' AND day >= ? GROUP BY client ORDER BY agents DESC LIMIT 10`).bind(since).all<{ client: string; agents: number }>(),
    env.DB.prepare(`SELECT route, message, count, last_at FROM errors ORDER BY last_at DESC LIMIT 20`).all<{ route: string; message: string; count: number; last_at: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS users, SUM(first_seen >= ?1) AS users_7d, SUM(first_seen >= ?2) AS users_30d,
         SUM(MAX(last_seen, COALESCE(web_seen, 0), COALESCE(watch_seen, 0)) >= ?3) AS active_1d,
         SUM(MAX(last_seen, COALESCE(web_seen, 0), COALESCE(watch_seen, 0)) >= ?1) AS active_7d,
         SUM(MAX(last_seen, COALESCE(web_seen, 0), COALESCE(watch_seen, 0)) >= ?2) AS active_30d,
         SUM(plan = 'pro' AND COALESCE(plan_status, 'active') IN ('active', 'trialing')) AS pro,
         SUM(plan = 'pro' AND plan_cancel_at_end = 1) AS cancelling
       FROM users WHERE name NOT LIKE 'e2e-%'`,
    )
      .bind(now - 7 * D, now - 30 * D, now - D)
      .first<Record<string, number | null>>(),
    env.DB.prepare(`SELECT COUNT(*) AS boards, SUM(last_activity >= ?) AS active FROM boards WHERE title NOT LIKE 'e2e %' AND created_by NOT LIKE 'e2e-%'`).bind(now - 7 * D).first<{ boards: number; active: number | null }>(),
    env.DB.prepare(`SELECT COUNT(DISTINCT user) AS n FROM tokens WHERE last_used >= ? AND revoked_at IS NULL AND user NOT LIKE 'e2e-%'`).bind(now - 7 * D).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS kinds, COALESCE(SUM(count), 0) AS n FROM errors WHERE last_at >= ?`).bind(now - D).first<{ kinds: number; n: number }>(),
    observability(env, n),
    successMetrics(env, n),
  ]);
  const days = Array.from({ length: n }, (_, i) => ({ day: day(Date.now() - (n - 1 - i) * 86_400_000), people: 0, agents: 0, posts_person: 0, posts_agent: 0, new_users: 0, new_boards: 0 }));
  const at = (d: string) => days.find((x) => x.day === d);
  for (const r of u.results) {
    const d = at(r.day);
    if (!d) continue;
    if (r.metric === "active_person") d.people = r.k;
    else if (r.metric === "active_agent") d.agents = r.k;
    else if (r.metric === "posts") r.key === "agent" ? (d.posts_agent += r.c) : (d.posts_person += r.c);
  }
  for (const r of nu.results) if (at(r.day)) at(r.day)!.new_users = r.c;
  for (const r of nb.results) if (at(r.day)) at(r.day)!.new_boards = r.c;
  const k = (key: string) => Number(ku?.[key] ?? 0);
  const kpis: Kpis = {
    users: k("users"),
    users_7d: k("users_7d"),
    users_30d: k("users_30d"),
    active_1d: k("active_1d"),
    active_7d: k("active_7d"),
    active_30d: k("active_30d"),
    pro: k("pro"),
    cancelling: k("cancelling"),
    mrr: k("pro") * PRO_MONTHLY_USD,
    boards: kb?.boards ?? 0,
    boards_active_7d: kb?.active ?? 0,
    agents_7d: ka?.n ?? 0,
    posts_7d: days.slice(-7).reduce((n, x) => n + x.posts_person + x.posts_agent, 0),
    errors_24h: ke?.kinds ?? 0,
    errors_24h_total: ke?.n ?? 0,
  };
  const csp = await env.DB.prepare(`SELECT key, SUM(count) AS count, MAX(day) AS last_day FROM usage_daily WHERE metric = 'csp' AND day >= ? GROUP BY key ORDER BY count DESC LIMIT 20`)
    .bind(day(now - 6 * D))
    .all<{ key: string; count: number; last_day: string }>();
  const north_star = await northStar(env, now);
  return { kpis, days, clients: cl.results, errors: er.results, csp: csp.results, observe, success, north_star };
}
