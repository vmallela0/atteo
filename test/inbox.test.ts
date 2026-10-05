import { describe, expect, it } from "vitest";
import { listInbox, markRead, pruneRead } from "../src/inbox";
import { boardsOverview } from "../src/registry";
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

function insert(db: any, user: string, board: string, seq: number, readAt: number | null, o: { seen?: number | null; kind?: string; created?: number } = {}) {
  db.prepare(
    `INSERT INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at, read_at, agent_seen_at)
     VALUES (?, ?, ?, ?, 'alice', 'agent', 'note', 'hi', ?, ?, ?)`,
  ).run(user, board, seq, o.kind ?? "mention", o.created ?? readAt ?? T0, readAt, o.seen === undefined ? readAt : o.seen);
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
  it("keeps a row the person read while it's still mail their agent hasn't collected (opus-d #2278)", async () => {
    const { env, db } = fakeEnv();
    insert(db, "bob", "", 1, T0 - 31 * day, { seen: null }); // person read, agent never collected: stays
    insert(db, "bob", "", 2, T0 - 31 * day, { seen: T0 - 31 * day }); // both done: goes
    insert(db, "bob", "", 3, T0 - 31 * day, { seen: null, kind: "people_only" }); // not agent mail: goes
    insert(db, "bob", "", 4, T0 - 31 * day, { seen: null, created: T0 - 91 * day }); // uncollected for 90+ days: goes
    insert(db, "bob", "", 5, null, { seen: T0 - 31 * day }); // agent collected, person never read: stays

    expect(await pruneRead(env, T0)).toBe(3);
    const left = db.prepare("SELECT seq FROM notifications ORDER BY seq").all().map((r: any) => r.seq);
    expect(left).toEqual([1, 5]);
  });
});

describe("person-only inbox rows (#3753)", () => {
  // A report (moderation) or a reminder is for the person: an agent token neither lists nor counts it on the board.
  it("an agent's board list doesn't count rows its inbox never shows", async () => {
    const { env, db } = fakeEnv();
    db.prepare("INSERT INTO boards (id, title, created_by, created_at, last_activity) VALUES ('b_test1234', 'T', 'bob', ?, ?)").run(T0, T0);
    db.prepare("INSERT INTO members (board_id, user, joined_at, last_seen) VALUES ('b_test1234', 'bob', ?, ?)").run(T0, T0);
    insert(db, "bob", "b_test1234", 7, null, { seen: null }); // a mention: everyone's
    insert(db, "bob", "b_test1234", -11, null, { seen: null, kind: "report" }); // a report's own row (negative seq)
    insert(db, "bob", "b_test1234", -12, null, { seen: null, kind: "reminder" });
    insert(db, "bob", "b_test1234", 8, null, { seen: null, kind: "people_only" });
    insert(db, "bob", "b_test1234", 9, null, { seen: null, kind: "manual_unread" });

    const agentList = (await listInbox(env, "bob", 50, false)).filter((i) => i.board_id === "b_test1234");
    const [asAgent] = await boardsOverview(env, "bob", false);
    expect(asAgent.unread).toBe(agentList.length);
    expect(asAgent.unread).toBe(1);
    const [asPerson] = await boardsOverview(env, "bob", true);
    expect(asPerson.unread).toBe(5);
  });
});
