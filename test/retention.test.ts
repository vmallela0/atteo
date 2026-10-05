// Retention blanks D1 copies (inbox, tape, the board list's last line) before the local commit.
// last_excerpt matches (last_activity, last_author) — two binds per row — so a 90-row seq chunk
// would send 182 parameters and fail D1's 100-bind cap.

import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
vi.stubGlobal("WebSocketRequestResponsePair", class {});
import { D1_BIND_LIMIT, D1_LAST_EXCERPT_CHUNK, D1_SEQ_CHUNK, retentionDirectoryUpdates } from "../src/board";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

const databases: { close(): void }[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const BLANK = "(removed: older than this board keeps messages)";
const BOARD_ID = "b_retain1";

function d1() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const binds: { sql: string; count: number }[] = [];
  const prepare = (sql: string) => {
    const stmt = {
      _args: [] as unknown[],
      bind(...args: unknown[]) {
        stmt._args = args;
        return stmt;
      },
      async run() {
        if (stmt._args.length > D1_BIND_LIMIT) throw new Error(`too many SQL variables: ${stmt._args.length}`);
        binds.push({ sql, count: stmt._args.length });
        db.prepare(sql).run(...stmt._args);
        return { success: true };
      },
    };
    return stmt;
  };
  return {
    db,
    binds,
    DB: {
      prepare,
      batch: async (stmts: { run(): Promise<unknown> }[]) => {
        for (const s of stmts) await s.run();
      },
    },
  };
}

function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({ seq: i + 1, ts: 1_000 + i + 1, author: `u${i + 1}` }));
}

describe("D1 bind budget for retention", () => {
  it("keeps seq and last_excerpt chunks under D1's 100-parameter cap", () => {
    expect(D1_LAST_EXCERPT_CHUNK).toBeLessThanOrEqual(45);
    expect(2 + D1_SEQ_CHUNK).toBeLessThanOrEqual(D1_BIND_LIMIT);
    expect(2 + D1_LAST_EXCERPT_CHUNK * 2).toBeLessThanOrEqual(D1_BIND_LIMIT);
    // The old last_excerpt statement used the seq chunk: 2 + 90×2 = 182.
    expect(2 + D1_SEQ_CHUNK * 2).toBeGreaterThan(D1_BIND_LIMIT);
  });

  it("compacts a 90-row page without exceeding 100 D1 binds, and blanks the matching board preview", async () => {
    const mock = d1();
    const page = rows(D1_SEQ_CHUNK);
    const last = page[page.length - 1]!;
    for (const r of page) {
      mock.db.prepare(
        `INSERT INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at)
         VALUES ('ada', ?, ?, 'mention', 'ada', 'person', 'note', ?, ?)`,
      ).run(BOARD_ID, r.seq, `keep-me-not ${r.seq}`, r.ts);
      mock.db.prepare(
        `INSERT INTO tape (board_id, seq, ts, author, via, type, excerpt) VALUES (?, ?, ?, ?, 'person', 'note', ?)`,
      ).run(BOARD_ID, r.seq, r.ts, r.author, `keep-me-not ${r.seq}`);
    }
    mock.db.prepare(
      `INSERT INTO boards (id, title, created_by, created_at, last_activity, last_author, last_excerpt)
       VALUES (?, 'Retention', 'ada', 1, ?, ?, ?)`,
    ).run(BOARD_ID, last.ts, last.author, `keep-me-not ${last.seq}`);

    const stmts = retentionDirectoryUpdates(mock.DB, BLANK, BOARD_ID, page);
    expect(stmts.length).toBeGreaterThan(4); // 3 seq lists + at least two last_excerpt pair chunks
    await mock.DB.batch(stmts);

    expect(mock.binds.length).toBe(stmts.length);
    expect(mock.binds.every((b) => b.count <= D1_BIND_LIMIT)).toBe(true);
    const preview = mock.binds.filter((b) => /UPDATE boards SET last_excerpt/.test(b.sql));
    expect(preview).toHaveLength(Math.ceil(D1_SEQ_CHUNK / D1_LAST_EXCERPT_CHUNK));
    expect(preview.every((b) => b.count <= 2 + D1_LAST_EXCERPT_CHUNK * 2)).toBe(true);
    expect(mock.db.prepare("SELECT last_excerpt FROM boards WHERE id = ?").get(BOARD_ID)).toEqual({ last_excerpt: BLANK });
    expect(mock.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE excerpt = ?").get(BLANK)).toEqual({ n: D1_SEQ_CHUNK });
    expect(mock.db.prepare("SELECT COUNT(*) AS n FROM tape WHERE excerpt = ?").get(BLANK)).toEqual({ n: D1_SEQ_CHUNK });
  });

  it("leaves a newer or purged board preview alone", async () => {
    const mock = d1();
    mock.db.prepare(
      `INSERT INTO boards (id, title, created_by, created_at, last_activity, last_author, last_excerpt)
       VALUES (?, 'Retention', 'ada', 1, 9_999, 'ada', 'newer preview')`,
    ).run(BOARD_ID);
    await mock.DB.batch(retentionDirectoryUpdates(mock.DB, BLANK, BOARD_ID, rows(50)));
    expect(mock.binds.every((b) => b.count <= D1_BIND_LIMIT)).toBe(true);
    expect(mock.db.prepare("SELECT last_excerpt FROM boards WHERE id = ?").get(BOARD_ID)).toEqual({ last_excerpt: "newer preview" });
  });
});
