// Retention blanks D1 copies (inbox, tape, the board list's last line) before the local commit.
// last_excerpt matches (last_activity, last_author) — two binds per row — so a 90-row seq chunk
// would send 182 parameters and fail D1's 100-bind cap.

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
import { Board, D1_BIND_LIMIT, D1_LAST_EXCERPT_CHUNK, D1_SEQ_CHUNK, retentionDirectoryUpdates } from "../src/board";
import { RETAINED_QUOTE, scrubQuote } from "../src/forwards";
import type { Env } from "../src/types";

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
      async all() {
        if (stmt._args.length > D1_BIND_LIMIT) throw new Error(`too many SQL variables: ${stmt._args.length}`);
        binds.push({ sql, count: stmt._args.length });
        return { results: db.prepare(sql).all(...stmt._args) };
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

function sqlFor(db: { exec(q: string): void; prepare(q: string): { all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown } }) {
  return {
    exec(query: string, ...args: unknown[]) {
      if (args.length > D1_BIND_LIMIT) throw new Error(`too many SQL variables: ${args.length}`);
      if (args.length === 0 && query.includes(";")) {
        // This Node build has no FTS5. The retention statements only filter search_idx by kind and ref, so a plain table is enough.
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

function forwarded(srcSeq: number, secret: string) {
  return ["look at these", "↪ Forwarded from **Ops** · 2 messages", `> **ada** · #${srcSeq}\n> ${secret}`, "> **jxn** · #99\n> noted"].join("\n\n");
}

/** A board object plus the D1 directory its retention pass updates. */
function openBoard() {
  const directory = d1();
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sent: string[] = [];
  const quotes = new Map<string, string>();
  const calls: { dst: string; dstSeq: number; srcSeq: number; replacement?: string }[] = [];
  let fail = false;
  const env = {
    DB: directory.DB,
    BOARD: {
      idFromName: (id: string) => id,
      get: (id: string) => ({
        scrubForwardQuote: async (dstSeq: number, srcSeq: number, replacement?: string) => {
          if (fail) throw new Error("destination down");
          calls.push({ dst: String(id), dstSeq, srcSeq, replacement });
          const key = `${id}:${dstSeq}`;
          const cur = quotes.get(key);
          if (cur == null) return false;
          const next = scrubQuote(cur, srcSeq, replacement);
          quotes.set(key, next.text);
          return next.changed;
        },
      }),
    },
  } as unknown as Env;
  const board = new Board(
    {
      storage: { sql: sqlFor(db), transactionSync(fn: () => void) { fn(); } },
      setWebSocketAutoResponse() {},
      getWebSockets: () => [{ send(data: string) { sent.push(data); } }],
      getTags: () => [],
    } as unknown as DurableObjectState,
    env,
  );
  const meta = board as unknown as { setMeta(key: string, value: string): void };
  meta.setMeta("id", BOARD_ID);
  meta.setMeta("title", "Retention");
  meta.setMeta("created_by", "ada");
  meta.setMeta("created_at", "1");
  const forward = (srcSeq: number, dstSeq: number, secret: string) => {
    directory.db.prepare("INSERT INTO forwards (src_board, src_seq, dst_board, dst_seq) VALUES (?, ?, 'b_other', ?)").run(BOARD_ID, srcSeq, dstSeq);
    quotes.set(`b_other:${dstSeq}`, forwarded(srcSeq, secret));
  };
  return { board, db, directory, quotes, calls, sent, forward, setFail: (v: boolean) => { fail = v; } };
}

describe("retention purge parity", () => {
  it("blanks derived memory and task words, keeps live state, and scrubs forwarded quotes", async () => {
    const { board, db, directory, quotes, calls, sent, forward } = openBoard();
    const entry = (seq: number, ts: number, text: string, extra: { title?: string | null; reply?: number | null; purged?: string | null; retained?: number | null } = {}) => {
      db.prepare("INSERT INTO entries (seq, ts, author, type, text, title, reply_to, purged, retained_at) VALUES (?, ?, 'ada', 'task', ?, ?, ?, ?, ?)").run(
        seq, ts, text, extra.title ?? null, extra.reply ?? null, extra.purged ?? null, extra.retained ?? null,
      );
    };
    const task = (seq: number, updated: number, title: string, body: string, note: string | null = "shipped") => {
      db.prepare(
        `INSERT INTO tasks (seq, status, assignee, lease_holder, lease_until, stop_reason, priority, due, parent, title, body, version, updated_at, done_note)
         VALUES (?, 'doing', 'ada', 'ada', 9_000, 'hold', 'high', 8_000, NULL, ?, ?, 4, ?, ?)`,
      ).run(seq, title, body, updated, note);
      db.prepare("INSERT INTO task_versions (seq, version, title, body, author, ts) VALUES (?, 1, ?, ?, 'ada', ?)").run(seq, title, body, updated);
      db.prepare("INSERT INTO search_idx (body, name, kind, ref) VALUES (?, '', 'task', ?)").run(`${title}\n${body}`, String(seq));
    };
    const memory = (text: string, source: number | null, ts: number, struck: string | null = null) => {
      db.prepare(
        "INSERT INTO memory (text, norm, by_user, via, source_seq, ts, add_v, struck_by, struck_ts, struck_v) VALUES (?, ?, 'ada', 'person', ?, ?, 1, ?, ?, ?)",
      ).run(text, text, source, ts, struck, struck ? ts : null, struck ? 1 : null);
    };

    entry(1, 1_000, "secret one", { title: "Old title", reply: 2 });
    db.prepare("INSERT INTO entry_versions (seq, version, text, ts) VALUES (1, 1, 'secret one edited', 1_000)").run();
    db.prepare("INSERT INTO search_idx (body, name, kind, ref) VALUES ('secret one', '', 'entry', '1')").run();
    task(1, 1_000, "secret title", "secret body");
    memory("secret fact", 1, 1_000);
    memory("struck secret", 1, 1_000, "ada");
    forward(1, 10, "hunter2");

    entry(2, 9_000_000_000_000, "live message", { title: "Live" });
    task(2, 9_000_000_000_000, "live title", "live body", "live note");
    memory("live fact", 2, 9_000_000_000_000);
    forward(2, 11, "live-secret");

    entry(3, 1_000, BLANK, { retained: 5_000 });
    task(3, 4_000, "leftover title", "leftover body");
    memory("leftover fact", 3, 4_000);
    forward(3, 13, "leftover-secret");

    entry(4, 1_000, BLANK, { retained: 5_000 });
    task(4, 8_000, "new plan", "rewritten after", "kept note");
    db.prepare("INSERT INTO task_versions (seq, version, title, body, author, ts) VALUES (4, 2, 'old version', 'old secret version', 'ada', 4_000)").run();
    memory("still true", 4, 8_000);
    memory("manual fact", null, 1_000);

    entry(5, 1_000, "(removed by ada)", { purged: JSON.stringify({ by: "ada", via: "person" }) });
    memory("(removed by ada)", 5, 1_000);
    forward(5, 12, "purged-secret");

    const n = await board.prune(5_000);
    expect(n).toBe(1);

    const e1 = db.prepare("SELECT text, title, author, reply_to, retained_at FROM entries WHERE seq = 1").get() as { text: string; title: null; author: string; reply_to: number; retained_at: number };
    expect(e1.text).toBe(BLANK);
    expect(e1.title).toBeNull();
    expect(e1.author).toBe("ada");
    expect(e1.reply_to).toBe(2);
    expect(e1.retained_at).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM entry_versions WHERE seq = 1").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM search_idx WHERE kind = 'entry' AND ref = '1'").get()).toEqual({ n: 0 });

    const t1 = db.prepare("SELECT title, body, done_note, status, assignee, lease_holder, lease_until, stop_reason, priority, due, version FROM tasks WHERE seq = 1").get() as Record<string, unknown>;
    expect(t1.title).toBe(BLANK);
    expect(t1.body).toBeNull();
    expect(t1.done_note).toBeNull();
    expect(t1.status).toBe("doing");
    expect(t1.assignee).toBe("ada");
    expect(t1.lease_holder).toBe("ada");
    expect(t1.lease_until).toBe(9_000);
    expect(t1.stop_reason).toBe("hold");
    expect(t1.priority).toBe("high");
    expect(t1.due).toBe(8_000);
    expect(t1.version).toBe(4);
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_versions WHERE seq = 1").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM search_idx WHERE kind = 'task' AND ref = '1'").get()).toEqual({ n: 0 });

    const facts = db.prepare("SELECT text, source_seq, struck_by, struck_ts IS NOT NULL AS struck FROM memory ORDER BY id").all() as { text: string; source_seq: number | null; struck_by: string | null; struck: number }[];
    expect(facts[0]).toMatchObject({ text: BLANK, source_seq: 1, struck_by: "retention", struck: 1 });
    expect(facts[1]).toMatchObject({ text: BLANK, source_seq: 1, struck_by: "ada", struck: 1 });
    expect(facts[2]).toMatchObject({ text: "live fact", source_seq: 2, struck: 0 });
    expect(facts[3]).toMatchObject({ text: BLANK, source_seq: 3, struck_by: "retention", struck: 1 });
    expect(facts[4]).toMatchObject({ text: "still true", source_seq: 4, struck: 0 });
    expect(facts[5]).toMatchObject({ text: "manual fact", source_seq: null, struck: 0 });
    expect(facts[6]).toMatchObject({ text: "(removed by ada)", source_seq: 5, struck: 0 });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'mem_v'").get()).toEqual({ value: "1" });

    const t2 = db.prepare("SELECT title, body, done_note FROM tasks WHERE seq = 2").get();
    expect(t2).toEqual({ title: "live title", body: "live body", done_note: "live note" });
    expect(db.prepare("SELECT text FROM entries WHERE seq = 2").get()).toEqual({ text: "live message" });

    const t3 = db.prepare("SELECT title, body FROM tasks WHERE seq = 3").get();
    expect(t3).toEqual({ title: BLANK, body: null });
    const t4 = db.prepare("SELECT title, body, done_note, version FROM tasks WHERE seq = 4").get();
    expect(t4).toEqual({ title: "new plan", body: "rewritten after", done_note: "kept note", version: 4 });
    expect(db.prepare("SELECT title, body, ts FROM task_versions WHERE seq = 4 ORDER BY version").all()).toEqual([{ title: "new plan", body: "rewritten after", ts: 8_000 }]);
    expect(db.prepare("SELECT body FROM search_idx WHERE kind = 'task' AND ref = '4'").get()).toEqual({ body: "new plan\nrewritten after" });

    expect(db.prepare("SELECT text FROM entries WHERE seq = 5").get()).toEqual({ text: "(removed by ada)" });
    expect(calls.map((c) => c.srcSeq).sort()).toEqual([1, 3]);
    expect(calls.every((c) => c.replacement === RETAINED_QUOTE && c.dst === "b_other")).toBe(true);
    expect(quotes.get("b_other:10")).toContain(RETAINED_QUOTE);
    expect(quotes.get("b_other:10")).not.toContain("hunter2");
    expect(quotes.get("b_other:10")).toContain("> **jxn** · #99\n> noted");
    expect(quotes.get("b_other:10")).toContain("look at these");
    expect(quotes.get("b_other:11")).toContain("live-secret");
    expect(quotes.get("b_other:12")).toContain("purged-secret");
    expect(quotes.get("b_other:13")).toContain(RETAINED_QUOTE);
    expect(quotes.get("b_other:13")).not.toContain("leftover-secret");
    const left = directory.db.prepare("SELECT src_seq FROM forwards WHERE src_board = ? ORDER BY src_seq").all(BOARD_ID) as { src_seq: number }[];
    expect(left.map((r) => r.src_seq)).toEqual([2, 5]);
    expect(sent.some((s) => s.includes('"pruned"'))).toBe(true);

    const again = calls.length;
    expect(await board.prune(5_000)).toBe(0);
    expect(calls).toHaveLength(again);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'mem_v'").get()).toEqual({ value: "1" });
  });

  it("retries a quote whose destination could not be reached, then leaves it alone", async () => {
    const { board, db, directory, quotes, calls, forward, setFail } = openBoard();
    db.prepare("INSERT INTO entries (seq, ts, author, type, text) VALUES (1, 1_000, 'ada', 'note', 'secret one')").run();
    forward(1, 10, "hunter2");
    setFail(true);
    expect(await board.prune(5_000)).toBe(1);
    expect(calls).toHaveLength(0);
    expect(directory.db.prepare("SELECT COUNT(*) AS n FROM forwards").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM retention_forward_scrubbed").get()).toEqual({ n: 0 });
    expect(quotes.get("b_other:10")).toContain("hunter2");

    setFail(false);
    expect(await board.prune(5_000)).toBe(0);
    expect(calls).toEqual([{ dst: "b_other", dstSeq: 10, srcSeq: 1, replacement: RETAINED_QUOTE }]);
    expect(quotes.get("b_other:10")).not.toContain("hunter2");
    expect(directory.db.prepare("SELECT COUNT(*) AS n FROM forwards").get()).toEqual({ n: 0 });

    expect(await board.prune(5_000)).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("compacts a page across the D1 bind chunk without dropping a later derived row", async () => {
    const { board, db, directory, calls, forward } = openBoard();
    const n = D1_SEQ_CHUNK + 1;
    for (let seq = 1; seq <= n; seq++) {
      db.prepare("INSERT INTO entries (seq, ts, author, type, text, title) VALUES (?, 1_000, 'ada', 'note', ?, 't')").run(seq, `secret ${seq}`);
      db.prepare("INSERT INTO memory (text, norm, by_user, via, source_seq, ts, add_v) VALUES (?, ?, 'ada', 'person', ?, 1_000, 1)").run(`fact ${seq}`, `fact ${seq}`, seq);
      db.prepare("INSERT INTO tasks (seq, title, body, updated_at) VALUES (?, ?, ?, 1_000)").run(seq, `title ${seq}`, `body ${seq}`);
      db.prepare("INSERT INTO task_versions (seq, version, title, body, author, ts) VALUES (?, 1, ?, ?, 'ada', 1_000)").run(seq, `title ${seq}`, `body ${seq}`);
    }
    forward(1, 10, "first-secret");
    forward(n, 11, "last-secret");
    expect(await board.prune(5_000)).toBe(n);
    expect(db.prepare("SELECT COUNT(*) AS n FROM entries WHERE text = ?").get(BLANK)).toEqual({ n });
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory WHERE struck_ts IS NOT NULL AND text = ?").get(BLANK)).toEqual({ n });
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = ? AND body IS NULL").get(BLANK)).toEqual({ n });
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_versions").get()).toEqual({ n: 0 });
    expect(calls.map((c) => c.srcSeq).sort((a, b) => a - b)).toEqual([1, n]);
    expect(directory.db.prepare("SELECT COUNT(*) AS n FROM forwards").get()).toEqual({ n: 0 });
    expect(directory.binds.every((b) => b.count <= D1_BIND_LIMIT)).toBe(true);
  });
});
