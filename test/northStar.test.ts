import { describe, expect, it } from "vitest";
import { compute, mondayLine, northStar, snapshot, tick, weekStart } from "../src/northStar";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

function fakeEnv(vars: Partial<Env> = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { results: [], meta: { changes: r.changes } };
    },
  });
  const DB = { prepare: (sql: string) => stmt(sql), batch: async (ss: any[]) => Promise.all(ss.map((s) => s.run())) };
  return { env: { DB, ...vars } as unknown as Env, db };
}

const DAY = 86_400_000;
// Wednesday 2026-10-07 12:00 UTC; its week starts Monday 2026-10-05.
const WED = Date.UTC(2026, 9, 7, 12, 0, 0);
const MON = Date.UTC(2026, 9, 5);

function user(db: any, name: string, email: string | null) {
  db.prepare(`INSERT INTO users (name, email, first_seen, last_seen) VALUES (?, ?, ?, ?)`).run(name, email, MON - 30 * DAY, MON);
}
function board(db: any, id: string, deleted = false) {
  db.prepare(`INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity, deleted_at) VALUES (?, ?, 'x', ?, 0, ?, ?)`).run(id, id, MON - 30 * DAY, MON, deleted ? MON : null);
}
function member(db: any, b: string, u: string, lastSeen: number | null) {
  db.prepare(`INSERT INTO members (board_id, user, joined_at, last_seen) VALUES (?, ?, ?, ?)`).run(b, u, MON - 30 * DAY, lastSeen);
}

/** Four outside people, the team, and test accounts, on boards that do and don't count. */
function seed(db: any) {
  for (const [n, e] of [
    ["ana", "ana@acme.io"],
    ["bo", "bo@globex.io"],
    ["cy", "cy@initech.io"],
    ["di", "di@hooli.io"],
    ["vedu", "vedu@atteo.dev"],
    ["jxn", "jxn@atteo.dev"],
    ["e2e-zed", "zed@acme.io"],
    ["tess", "tess@test.io"],
    ["ex", "ex@example.com"],
    ["noemail", null],
  ] as const)
    user(db, n, e);
  for (const b of ["b_pair", "b_old", "b_us", "b_tests", "b_gone", "b_solo"]) board(db, b, b === "b_gone");
  const now = WED - DAY; // Tuesday this week
  // Two outsiders posting this week: counts.
  member(db, "b_pair", "ana", now);
  member(db, "b_pair", "bo", now);
  // Two outsiders, but one posted last week: doesn't.
  member(db, "b_old", "ana", now);
  member(db, "b_old", "cy", MON - 1);
  // An outsider and us: the mixed number, not the north star.
  member(db, "b_us", "di", now);
  member(db, "b_us", "vedu", now);
  // One outsider plus test accounts (e2e-, test/example emails, no email): doesn't.
  member(db, "b_tests", "bo", now);
  for (const t of ["e2e-zed", "tess", "ex", "noemail"]) member(db, "b_tests", t, now);
  // Deleted board: doesn't.
  member(db, "b_gone", "ana", now);
  member(db, "b_gone", "di", now);
  member(db, "b_solo", "cy", MON - 3 * DAY);
}

