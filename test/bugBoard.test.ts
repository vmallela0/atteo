import { beforeEach, describe, expect, it } from "vitest";
import { ensureBugBoard, isReservedUser, resetBugBoardCache } from "../src/bugBoard";
import { BUG_BOT } from "../src/bugs";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

function fakeEnv() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  let queries = 0;
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (queries++, db.prepare(sql).get(...args) ?? null),
    all: async () => (queries++, { results: db.prepare(sql).all(...args) }),
    run: async () => (queries++, { results: [], meta: { changes: db.prepare(sql).run(...args).changes } }),
  });
  return { env: { DB: { prepare: (sql: string) => stmt(sql) } } as unknown as Env, db, queries: () => queries };
}

/** The board's Durable Object, reduced to what the helper calls. */
function fakeStub() {
  const calls = { init: 0, join: [] as string[] };
  const stub = {
    init: async (id: string, title: string, createdBy: string) => (calls.init++, { id, title, created_by: createdBy, created_at: 1 }),
    join: async (user: string) => (calls.join.push(user), {}),
  };
  return { stub: stub as unknown as Parameters<typeof ensureBugBoard>[2], calls };
}

const BOARD = "b_bugsboard01";

describe("the bug board's bot member (jxn #4139)", () => {
  beforeEach(() => resetBugBoardCache());

  it("an existing board: the bot gets a sign-in-less user row, a membership and a seat on the board", async () => {
    const { env, db } = fakeEnv();
    db.prepare("INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity) VALUES (?, 'Atteo bugs', 'vedu', 1, 0, 1)").run(BOARD);
    const { stub, calls } = fakeStub();
    await ensureBugBoard(env, BOARD, stub);
    const bot = db.prepare("SELECT email, workos_id FROM users WHERE name = ?").get(BUG_BOT);
    expect(bot).toEqual({ email: null, workos_id: null }); // nothing anyone could sign in with
    expect(db.prepare("SELECT role FROM members WHERE board_id = ? AND user = ?").get(BOARD, BUG_BOT)).toEqual({ role: "contributor" });
    expect(calls.init).toBe(0); // the board was already there
    expect(calls.join).toEqual([BUG_BOT]);
  });

  it("a second report doesn't set anything up again", async () => {
    const { env, db, queries } = fakeEnv();
    db.prepare("INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity) VALUES (?, 'Atteo bugs', 'vedu', 1, 0, 1)").run(BOARD);
    const { stub, calls } = fakeStub();
    await ensureBugBoard(env, BOARD, stub);
    const after = queries();
    await ensureBugBoard(env, BOARD, stub);
    expect(queries()).toBe(after);
    expect(calls.join).toHaveLength(1);
  });

  it("a fresh server pointed at a board it doesn't have yet makes it, owned by the bot", async () => {
    const { env, db } = fakeEnv();
    const { stub, calls } = fakeStub();
    await ensureBugBoard(env, BOARD, stub);
    expect(calls.init).toBe(1);
    expect(db.prepare("SELECT created_by FROM boards WHERE id = ?").get(BOARD)).toEqual({ created_by: BUG_BOT });
    expect(db.prepare("SELECT role FROM members WHERE board_id = ? AND user = ?").get(BOARD, BUG_BOT)).toEqual({ role: "owner" });
  });

  it("never reuses the name if a person already holds it", async () => {
    const { env, db } = fakeEnv();
    db.prepare("INSERT INTO users (name, email, email_verified, workos_id, display_name, first_seen, last_seen) VALUES (?, 'someone@example.com', 1, 'wos_1', null, 1, 1)").run(BUG_BOT);
    const { stub, calls } = fakeStub();
    await expect(ensureBugBoard(env, BOARD, stub)).rejects.toThrow(/belongs to a person/);
    expect(calls.join).toHaveLength(0);
  });

  it("people can't take the bot's names", () => {
    expect(isReservedUser("bugs")).toBe(true);
    expect(isReservedUser("github")).toBe(true);
    expect(isReservedUser("vedu")).toBe(false);
  });
});
