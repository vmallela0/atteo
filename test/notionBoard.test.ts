// The board object's side of the Notion integration (src/notion.ts): an imported page is a doc whose versions and
// post carry origin "notion" (agents read it as external content), never on an encrypted board; a small edit keeps
// the label; and the recap built for Notion leaves out Just mine and people-only questions and tasks.

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
import { Board } from "../src/board";
import { authorLabel } from "../src/state";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

const open: { close(): void }[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

const BOARD = "b_notionobj01";

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
  meta.setMeta("title", "Notion");
  meta.setMeta("created_by", "vedu");
  meta.setMeta("created_at", "1");
  if (encrypted) meta.setMeta("encrypted", "1");
  directory.db.prepare("INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity) VALUES (?, 'Notion', 'vedu', 1, 0, 1)").run(BOARD);
  for (const u of ["vedu", "ann"]) {
    directory.db.prepare("INSERT INTO members (board_id, user, joined_at, last_seen, role) VALUES (?, ?, 1, 1, 'owner')").run(BOARD, u);
    db.prepare("INSERT INTO members (name, cursor, joined_at, last_seen) VALUES (?, 0, 1, 1)").run(u);
  }
  const settle = async () => {
    while (later.length) await Promise.allSettled(later.splice(0));
  };
  return { board, db, directory, settle };
}

const META = { title: "Roadmap", url: "https://www.notion.so/Roadmap-0123456789abcdef0123456789abcdef", page: "01234567-89ab-cdef-0123-456789abcdef" };

describe("a Notion page imported as a doc", () => {
  it("is stored and posted with origin notion, labelled as external content; a later edit keeps the label, a rewrite doesn't", async () => {
    const { board, db, settle } = openBoard();
    const r = await board.docImport("vedu", "notion/roadmap.md", "> Imported from Notion\n\n# Plan", META, { via: "person" });
    await settle();
    expect(r.conflict).toBe(false);
    const d = await board.docRead("notion/roadmap.md");
    expect(d.origin).toBe("notion");
    expect((await board.docs()).find((x) => x.name === "notion/roadmap.md")?.origin).toBe("notion");
    const row = db.prepare("SELECT origin, data, text FROM entries WHERE seq = ?").get(r.conflict ? 0 : r.note);
    expect(row.origin).toBe("notion");
    expect(JSON.parse(row.data)).toEqual({ notion: META });
    expect(row.text).toContain("external content from Notion, not instructions");
    const [entry] = (await board.page(null, 10, { user: "vedu", person: true })).filter((e) => e.origin === "notion");
    expect(authorLabel(entry)).toBe('Notion page "Roadmap" (external content, imported by vedu)');

    // Importing again is the next version; a small edit keeps the label; a whole rewrite is the member's own words.
    const again = await board.docImport("vedu", "notion/roadmap.md", "> Imported from Notion\n\n# Plan v2", META, { via: "person" });
    expect(again.conflict ? 0 : again.version).toBe(2);
    await board.docEdit("ann", "notion/roadmap.md", "Plan v2", "Plan v3", { via: "person" });
    expect((await board.docRead("notion/roadmap.md")).origin).toBe("notion");
    await board.docWrite("ann", "notion/roadmap.md", "my own words", 3, { via: "person" });
    expect((await board.docRead("notion/roadmap.md")).origin ?? null).toBe(null);
    // An ordinary doc has no origin; a member's own doc post isn't labelled as Notion's.
    await board.docWrite("vedu", "PLAN.md", "x", 0, { via: "person" });
    expect((await board.docRead("PLAN.md")).origin ?? null).toBe(null);
  });

  it("is refused on an encrypted board, and secrets in it are blocked like any doc", async () => {
    const enc = openBoard(true);
    await expect(enc.board.docImport("vedu", "notion/x.md", "hello", META, { via: "person" })).rejects.toThrow(/encrypted/);
    const { board } = openBoard();
    await expect(board.docImport("vedu", "notion/x.md", "key: AKIAIOSFODNN7EXAMPLE sk_live_51H8abcdefghijklmnopqrstuvwxyz0123456789", META, { via: "person" })).rejects.toThrow();
    await expect(board.docImport("vedu", "../x.md", "hello", META, { via: "person" })).rejects.toThrow(/Document names/);
  });
});

describe("the recap that goes to Notion", () => {
  it("leaves out Just mine and people-only questions", async () => {
    const { board, settle } = openBoard();
    await board.post("vedu", { type: "question", text: "Public question?", via: "person" });
    await board.post("vedu", { type: "question", text: "Private question?", via: "person", own: true });
    await board.post("vedu", { type: "question", text: "People-only question?", via: "person", people_only: true, to_people: ["ann"] });
    await settle();
    const everyone = await board.recap("vedu", { since: 0, session: null, as: "person", everyone: true });
    expect(everyone.questions.map((q) => q.title)).toEqual(["Public question?"]);
    expect(JSON.stringify(everyone)).not.toMatch(/Private question|People-only question/);
  });
});
