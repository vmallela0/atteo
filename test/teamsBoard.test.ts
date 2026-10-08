// The board object's side of the Microsoft Teams integration: a Teams message's post (origin "teams") keeps a mention of
// the linker's own agent and mails it as ordinary "agent" mail labelled with its Teams author (never "from your
// person"). And a linked board sends its public posts to the channel through onEntry: never one from Teams, never on
// an encrypted board, never once unlinked.

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
const sent = vi.hoisted(() => ({ calls: [] as { board: string; seq: number; origin: string | null }[] }));
vi.mock("../src/teams", async (orig) => ({
  ...(await orig<typeof import("../src/teams")>()),
  onEntry: async (_env: unknown, info: { id: string }, e: { seq: number; origin?: string }) => {
    sent.calls.push({ board: info.id, seq: e.seq, origin: e.origin ?? null });
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
  sent.calls.length = 0;
});

const BOARD = "b_teamsobject1";

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
  meta.setMeta("title", "Teams");
  meta.setMeta("created_by", "vedu");
  meta.setMeta("created_at", "1");
  if (encrypted) meta.setMeta("encrypted", "1");
  directory.db.prepare("INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity) VALUES (?, 'Teams', 'vedu', 1, 0, 1)").run(BOARD);
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

describe("a Teams message on the board", () => {
  it("keeps and mails a mention of the linker's own agent, as agent mail labelled with its Teams author", async () => {
    const { board, db, directory, settle } = openBoard();
    const ms = [{ user: "vedu", agent: true }, { user: "ann", agent: true }];
    const e = await board.post("vedu", { type: "note", text: "Jane on Teams:\n\n@agents please look", via: "agent", client: "Microsoft Teams", mentions: ms, data: { teams: { author: "Jane" } } }, { origin: "teams" });
    await settle();
    expect(e.origin).toBe("teams");
    expect(mentionsAt(db, e.seq).map((m) => `${m.user}:${m.agent}`).sort()).toEqual(["ann:true", "vedu:true"]);
    const mail = directory.db.prepare("SELECT user, kind, data FROM notifications WHERE board_id = ? AND seq = ? ORDER BY user").all(BOARD, e.seq);
    expect(mail).toEqual([{ user: "ann", kind: "agent", data: '{"teams":"Jane"}' }, { user: "vedu", kind: "agent", data: '{"teams":"Jane"}' }]);
    const row = (await board.page(null, 10, { user: "ann", person: false })).find((x) => x.seq === e.seq);
    expect(row?.origin).toBe("teams");
    // The mailbox says who wrote it outside Atteo, never "vedu".
    const { collect } = await import("../src/mailbox");
    const env = { DB: directory.DB } as unknown as Env;
    const got = await collect(env, "ann", { limit: 10, wait: 0, peek: true }, async () => ({ text: e.text }));
    expect(got.mail.find((m) => m.seq === e.seq)?.from).toBe("Teams message by Jane (via vedu's Teams link)");
  });
});

describe("a linked board's posts", () => {
  it("go to Teams once linked, never one from Teams, never on an encrypted board, never once unlinked", async () => {
    const { board, settle } = openBoard();
    await board.post("vedu", { type: "note", text: "before linking", via: "person" });
    await settle();
    expect(sent.calls).toEqual([]);
    await board.setTeams(true);
    const a = await board.post("ann", { type: "note", text: "to the channel", via: "agent" });
    await board.post("vedu", { type: "note", text: "Jane on Teams:\n\nhi", via: "agent", client: "Microsoft Teams", data: { teams: { author: "Jane" } } }, { origin: "teams" });
    await settle();
    expect(sent.calls).toEqual([{ board: BOARD, seq: a.seq, origin: null }]);
    await board.setTeams(false);
    await board.post("ann", { type: "note", text: "after unlinking", via: "agent" });
    await settle();
    expect(sent.calls).toHaveLength(1);

    const enc = openBoard(true);
    await enc.board.setTeams(true);
    await enc.board.post("vedu", { type: "note", text: "ciphertext", via: "person" }).catch(() => null);
    await enc.settle();
    expect(sent.calls).toHaveLength(1);
  });
});
