import { describe, expect, it } from "vitest";
import { pruneMail } from "../src/mailbox";
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

function insert(db: any, user: string, board: string, seq: number, agentSeenAt: number | null) {
  db.prepare(
    `INSERT INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at, agent_seen_at)
     VALUES (?, ?, ?, 'mention', 'alice', 'agent', 'note', 'hi', ?, ?)`,
  ).run(user, board, seq, agentSeenAt ?? T0, agentSeenAt);
}

function remaining(db: any, user: string): { seq: number; agent_seen_at: number | null }[] {
  return db.prepare(`SELECT seq, agent_seen_at FROM notifications WHERE user = ? ORDER BY seq`).all(user);
}

describe("mailbox acked retention sweep", () => {
  it("deletes acked mail older than 30 days; keeps unacked and recent acked", async () => {
    const { env, db } = fakeEnv();
    insert(db, "bob", "", 1, T0 - 31 * day); // old acked
    insert(db, "bob", "", 2, T0 - 5 * day); // recent acked
    insert(db, "bob", "", 3, null); // unacked

    expect(await pruneMail(env, T0)).toBe(1);
    const rows = remaining(db, "bob");
    expect(rows.map((r) => r.seq).sort()).toEqual([2, 3]);
    expect(rows.find((r) => r.seq === 2)?.agent_seen_at).toBe(T0 - 5 * day);
    expect(rows.find((r) => r.seq === 3)?.agent_seen_at).toBeNull();
  });

  it("leaves nothing to delete when all acked rows are within the window", async () => {
    const { env, db } = fakeEnv();
    insert(db, "bob", "", 1, T0 - 30 * day);
    expect(await pruneMail(env, T0)).toBe(0);
    expect(remaining(db, "bob")).toHaveLength(1);
  });
});