describe("north star: collaborating boards", () => {
  it("weeks start Monday 00:00 UTC", () => {
    expect(weekStart(WED)).toBe(MON);
    expect(weekStart(MON)).toBe(MON);
    expect(weekStart(MON - 1)).toBe(MON - 7 * DAY); // Sunday 23:59:59.999 is last week
    expect(weekStart(Date.UTC(2026, 9, 11, 23, 0))).toBe(MON); // Sunday
  });

  it("counts boards with 2+ outside people active this week; team, test accounts, stale members and deleted boards left out", async () => {
    const { env, db } = fakeEnv();
    seed(db);
    expect(await compute(env, WED)).toEqual({ week: "2026-10-05", collab: 1, mixed: 1, people: 3 }); // ana, bo, di (cy last posted last week)
  });

  it("TEAM_USERS decides who is us", async () => {
    const { env, db } = fakeEnv({ TEAM_USERS: "jxn" } as Partial<Env>);
    seed(db);
    // vedu is now an outsider: b_us has two outsiders and no team member.
    expect(await compute(env, WED)).toMatchObject({ collab: 2, mixed: 0, people: 4 });
  });

  it("a post at Monday 00:00 counts for the new week; one a millisecond earlier doesn't", async () => {
    const { env, db } = fakeEnv();
    seed(db);
    db.prepare(`UPDATE members SET last_seen = ? WHERE board_id = 'b_old' AND user = 'cy'`).run(MON);
    expect((await compute(env, WED)).collab).toBe(2); // b_pair + b_old
  });

  it("snapshots overwrite the running week; history reads snapshots and puts this week live at the end", async () => {
    const { env, db } = fakeEnv();
    seed(db);
    db.prepare(`INSERT INTO usage_daily (day, metric, key, count) VALUES ('2026-09-28', 'north_star', 'collab', 3), ('2026-09-28', 'north_star', 'people', 5)`).run();
    await snapshot(env, WED);
    await snapshot(env, WED); // twice: still one row per number
    expect(db.prepare(`SELECT key, count FROM usage_daily WHERE metric = 'north_star' AND day = '2026-10-05' ORDER BY key`).all()).toEqual([
      { key: "collab", count: 1 },
      { key: "mixed", count: 1 },
      { key: "people", count: 3 },
    ]);
    const ns = await northStar(env, WED);
    expect(ns.weeks).toHaveLength(8);
    expect(ns.weeks[0].week).toBe("2026-08-17");
    expect(ns.weeks[6]).toEqual({ week: "2026-09-28", collab: 3, mixed: 0, people: 5 });
    expect(ns.weeks[7]).toEqual(ns.this_week);
    expect(JSON.stringify(ns)).not.toMatch(/ana|acme|@/); // counts only
  });

  it("the Monday line: once per week from 16:00 UTC, last week against the week before; unset board posts nothing", async () => {
    const posts: string[] = [];
    const post = async (_b: string, t: string) => void posts.push(t);
    const { env, db } = fakeEnv({ NORTH_STAR_BOARD: "b_team" } as Partial<Env>);
    seed(db);
    db.prepare(`INSERT INTO usage_daily (day, metric, key, count) VALUES ('2026-10-05', 'north_star', 'collab', 2), ('2026-10-05', 'north_star', 'mixed', 1), ('2026-10-05', 'north_star', 'people', 4), ('2026-09-28', 'north_star', 'collab', 1)`).run();
    const nextMon = MON + 7 * DAY;
    expect((await tick(env, nextMon + 15 * 3600_000, post)).posted).toBeUndefined(); // 15:00: not yet
    const r = await tick(env, nextMon + 16 * 3600_000 + 60_000, post);
    expect(r.posted).toBe("North star (week of 2026-10-05): 2 collaborating boards (week before: 1) · 1 board with us + outsiders · 4 outside people active");
    await tick(env, nextMon + 17 * 3600_000, post);
    expect(posts).toHaveLength(1);
    const quiet = fakeEnv();
    seed(quiet.db);
    expect((await tick(quiet.env, nextMon + 16 * 3600_000, post)).posted).toBeUndefined();
  });

  it("FLAG_DISABLE_NORTH_STAR skips the Monday post and leaves the weekly claim", async () => {
    const posts: string[] = [];
    const { env, db } = fakeEnv({ NORTH_STAR_BOARD: "b_team", FLAG_DISABLE_NORTH_STAR: "1" } as Partial<Env>);
    seed(db);
    const at = MON + 7 * DAY + 16 * 3600_000;
    expect((await tick(env, at, async (_b, t) => void posts.push(t))).posted).toBeUndefined();
    expect(posts).toHaveLength(0);
    expect(db.prepare(`SELECT key FROM usage_daily WHERE metric = 'north_star_post'`).get()).toBeUndefined();
    env.FLAG_DISABLE_NORTH_STAR = "0";
    const r = await tick(env, at, async (_b, t) => void posts.push(t));
    expect(r.posted).toContain("collaborating boards");
    expect(posts).toHaveLength(1);
  });

  it("a failed post gives its claim back, so the next run tries again", async () => {
    const { env, db } = fakeEnv({ NORTH_STAR_BOARD: "b_team" } as Partial<Env>);
    seed(db);
    const at = MON + 7 * DAY + 16 * 3600_000;
    await expect(tick(env, at, async () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    const posts: string[] = [];
    await tick(env, at + 300_000, async (_b, t) => void posts.push(t));
    expect(posts).toHaveLength(1);
  });

  it("snapshots hourly, on a week's first run, and every run in its last hour", async () => {
    const { env, db } = fakeEnv();
    seed(db);
    const ran = async (t: number) => !!(await tick(env, t, async () => {})).snapshot;
    expect(await ran(WED + 20 * 60_000)).toBe(true); // first run this week
    expect(await ran(WED + 25 * 60_000)).toBe(false); // mid-hour
    expect(await ran(WED + 60 * 60_000)).toBe(true); // top of the hour
    expect(await ran(Date.UTC(2026, 9, 11, 23, 40))).toBe(true); // Sunday 23:40
  });

  it("mondayLine says one/many", () => {
    expect(mondayLine({ week: "2026-10-05", collab: 1, mixed: 0, people: 1 }, undefined)).toBe(
      "North star (week of 2026-10-05): 1 collaborating board (week before: 0) · 0 boards with us + outsiders · 1 outside person active",
    );
  });
});
