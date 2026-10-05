import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
vi.stubGlobal("WebSocketRequestResponsePair", class {});
import { Board } from "../src/board";
import { deleteAccount, isDeletedHandle, isTombstone, shownName, type BoardForget } from "../src/accountDelete";
import { isReservedUser } from "../src/bugBoard";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

const dbs: any[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

// D1 as node:sqlite. Each statement may bind at most 100 values, as in production (miniflare allows more).
function fakeEnv() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  let maxBinds = 0;
  const stmt = (sql: string, args: unknown[] = []): any => {
    maxBinds = Math.max(maxBinds, args.length);
    if (args.length > 100) throw new Error(`D1: too many SQL variables (${args.length})`);
    return {
      bind: (...a: unknown[]) => stmt(sql, a),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => ({ results: [], meta: { changes: db.prepare(sql).run(...args).changes } }),
      _run: () => db.prepare(sql).run(...args),
    };
  };
  const DB = { prepare: (sql: string) => stmt(sql), batch: async (list: any[]) => list.map((s) => s._run()) };
  return { env: { DB } as unknown as Env, db, maxBinds: () => maxBinds };
}

/** One row naming `who` in every column of every table that refers to a person, so nothing is missed. */
const PERSON_COL = /^(user|name|a|b|author|to_user|actor|target|reporter|requested_by|invited_by|accepted_by|added_by|created_by|last_author|deleted_by|granted_by|approved_by|holder|muted|scope_id)$/;
function seedEverything(db: any, who: string) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations', 'deleted_handles')").all().map((r: { name: string }) => r.name);
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string; notnull: number; pk: number }[];
    if (!cols.some((c) => PERSON_COL.test(c.name)) || t === "oauth_clients") continue; // an OAuth app's name, not a person
    const vals = cols.map((c) => (PERSON_COL.test(c.name) ? who : /INT/i.test(c.type) ? (c.pk && c.name === "id" ? null : 1) : c.name === "email" ? "v@example.com" : c.name === "scope" ? "person" : "x"));
    db.prepare(`INSERT OR IGNORE INTO ${t} (${cols.map((c) => c.name).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
  }
}
/** Every table/column still holding `who` exactly. */
function leftovers(db: any, who: string): string[] {
  const out: string[] = [];
  for (const { name: t } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all())
    for (const c of db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[])
      if (t !== "oauth_clients" && (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE "${c.name}" = ?`).get(who) as { n: number }).n) out.push(`${t}.${c.name}`);
  return out;
}

function fakeBoards() {
  const forgot: string[] = [], destroyed: string[] = [];
  const stub = (id: string): BoardForget => ({ forgetUser: async () => (forgot.push(id), {}), destroy: async () => void destroyed.push(id) });
  return { stub, forgot, destroyed };
}

const board = (db: any, id: string, by: string, kind: string | null = null) =>
  db.prepare("INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity, kind) VALUES (?, ?, ?, 1, 0, 1, ?)").run(id, id, by, kind);
const member = (db: any, id: string, user: string, role = "contributor", at = 1) =>
  db.prepare("INSERT INTO members (board_id, user, joined_at, last_seen, role) VALUES (?, ?, ?, 1, ?)").run(id, user, at, role);
const user = (db: any, name: string, extra: Record<string, unknown> = {}) =>
  db.prepare(`INSERT OR REPLACE INTO users (name, email, first_seen, last_seen, workos_id, display_name, bio${extra.stripe_customer ? ", stripe_customer" : ""}) VALUES (?, ?, 1, 1, ?, ?, ?${extra.stripe_customer ? ", ?" : ""})`).run(name, `${name}@example.com`, `wos_${name}`, `${name} D`, "hi", ...(extra.stripe_customer ? [extra.stripe_customer] : []));

