// The north-star number (vedu #5281/#5284): collaborating boards, boards where two or more outside people were active in
// a week. "Active" is a post by the person or their agent: registry.touch sets members.last_seen on every post. That
// column only keeps the latest time, so the cron snapshots the running week into usage_daily (metric 'north_star', day
// = the week's Monday) once an hour; the last snapshot before Monday 00:00 UTC is that week's number. Counts only: no
// names or emails leave this file.

import { flagOn } from "./flags";
import type { Env } from "./types";

export const METRIC = "north_star";
const POSTED = "north_star_post"; // one row per week once the Monday line is on the board
const DAY = 86_400_000;
export const WEEKS = 8;
const DEFAULT_TEAM = "vedu,jxn";

export interface NorthStarWeek {
  week: string; // Monday (UTC), YYYY-MM-DD
  collab: number; // boards with 2+ outside people active that week
  mixed: number; // boards with an outside person and a team member both active that week
  people: number; // outside people active that week (posted on any board)
}

export interface NorthStar {
  team: string[];
  this_week: NorthStarWeek; // live, computed now
  weeks: NorthStarWeek[]; // the last WEEKS weeks, oldest first, this week last (live)
}

/** Monday 00:00 UTC of the week holding `now`. */
export function weekStart(now: number): number {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnight - ((d.getUTCDay() + 6) % 7) * DAY;
}
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The team's own accounts (TEAM_USERS, comma-separated; default "vedu,jxn"). */
export function teamUsers(env: Pick<Env, "TEAM_USERS">): string[] {
  const raw = env.TEAM_USERS ?? DEFAULT_TEAM;
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** SQL for "u is an outside person": a real signed-up account (has an email), not the team, not a test account. */
export function outsideSql(team: string[], alias = "u"): string {
  const notTeam = team.length ? ` AND lower(${alias}.name) NOT IN (${team.map(() => "?").join(", ")})` : "";
  return `${alias}.email IS NOT NULL AND ${alias}.email != '' AND ${alias}.name NOT LIKE 'e2e-%' AND lower(${alias}.email) NOT LIKE '%test%' AND lower(${alias}.email) NOT LIKE '%example%'${notTeam}`;
}

/** The running week's three numbers, from members.last_seen / users.last_seen at `now`. */
export async function compute(env: Env, now = Date.now()): Promise<NorthStarWeek> {
  const team = teamUsers(env);
  const since = weekStart(now);
  const out = outsideSql(team);
  const teamIn = team.length ? `lower(m.user) IN (${team.map(() => "?").join(", ")})` : "0";
  const [collab, mixed, people] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM (SELECT m.board_id FROM members m JOIN users u ON u.name = m.user JOIN boards b ON b.id = m.board_id
        WHERE b.deleted_at IS NULL AND m.last_seen >= ? AND ${out} GROUP BY m.board_id HAVING COUNT(DISTINCT m.user) >= 2)`,
    )
      .bind(since, ...team)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT m.board_id) AS n FROM members m JOIN users u ON u.name = m.user JOIN boards b ON b.id = m.board_id
        WHERE b.deleted_at IS NULL AND m.last_seen >= ? AND ${out}
          AND EXISTS (SELECT 1 FROM members m2 WHERE m2.board_id = m.board_id AND m2.last_seen >= ? AND ${teamIn.replace(/\bm\./g, "m2.")})`,
    )
      .bind(since, ...team, since, ...team)
      .first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(DISTINCT m.user) AS n FROM members m JOIN users u ON u.name = m.user WHERE m.last_seen >= ? AND ${out}`)
      .bind(since, ...team)
      .first<{ n: number }>(),
  ]);
  return { week: ymd(since), collab: collab?.n ?? 0, mixed: mixed?.n ?? 0, people: people?.n ?? 0 };
}

/** Writes the running week's numbers over its snapshot row (one row per number). */
export async function snapshot(env: Env, now = Date.now()): Promise<NorthStarWeek> {
  const w = await compute(env, now);
  const put = (key: string, n: number) =>
    env.DB.prepare(`INSERT INTO usage_daily (day, metric, key, count) VALUES (?, ?, ?, ?) ON CONFLICT(day, metric, key) DO UPDATE SET count = excluded.count`).bind(w.week, METRIC, key, n);
  await env.DB.batch([put("collab", w.collab), put("mixed", w.mixed), put("people", w.people)]);
  return w;
}

/** The last WEEKS weeks: snapshots for past weeks (0 where none was taken), the running week live. */
export async function northStar(env: Env, now = Date.now()): Promise<NorthStar> {
  const current = weekStart(now);
  const first = ymd(current - (WEEKS - 1) * 7 * DAY);
  const [live, rows] = await Promise.all([
    compute(env, now),
    env.DB.prepare(`SELECT day, key, count FROM usage_daily WHERE metric = ? AND day >= ? AND day < ?`).bind(METRIC, first, ymd(current)).all<{ day: string; key: string; count: number }>(),
  ]);
  const weeks: NorthStarWeek[] = [];
  for (let i = WEEKS - 1; i >= 1; i--) {
    const week = ymd(current - i * 7 * DAY);
    const at = (key: string) => rows.results.find((r) => r.day === week && r.key === key)?.count ?? 0;
    weeks.push({ week, collab: at("collab"), mixed: at("mixed"), people: at("people") });
  }
  weeks.push(live);
  return { team: teamUsers(env), this_week: live, weeks };
}

/** The Monday line: the week that just ended, against the one before it. */
export function mondayLine(last: NorthStarWeek, before: NorthStarWeek | undefined): string {
  const s = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return `North star (week of ${last.week}): ${s(last.collab, "collaborating board", "collaborating boards")} (week before: ${before?.collab ?? 0}) · ${s(last.mixed, "board", "boards")} with us + outsiders · ${s(last.people, "outside person", "outside people")} active`;
}

/** Due at the first cron run on Monday from 16:00 UTC (9am in California), once per week. */
export const postDue = (now: number) => new Date(now).getUTCDay() === 1 && new Date(now).getUTCHours() >= 16;

/**
 * The cron's part: snapshot the running week (hourly, the first run of a week, and every run of its last hour); on Monday from 16:00 UTC, post last week's line to NORTH_STAR_BOARD once. Unset board: no post.
 */
export async function tick(env: Env, now: number, post: (board: string, text: string) => Promise<unknown>): Promise<{ snapshot?: NorthStarWeek; posted?: string }> {
  const week = ymd(weekStart(now));
  const have = await env.DB.prepare(`SELECT 1 AS x FROM usage_daily WHERE day = ? AND metric = ? LIMIT 1`).bind(week, METRIC).first();
  const out: { snapshot?: NorthStarWeek; posted?: string } = {};
  const d = new Date(now);
  // Hourly, and every run in the week's last hour (Sunday 23:00 UTC on), so the closing number misses at most one run.
  if (!have || d.getUTCMinutes() < 5 || (d.getUTCDay() === 0 && d.getUTCHours() === 23)) out.snapshot = await snapshot(env, now);
  const board = (env.NORTH_STAR_BOARD ?? "").trim();
  if (board && postDue(now)) {
    // Kill switch (src/flags.ts). Checked before the weekly claim, so lifting it later this week still posts.
    // Unknown (no key, PostHog down) leaves the post on. FLAG_DISABLE_NORTH_STAR=1 skips it without a deploy of new code.
    if (await flagOn("disable_north_star", env)) return out;
    const claimed = await env.DB.prepare(`INSERT OR IGNORE INTO usage_daily (day, metric, key, count) VALUES (?, ?, ?, 1)`).bind(week, POSTED, board.slice(0, 80)).run();
    if ((claimed.meta.changes ?? 0) > 0) {
      const ns = await northStar(env, now);
      const text = mondayLine(ns.weeks[WEEKS - 2], ns.weeks[WEEKS - 3]);
      try {
        await post(board, text);
        out.posted = text;
      } catch (e) {
        // Give the claim back, so the next run tries again.
        await env.DB.prepare(`DELETE FROM usage_daily WHERE day = ? AND metric = ? AND key = ?`).bind(week, POSTED, board.slice(0, 80)).run();
        throw e;
      }
    }
  }
  return out;
}
