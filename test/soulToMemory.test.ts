// The SOUL is gone (vedu #5266): a board whose agents were handed rules (PROTOCOL.md) gets one memory item that says
// where they are and how they begin, once, when its object next starts. The doc itself stays; nothing is dropped.

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
import { Board, MEMORY_TEXT_MAX, soulMemoryText } from "../src/board";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };

const databases: { close(): void }[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

type Db = { exec(q: string): void; prepare(q: string): { all(...a: unknown[]): any[]; run(...a: unknown[]): unknown } };

function sqlFor(db: Db) {
  return {
    exec(query: string, ...args: unknown[]) {
      if (args.length === 0 && query.includes(";")) {
        // No FTS5 in this Node build: a plain table stands in for the search index.
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

/** The board's object over `db`, as if it just (re)started: its constructor runs the migrations. */
function start(db: Db): Board {
  return new Board(
    { storage: { sql: sqlFor(db), transactionSync(fn: () => void) { fn(); } }, setWebSocketAutoResponse() {}, getWebSockets: () => [], getTags: () => [] } as unknown as DurableObjectState,
    {} as Env,
  );
}

/** A board from before vedu #5266: created, with `rules` as its PROTOCOL.md, and its SOUL never migrated. */
function oldBoard(rules: string | null, opts: { encrypted?: boolean } = {}): Db {
  const db: Db = new DatabaseSync(":memory:");
  databases.push(db as unknown as { close(): void });
  const meta = start(db) as unknown as { setMeta(k: string, v: string): void };
  meta.setMeta("id", "b_soul1");
  meta.setMeta("title", "Old board");
  meta.setMeta("created_by", "ada");
  meta.setMeta("created_at", "1");
  if (opts.encrypted) meta.setMeta("encrypted", "1");
  if (rules != null) db.prepare("INSERT INTO docs (name, version, content, updated_by, updated_at, via, client, created_by, created_at) VALUES ('PROTOCOL.md', 3, ?, 'jxn', 2, 'person', NULL, 'ada', 1)").run(rules);
  return db;
}

const memory = (db: Db) => db.prepare("SELECT text, by_user, via, struck_ts FROM memory ORDER BY id").all();

describe("the SOUL moves into memory (vedu #5266)", () => {
  it("leaves one memory item that points at PROTOCOL.md and quotes how it begins, by whoever last edited it", () => {
    const db = oldBoard("# How we work\n- answer in thread\n- keep posts short\n");
    start(db);
    const items = memory(db);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ by_user: "jxn", via: "person", struck_ts: null });
    expect(items[0].text).toBe(`This board's rules are in PROTOCOL.md (v3; doc read PROTOCOL.md). They begin: "How we work"`);
    // The doc is untouched.
    expect(db.prepare("SELECT version, content FROM docs WHERE name = 'PROTOCOL.md'").all()[0]).toMatchObject({ version: 3, content: "# How we work\n- answer in thread\n- keep posts short\n" });
  });

  it("runs once: later restarts add nothing, and a struck item stays struck", () => {
    const db = oldBoard("We ship small.");
    start(db);
    start(db);
    expect(memory(db)).toHaveLength(1);
    db.prepare("UPDATE memory SET struck_by = 'ada', struck_ts = 5, struck_v = 9").run();
    start(db);
    expect(memory(db)).toHaveLength(1);
  });

  it("adds nothing for a board with no rules, empty rules, or end-to-end encryption (which has no memory)", () => {
    for (const db of [oldBoard(null), oldBoard("  \n\n "), oldBoard("# Secret rules", { encrypted: true })]) {
      start(db);
      expect(memory(db)).toHaveLength(0);
    }
  });

  it("doesn't repeat what memory already holds, and still lands when memory is full", () => {
    const db = oldBoard("Use pnpm");
    const text = soulMemoryText("Use pnpm", 3);
    const add = db.prepare("INSERT INTO memory (text, norm, by_user, via, ts, add_v) VALUES (?, ?, 'ada', 'person', 1, 1)");
    add.run(text, text.toLowerCase().replace(/[\s.!?;:,]+$/, ""));
    start(db);
    expect(memory(db)).toHaveLength(1);

    const full = oldBoard("Use pnpm");
    const fill = full.prepare("INSERT INTO memory (text, norm, by_user, via, ts, add_v) VALUES (?, ?, 'ada', 'person', 1, 1)");
    for (let i = 0; i < 50; i++) fill.run(`fact ${i}`, `fact ${i}`);
    start(full);
    expect(memory(full)).toHaveLength(51);
  });

  it("never touches a board created after the change", async () => {
    const db: Db = new DatabaseSync(":memory:");
    databases.push(db as unknown as { close(): void });
    const board = start(db);
    await board.init("b_new1", "New board", "ada");
    db.prepare("INSERT INTO docs (name, version, content, updated_by, updated_at, via, client, created_by, created_at) VALUES ('PROTOCOL.md', 1, 'Our rules', 'ada', 2, 'person', NULL, 'ada', 1)").run();
    start(db);
    expect(memory(db)).toHaveLength(0);
  });

  it("fits a long first line into one memory item", () => {
    const t = soulMemoryText("## " + "x".repeat(1000) + "\nmore", 12);
    expect(t.length).toBeLessThanOrEqual(MEMORY_TEXT_MAX);
    expect(t).toMatch(/^This board's rules are in PROTOCOL\.md \(v12; doc read PROTOCOL\.md\)\. They begin: "x+…"$/);
  });
});
