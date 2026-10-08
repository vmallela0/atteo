// The board object's side of the Discord integration: a Discord message's post (origin "discord") keeps a mention of
// the linker's own agent and mails it as ordinary "agent" mail labelled with its Discord author (never "from your
// person"). And a linked board sends its public posts to the channel through onEntry: never one from Discord, never on
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
vi.mock("../src/discord", async (orig) => ({
  ...(await orig<typeof import("../src/discord")>()),
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

const BOARD = "b_discordobj1";

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
  meta.setMeta("title", "Discord");
  meta.setMeta("created_by", "vedu");
  meta.setMeta("created_at", "1");
  if (encrypted) meta.setMeta("encrypted", "1");
  directory.db.prepare("INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity) VALUES (?, 'Discord', 'vedu', 1, 0, 1)").run(BOARD);
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

describe("a Discord message on the board", () => {
  it("keeps and mails a mention of the linker's own agent, as agent mail labelled with its Discord author", async () => {
    const { board, db, directory, settle } = openBoard();
    const ms = [{ user: "vedu", agent: true }, { user: "ann", agent: true }];
    const e = await board.post("vedu", { type: "note", text: "Jane on Discord:\n\n@agents please look", via: "agent", client: "Discord", mentions: ms, data: { discord: { author: "Jane" } } }, { origin: "discord" });
    await settle();
    expect(e.origin).toBe("discord");
    expect(mentionsAt(db, e.seq).map((m) => `${m.user}:${m.agent}`).sort()).toEqual(["ann:true", "vedu:true"]);
    const mail = directory.db.prepare("SELECT user, kind, data FROM notifications WHERE board_id = ? AND seq = ? ORDER BY user").all(BOARD, e.seq);
    expect(mail).toEqual([{ user: "ann", kind: "agent", data: '{"discord":"Jane"}' }, { user: "vedu", kind: "agent", data: '{"discord":"Jane"}' }]);
    const row = (await board.page(null, 10, { user: "ann", person: false })).find((x) => x.seq === e.seq);
    expect(row?.origin).toBe("discord");
  });
});

describe("a linked board's posts", () => {
  it("go to Discord once linked, never one from Discord, never on an encrypted board, never once unlinked", async () => {
    const { board, settle } = openBoard();
    await board.post("vedu", { type: "note", text: "before linking", via: "person" });
    await settle();
    expect(sent.calls).toEqual([]);
    await board.setDiscord(true);
    const a = await board.post("ann", { type: "note", text: "to the channel", via: "agent" });
    await board.post("vedu", { type: "note", text: "Jane on Discord:\n\nhi", via: "agent", client: "Discord", data: { discord: { author: "Jane" } } }, { origin: "discord" });
    await settle();
    expect(sent.calls).toEqual([{ board: BOARD, seq: a.seq, origin: null }]);
    await board.setDiscord(false);
    await board.post("ann", { type: "note", text: "after unlinking", via: "agent" });
    await settle();
    expect(sent.calls).toHaveLength(1);

    const enc = openBoard(true);
    await enc.board.setDiscord(true);
    await enc.board.post("vedu", { type: "note", text: "ciphertext", via: "person" }).catch(() => null);
    await enc.settle();
    expect(sent.calls).toHaveLength(1);
  });
});
