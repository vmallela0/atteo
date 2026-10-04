import { describe, expect, it } from "vitest";
import { listInbox, markRead, pruneRead } from "../src/inbox";
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

function insert(db: any, user: string, board: string, seq: number, readAt: number | null) {
  db.prepare(
    `INSERT INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at, read_at)
     VALUES (?, ?, ?, 'mention', 'alice', 'agent', 'note', 'hi', ?, ?)`,
  ).run(user, board, seq, readAt ?? T0, readAt);
}

describe("inbox retention sweep", () => {
  it("deletes read notifications older than 30 days; keeps unread and recent read", async () => {
    const { env, db } = fakeEnv();
    insert(db, "bob", "", 1, T0 - 31 * day); // old read
    insert(db, "bob", "", 2, T0 - 5 * day); // recent read
    insert(db, "bob", "", 3, null); // unread

    expect(await pruneRead(env, T0)).toBe(1);
    const items = await listInbox(env, "bob");
    expect(items.map((i) => i.seq).sort()).toEqual([2, 3]);
    expect(items.find((i) => i.seq === 2)?.read_at).toBe(T0 - 5 * day);
    expect(items.find((i) => i.seq === 3)?.read_at).toBeNull();
  });

  it("markRead still works after a sweep", async () => {
    const { env, db } = fakeEnv();
    insert(db, "bob", "", 1, null);

    expect(await markRead(env, "bob", { ids: [1] })).toBe(1);
    expect((await listInbox(env, "bob"))[0].read_at).toBeGreaterThan(0);
    expect(await pruneRead(env, Date.now() + day)).toBe(0);
  });
});