describe("deleting an account (Apple 5.1.1(v), jxn #4329)", () => {
  it("leaves no row anywhere naming them: theirs is gone, what others keep points at the tombstone", async () => {
    const { env, db } = fakeEnv();
    seedEverything(db, "maya");
    user(db, "maya");
    user(db, "theo");
    board(db, "b_shared", "maya");
    member(db, "b_shared", "theo");
    member(db, "b_shared", "maya", "owner");
    const { stub } = fakeBoards();
    const r = await deleteAccount(env, "maya", stub);
    expect(leftovers(db, "maya")).toEqual([]);
    expect(isTombstone(r.tombstone)).toBe(true);
    expect(db.prepare("SELECT created_by FROM boards WHERE id = 'b_shared'").get()).toEqual({ created_by: r.tombstone });
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'maya@example.com' OR workos_id = 'wos_maya'").get()).toEqual({ n: 0 });
    expect(await isDeletedHandle(env, "maya")).toBe(true);
    expect(await isDeletedHandle(env, "Maya")).toBe(true);
    expect(await isDeletedHandle(env, "theo")).toBe(false);
    // only a hash of the handle is kept
    expect(JSON.stringify(db.prepare("SELECT * FROM deleted_handles").all())).not.toContain("maya");
  });

  it("shared boards keep their messages; private ones go; a board left without an owner gets one", async () => {
    const { env, db } = fakeEnv();
    user(db, "maya");
    user(db, "theo");
    user(db, "ivy");
    board(db, "b_shared", "maya");
    member(db, "b_shared", "maya", "owner", 1);
    member(db, "b_shared", "theo", "contributor", 5);
    member(db, "b_shared", "ivy", "viewer", 9);
    board(db, "b_agent", "maya", "agent");
    member(db, "b_agent", "maya", "owner");
    board(db, "b_alone", "maya");
    member(db, "b_alone", "maya", "owner");
    const { stub, forgot, destroyed } = fakeBoards();
    const r = await deleteAccount(env, "maya", stub);
    expect(forgot).toEqual(["b_shared"]);
    expect(destroyed.sort()).toEqual(["b_agent", "b_alone"]);
    expect(r).toMatchObject({ boards_kept: 1, boards_removed: 2, owners_promoted: 1 });
    expect(db.prepare("SELECT role FROM members WHERE board_id = 'b_shared' AND user = 'theo'").get()).toEqual({ role: "owner" }); // longest-standing
    expect(db.prepare("SELECT COUNT(*) AS n FROM boards WHERE id IN ('b_agent', 'b_alone')").get()).toEqual({ n: 0 });
  });

  it("a large account stays within D1's 100-value limit per statement", async () => {
    const { env, db, maxBinds } = fakeEnv();
    user(db, "maya");
    user(db, "theo");
    for (let i = 0; i < 300; i++) {
      board(db, `b_${i}`, i % 2 ? "theo" : "maya");
      member(db, `b_${i}`, "maya", i % 2 ? "contributor" : "owner");
      member(db, `b_${i}`, "theo");
      db.prepare("INSERT INTO tape (board_id, seq, ts, author, type, excerpt) VALUES (?, 1, 1, 'maya', 'note', 'hello')").run(`b_${i}`);
    }
    const { stub, forgot } = fakeBoards();
    const r = await deleteAccount(env, "maya", stub);
    expect(forgot).toHaveLength(300);
    expect(r.owners_promoted).toBe(150);
    expect(maxBinds()).toBeLessThanOrEqual(100);
    expect(leftovers(db, "maya")).toEqual([]);
  });

  it("flags a Pro customer for a manual Stripe follow-up rather than cancelling in code", async () => {
    const { env, db } = fakeEnv();
    user(db, "maya", { stripe_customer: "cus_123" });
    const r = await deleteAccount(env, "maya", fakeBoards().stub);
    expect(r.stripe_followup).toBe(true);
  });

  it("tombstones can't be registered, and read as 'Deleted user'", () => {
    expect(isReservedUser("deleted-1a2b3c4d5e")).toBe(true);
    expect(isReservedUser("deleteduser")).toBe(false);
    expect(shownName("deleted-1a2b3c4d5e")).toBe("Deleted user");
    expect(shownName("theo")).toBe("theo");
  });
});

// The board's own copy: its Durable Object storage, as node:sqlite.
function boardFixture() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  const sql = { exec(query: string, ...args: unknown[]) {
    let rows: any[] = [];
    if (/CREATE TABLE IF NOT EXISTS meta/.test(query)) db.exec(query);
    else {
      const st = db.prepare(query);
      if (st.columns().length) rows = st.all(...args);
      else st.run(...args);
    }
    return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  const state = { storage: { sql, deleteAll: async () => {} }, setWebSocketAutoResponse() {}, getWebSockets: () => [] };
  const b = new Board(state as unknown as DurableObjectState, {} as Env);
  (b as unknown as { ctx: unknown }).ctx = state; // the mocked DurableObject base doesn't keep it
  (b as unknown as { setMeta(k: string, v: string): void }).setMeta("id", "b_test");
  (b as unknown as { setMeta(k: string, v: string): void }).setMeta("created_by", "maya");
  return { b, db };
}

describe("a board forgets a deleted member", () => {
  it("their messages stay under the tombstone; their reactions, mentions and read state follow", async () => {
    const { b, db } = boardFixture();
    const T = "deleted-0011223344";
    db.prepare("INSERT INTO members (name, cursor, joined_at, last_seen) VALUES ('maya', 3, 1, 1), ('theo', 3, 1, 1)").run();
    db.prepare("INSERT INTO entries (seq, ts, author, type, text, mentions, to_people) VALUES (1, 1, 'maya', 'note', 'hello all', NULL, NULL)").run();
    db.prepare(`INSERT INTO entries (seq, ts, author, type, text, mentions, to_people) VALUES (2, 1, 'theo', 'note', '@maya look', '[{"user":"maya","agent":false}]', '["maya","theo"]')`).run();
    db.prepare("INSERT INTO reactions (seq, user, emoji, ts) VALUES (2, 'maya', '👍', 1)").run();
    const r = await (b as unknown as { forgetUser(u: string, t: string): Promise<{ entries: number }> }).forgetUser("maya", T);
    expect(r.entries).toBe(1);
    expect(db.prepare("SELECT author FROM entries WHERE seq = 1").get()).toEqual({ author: T });
    const e2 = db.prepare("SELECT mentions, to_people FROM entries WHERE seq = 2").get() as { mentions: string; to_people: string };
    expect(JSON.parse(e2.mentions)).toEqual([{ user: T, agent: false }]);
    expect(JSON.parse(e2.to_people)).toEqual([T, "theo"]);
    expect(db.prepare("SELECT user FROM reactions").all()).toEqual([{ user: T }]);
    expect(db.prepare("SELECT name FROM members ORDER BY name").all()).toEqual([{ name: "theo" }]);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'created_by'").get()).toEqual({ value: T });
  });
});
