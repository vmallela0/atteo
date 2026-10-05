import { describe, expect, it } from "vitest";
import { pruneUsageDaily } from "../src/usage";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

function fakeEnv() {
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
  return { env: { DB: { prepare: (sql: string) => stmt(sql) } } as unknown as Env, db };
}

const day = 86_400_000;
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
const fmt = (ts: number) => new Date(ts).toISOString().slice(0, 10);

function insert(db: any, d: string, metric: string, key: string) {
  db.prepare(`INSERT INTO usage_daily (day, metric, key, count) VALUES (?, ?, ?, 1)`).run(d, metric, key);
}

function rows(db: any, d: string) {
  return db.prepare(`SELECT metric, key FROM usage_daily WHERE day = ?`).all(d);
}

describe("usage_daily retention sweep", () => {
  it("deletes rows older than 90 days; keeps recent rows", async () => {
    const { env, db } = fakeEnv();
    const oldDay = fmt(T0 - 91 * day);
    const recentDay = fmt(T0 - 5 * day);
    insert(db, oldDay, "requests", "old");
    insert(db, recentDay, "requests", "recent");

    expect(await pruneUsageDaily(env, T0)).toBe(1);
    expect(rows(db, oldDay)).toEqual([]);
    expect(rows(db, recentDay)).toEqual([{ metric: "requests", key: "recent" }]);
  });

  it("leaves lifetime uniqueness rows (first agent post) when it sweeps", async () => {
    const { env, db } = fakeEnv();
    insert(db, "once", "success_once", "vedu");
    insert(db, fmt(T0 - 91 * day), "success", "board_created");
    expect(await pruneUsageDaily(env, T0)).toBe(1);
    expect(rows(db, "once")).toEqual([{ metric: "success_once", key: "vedu" }]);
  });

  it("leaves nothing to delete when all rows are within the window", async () => {
    const { env, db } = fakeEnv();
    insert(db, fmt(T0 - 30 * day), "requests", "vedu");
    expect(await pruneUsageDaily(env, T0)).toBe(0);
    expect(rows(db, fmt(T0 - 30 * day))).toHaveLength(1);
  });
});
