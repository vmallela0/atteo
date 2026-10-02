// Operations: the PRD's usage metrics as daily counters, and server errors grouped by route and message.
// Writes are fire-and-forget (waitUntil) and throttled per isolate, so they never slow a request down.

import type { Env } from "./types";

const day = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
const once = new Map<string, number>();

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

export interface Metrics {
  days: { day: string; people: number; agents: number; posts_person: number; posts_agent: number; new_users: number; new_boards: number }[];
  clients: { client: string; agents: number }[];
  errors: { route: string; message: string; count: number; last_at: number }[];
}

export async function metrics(env: Env, n = 14): Promise<Metrics> {
  const since = day(Date.now() - (n - 1) * 86_400_000);
  const sinceMs = Date.parse(since + "T00:00:00Z");
  const [u, nu, nb, cl, er] = await Promise.all([
    env.DB.prepare(`SELECT day, metric, key, SUM(count) AS c, COUNT(*) AS k FROM usage_daily WHERE day >= ? GROUP BY day, metric, CASE WHEN metric = 'posts' THEN key ELSE '' END`).bind(since).all<{ day: string; metric: string; key: string; c: number; k: number }>(),
    env.DB.prepare(`SELECT strftime('%Y-%m-%d', first_seen / 1000, 'unixepoch') AS day, COUNT(*) AS c FROM users WHERE first_seen >= ? AND name NOT LIKE 'e2e-%' GROUP BY day`).bind(sinceMs).all<{ day: string; c: number }>(),
    env.DB.prepare(`SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS c FROM boards WHERE created_at >= ? AND title NOT LIKE 'e2e %' GROUP BY day`).bind(sinceMs).all<{ day: string; c: number }>(),
    // agent_client keys are "client|user": distinct people's agents per client.
    env.DB.prepare(`SELECT substr(key, 1, instr(key, '|') - 1) AS client, COUNT(DISTINCT substr(key, instr(key, '|') + 1)) AS agents FROM usage_daily WHERE metric = 'agent_client' AND day >= ? GROUP BY client ORDER BY agents DESC LIMIT 10`).bind(since).all<{ client: string; agents: number }>(),
    env.DB.prepare(`SELECT route, message, count, last_at FROM errors ORDER BY last_at DESC LIMIT 20`).all<{ route: string; message: string; count: number; last_at: number }>(),
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
  return { days, clients: cl.results, errors: er.results };
}
