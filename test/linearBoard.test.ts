// The board object's side of the Linear integration: a Linear comment's note (origin "linear") keeps a mention of its
// author's own agent and mails it, as ordinary "agent" mail (never "from your person"); the same words from the
// author's own agent don't. And a linked board syncs a task change through syncTask, never on an encrypted board.

import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.stubGlobal("WebSocketRequestResponsePair", class {});
const sync = vi.hoisted(() => ({ calls: [] as { board: string; seq: number; status: string }[] }));
vi.mock("../src/linear", async (orig) => ({
  ...(await orig<typeof import("../src/linear")>()),
  syncTask: async (_l: unknown, board: string, t: { seq: number; status: string }) => {
    sync.calls.push({ board, seq: t.seq, status: t.status });
    return "updated";
  },
}));
import { Board } from "../src/board";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

const open: { close(): void }[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  sync.calls.length = 0;
});

const BOARD = "b_linearobj01";

function d1() {
  const db = new DatabaseSync(":memory:");
  open.push(db);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const prepare = (sql: string) => {
    const stmt = {
      _args: [] as unknown[],
      bind(...args: unknown[]) {
        stmt._args = args;
        return stmt;
      },
      async run() {
        const r = db.prepare(sql).run(...stmt._args);
        return { success: true, meta: { changes: Number(r.changes) } };
      },
      async all() {
        return { results: db.prepare(sql).all(...stmt._args) };
      },
      async first() {
        return db.prepare(sql).get(...stmt._args) ?? null;
      },
    };
    return stmt;
  };
  return { db, DB: { prepare, batch: async (stmts: { run(): Promise<unknown> }[]) => Promise.all(stmts.map((s) => s.run())) } };
}

function sqlFor(db: any) {
  return {
    exec(query: string, ...args: unknown[]) {
      if (args.length === 0 && query.includes(";")) {
        db.exec(query.replace(/CREATE VIRTUAL TABLE IF NOT EXISTS search_idx USING fts5\([^;]*\);/, "CREATE TABLE IF NOT EXISTS search_idx (body TEXT, name TEXT, kind TEXT, ref TEXT);"));
        const empty: unknown[] = [];
        return { toArray: () => empty, one: () => undefined, [Symbol.iterator]: () => empty[Symbol.iterator]() };
      }
      const stmt = db.prepare(query);
      const returns = /^\s*(select|pragma|with|explain)\b/i.test(query) || /\breturning\b/i.test(query);
      const rows = returns ? stmt.all(...args) : (stmt.run(...args), [] as unknown[]);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  };
}

function openBoard(encrypted = false) {
  const directory = d1();
  const db = new DatabaseSync(":memory:");
  open.push(db);
  const later: Promise<unknown>[] = [];
  const env = { DB: directory.DB, BOARD: { idFromName: (id: string) => id, get: () => ({}) } } as unknown as Env;
  const board = new Board(
    {
      storage: { sql: sqlFor(db), transactionSync(fn: () => void) { fn(); } },
      setWebSocketAutoResponse() {},
      getWebSockets: () => [],
      getTags: () => [],
      waitUntil: (p: Promise<unknown>) => void later.push(p),
    } as unknown as DurableObjectState,
    env,
  );
  const meta = board as unknown as { setMeta(key: string, value: string): void };
  meta.setMeta("id", BOARD);
  meta.setMeta("title", "Linear");
  meta.setMeta("created_by", "vedu");
  meta.setMeta("created_at", "1");
  if (encrypted) meta.setMeta("encrypted", "1");
  directory.db.prepare("INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity) VALUES (?, 'Linear', 'vedu', 1, 0, 1)").run(BOARD);
  for (const u of ["vedu", "ann"]) {
    directory.db.prepare("INSERT INTO members (board_id, user, joined_at, last_seen, role) VALUES (?, ?, 1, 1, 'owner')").run(BOARD, u);
    db.prepare("INSERT INTO members (name, cursor, joined_at, last_seen) VALUES (?, 0, 1, 1)").run(u);
  }
  const settle = async () => {
    while (later.length) await Promise.allSettled(later.splice(0));
  };
  return { board, db, directory, settle };
}

const mentionsAt = (db: any, seq: number) => JSON.parse(db.prepare("SELECT mentions FROM entries WHERE seq = ?").get(seq).mentions ?? "[]") as { user: string; agent: boolean }[];

describe("a Linear comment on the board", () => {
  it("keeps and mails a mention of its author's own agent, as agent mail (not from their person)", async () => {
    const { board, db, directory, settle } = openBoard();
    const task = await board.taskCreate("vedu", { title: "Fix checkout" }, { via: "person" });
    const ms = [{ user: "vedu", agent: true }, { user: "ann", agent: true }];
    const e = await board.post("vedu", { type: "note", text: "Jane commented on Linear (ENG-1):\n\n@agents please look", reply_to: task.task.seq, via: "agent", client: "Linear", mentions: ms }, { origin: "linear" });
    await settle();
    expect(e.origin).toBe("linear");
    expect(mentionsAt(db, e.seq).map((m) => `${m.user}:${m.agent}`).sort()).toEqual(["ann:true", "vedu:true"]);
    const mail = directory.db.prepare("SELECT user, kind FROM notifications WHERE board_id = ? AND seq = ? ORDER BY user").all(BOARD, e.seq);
    expect(mail).toEqual([{ user: "ann", kind: "agent" }, { user: "vedu", kind: "agent" }]);

    // The same words from vedu's own agent (no origin): a self-mention, dropped as before.
    const own = await board.post("vedu", { type: "note", text: "@agents please look", reply_to: task.task.seq, via: "agent", client: "Claude Code", mentions: ms });
    await settle();
    expect(mentionsAt(db, own.seq).map((m) => m.user)).toEqual(["ann"]);
  });
});

describe("a linked board's task changes", () => {
  it("sync through syncTask once linked, and never on an encrypted board", async () => {
    const { board, settle } = openBoard();
    const t = await board.taskCreate("vedu", { title: "Unlinked" }, { via: "person" });
    await settle();
    expect(sync.calls).toEqual([]);
    await board.setLinear(true);
    const t2 = await board.taskCreate("vedu", { title: "Linked" }, { via: "person" });
    await board.taskUpdate("vedu", t.task.seq, { status: "doing" }, { via: "person" });
    await settle();
    expect(sync.calls).toEqual([
      { board: BOARD, seq: t2.task.seq, status: "todo" },
      { board: BOARD, seq: t.task.seq, status: "doing" },
    ]);

    const enc = openBoard(true);
    await enc.board.setLinear(true);
    (enc.board as unknown as { linearKick(seq: number): void }).linearKick(1);
    await enc.settle();
    expect(sync.calls).toHaveLength(2);
  });
});
