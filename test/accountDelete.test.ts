import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
vi.stubGlobal("WebSocketRequestResponsePair", class {});
import { Board } from "../src/board";
import { checkDeleteCode, DELETE_CODE_TTL_MS, deleteAccount, isDeletedHandle, isTombstone, noteDeleteCodeSent, shownName, swapHandle, type BoardForget } from "../src/accountDelete";
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
/** Every table/column where any of `needles` still appears, anywhere in the value (handles in text, emails, JSON). */
function leftovers(db: any, ...needles: string[]): string[] {
  const out: string[] = [];
  for (const { name: t } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'oauth_clients'").all())
    for (const c of db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[])
      for (const n of needles)
        if ((db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE CAST("${c.name}" AS TEXT) LIKE ?`).get(`%${n}%`) as { n: number }).n) out.push(`${t}.${c.name}~${n}`);
  return out;
}

function fakeBoards(opts: { failForget?: Set<string>; failDestroy?: Set<string> } = {}) {
  const forgot: { id: string; tomb: string; title?: string | null }[] = [], destroyed: string[] = [];
  const stub = (id: string): BoardForget => ({
    forgetUser: async (_u, tomb, o) => {
      if (opts.failForget?.delete(id)) throw new Error(`DO ${id} unavailable`);
      forgot.push({ id, tomb, title: o?.title });
      return {};
    },
    destroy: async () => {
      if (opts.failDestroy?.delete(id)) throw new Error(`DO ${id} unavailable`);
      destroyed.push(id);
    },
  });
  return { stub, forgot, destroyed };
}

const board = (db: any, id: string, by: string, kind: string | null = null, extra: { title?: string; key?: string } = {}) =>
  db.prepare("INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity, kind, direct_key) VALUES (?, ?, ?, 1, 0, 1, ?, ?)").run(id, extra.title ?? id, by, kind, extra.key ?? null);
const member = (db: any, id: string, user: string, role = "contributor", at = 1, expires: number | null = null) =>
  db.prepare("INSERT INTO members (board_id, user, joined_at, last_seen, role, expires_at) VALUES (?, ?, ?, 1, ?, ?)").run(id, user, at, role, expires);
const user = (db: any, name: string, extra: { pro?: boolean; customer?: string } = {}) =>
  db.prepare(`INSERT OR REPLACE INTO users (name, email, first_seen, last_seen, workos_id, display_name, bio, plan, plan_status, stripe_customer, stripe_subscription) VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, `${name}@example.com`, `wos_${name}`, `${name} D`, "hi", extra.pro ? "pro" : "free", extra.pro ? "active" : null, extra.customer ?? null, extra.customer ? "sub_1" : null);
const tape = (db: any, boardId: string, author: string, excerpt = "hello") =>
  db.prepare("INSERT INTO tape (board_id, seq, ts, author, type, excerpt) VALUES (?, 1, 1, ?, 'note', ?)").run(boardId, author, excerpt);

describe("deleting an account (Apple 5.1.1(v), jxn #4329)", () => {
  it("leaves no trace of their handle or email anywhere: theirs is gone, what others keep points at the tombstone", async () => {
    const { env, db } = fakeEnv();
    seedEverything(db, "maya");
    user(db, "maya");
    user(db, "theo");
    board(db, "b_shared", "maya");
    member(db, "b_shared", "theo");
    member(db, "b_shared", "maya", "owner");
    // Free text and emails that name them (jxn's agent #4389).
    db.prepare("INSERT INTO audit (board_id, actor, action, target, detail, ts) VALUES ('b_shared', 'theo', 'invited', 'maya@example.com', NULL, 1)").run();
    db.prepare("INSERT INTO audit (board_id, actor, action, target, detail, ts) VALUES ('b_shared', 'theo', 'reported', '#3', 'maya: spam', 2)").run();
    db.prepare("INSERT INTO audit (board_id, actor, action, target, detail, ts) VALUES ('b_shared', 'theo', 'purge', '#4', 'note by maya', 3)").run();
    db.prepare("INSERT INTO audit (board_id, actor, action, target, detail, ts) VALUES ('b_shared', 'theo', 'purge', '#5', 'note by mayanne', 4)").run();
    db.prepare("INSERT INTO invites (id, board_id, email, invited_by, created_at, email_status, accepted_at, accepted_by) VALUES ('i1', 'b_shared', 'maya@example.com', 'theo', 1, 'sent', 2, 'maya')").run();
    // A conversation of two.
    board(db, "b_dm", "theo", "direct", { title: "maya ↔ theo", key: "maya|theo" });
    member(db, "b_dm", "maya");
    member(db, "b_dm", "theo");
    // A private board, with a tape and a notification excerpt that must go with it.
    board(db, "b_mine", "maya");
    member(db, "b_mine", "maya", "owner");
    tape(db, "b_mine", "maya", "my private plan");
    db.prepare("INSERT INTO notifications (user, board_id, seq, kind, actor, entry_type, excerpt, created_at) VALUES ('theo', 'b_mine', 1, 'mention', 'maya', 'note', 'my private plan', 1)").run();
    const { stub, forgot } = fakeBoards();
    const r = await deleteAccount(env, "maya", stub);
    expect(leftovers(db, "maya@example.com")).toEqual([]);
    expect(leftovers(db, "maya")).toEqual(["audit.detail~maya"]); // only "note by mayanne": someone else
    expect(db.prepare("SELECT detail FROM audit WHERE board_id = 'b_shared' AND actor = 'theo' ORDER BY ts").all().map((x: { detail: string | null }) => x.detail)).toEqual([null, `${r.tombstone}: spam`, `note by ${r.tombstone}`, "note by mayanne"]);
    expect(isTombstone(r.tombstone)).toBe(true);
    expect(db.prepare("SELECT created_by FROM boards WHERE id = 'b_shared'").get()).toEqual({ created_by: r.tombstone });
    expect(db.prepare("SELECT title, direct_key FROM boards WHERE id = 'b_dm'").get()).toEqual({ title: `${r.tombstone} ↔ theo`, direct_key: [r.tombstone, "theo"].sort().join("|") });
    expect(forgot.find((f) => f.id === "b_dm")?.title).toBe(`${r.tombstone} ↔ theo`);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tape WHERE board_id = 'b_mine'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE board_id = 'b_mine'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM invites").get()).toEqual({ n: 0 });
    expect(await isDeletedHandle(env, "maya")).toBe(true);
    expect(await isDeletedHandle(env, "Maya")).toBe(true);
    expect(await isDeletedHandle(env, "theo")).toBe(false);
    // Done: only a hash of the handle is kept, and no longer tied to the tombstone.
    expect(db.prepare("SELECT tombstone, deleted_at IS NOT NULL AS done FROM deleted_handles").all()).toEqual([{ tombstone: null, done: 1 }]);
  });

  it("a run that stops part way is finished by a retry, under the same tombstone", async () => {
    const { env, db } = fakeEnv();
    user(db, "maya");
    user(db, "theo");
    for (const id of ["b_1", "b_2"]) {
      board(db, id, "theo");
      member(db, id, "theo");
      member(db, id, "maya");
    }
    const fake = fakeBoards({ failForget: new Set(["b_2"]) });
    await expect(deleteAccount(env, "maya", fake.stub)).rejects.toThrow(/unavailable/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE name = 'maya'").get()).toEqual({ n: 1 }); // can sign in and retry
    const r = await deleteAccount(env, "maya", fake.stub);
    expect(new Set(fake.forgot.map((f) => f.tomb))).toEqual(new Set([r.tombstone]));
    expect(db.prepare("SELECT DISTINCT author FROM tape").all()).toEqual([]);
  });

  it("a board whose storage can't be destroyed keeps its row until a retry does it", async () => {
    const { env, db } = fakeEnv();
    user(db, "maya");
    board(db, "b_mine", "maya");
    member(db, "b_mine", "maya", "owner");
    const fake = fakeBoards({ failDestroy: new Set(["b_mine"]) });
    await expect(deleteAccount(env, "maya", fake.stub)).rejects.toThrow(/unavailable/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM boards WHERE id = 'b_mine'").get()).toEqual({ n: 1 });
    await deleteAccount(env, "maya", fake.stub);
    expect(fake.destroyed).toEqual(["b_mine"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM boards WHERE id = 'b_mine'").get()).toEqual({ n: 0 });
  });

  it("shared boards keep their messages; private ones go; a new owner is an active member, a contributor first", async () => {
    const { env, db } = fakeEnv();
    for (const u of ["maya", "theo", "ivy", "old"]) user(db, u);
    board(db, "b_shared", "maya");
    member(db, "b_shared", "maya", "owner", 1);
    member(db, "b_shared", "old", "contributor", 2, 5); // access long expired
    member(db, "b_shared", "ivy", "viewer", 3);
    member(db, "b_shared", "theo", "contributor", 9);
    board(db, "b_viewers", "maya");
    member(db, "b_viewers", "maya", "owner", 1);
    member(db, "b_viewers", "old", "contributor", 2, 5);
    member(db, "b_viewers", "ivy", "viewer", 3);
    board(db, "b_agent", "maya", "agent");
    member(db, "b_agent", "maya", "owner");
    board(db, "b_expired_only", "maya");
    member(db, "b_expired_only", "maya", "owner");
    member(db, "b_expired_only", "old", "contributor", 2, 5);
    const { stub, forgot, destroyed } = fakeBoards();
    const r = await deleteAccount(env, "maya", stub, 1000);
    expect(forgot.map((f) => f.id).sort()).toEqual(["b_shared", "b_viewers"]);
    expect(destroyed.sort()).toEqual(["b_agent", "b_expired_only"]);
    expect(r).toMatchObject({ boards_kept: 2, boards_removed: 2, owners_promoted: 2 });
    const role = (b: string, u: string) => (db.prepare("SELECT role FROM members WHERE board_id = ? AND user = ?").get(b, u) as { role: string } | undefined)?.role;
    expect(role("b_shared", "theo")).toBe("owner"); // the active contributor, not the expired one or the viewer
    expect(role("b_shared", "old")).toBe("contributor");
    expect(role("b_viewers", "ivy")).toBe("owner"); // only an active viewer is left
  });

  it("boards they left, were removed from or ran out of access on are rewritten too", async () => {
    const { env, db } = fakeEnv();
    user(db, "maya");
    user(db, "theo");
    board(db, "b_left", "theo");
    member(db, "b_left", "theo");
    tape(db, "b_left", "maya");
    const { stub, forgot } = fakeBoards();
    const r = await deleteAccount(env, "maya", stub);
    expect(forgot).toEqual([{ id: "b_left", tomb: r.tombstone, title: null }]);
    expect(db.prepare("SELECT author FROM tape WHERE board_id = 'b_left'").get()).toEqual({ author: r.tombstone });
    expect(db.prepare("SELECT role FROM members WHERE board_id = 'b_left' AND user = 'theo'").get()).toEqual({ role: "contributor" }); // untouched
  });

  it.each(["actor", "target"])("boards they left are rewritten after tape pruning when audit names them as %s", async (column) => {
    const { env, db } = fakeEnv();
    user(db, "maya");
    user(db, "theo");
    board(db, "b_left", "theo");
    member(db, "b_left", "theo");
    const { b, db: boardDb } = boardFixture();
    boardDb.prepare("INSERT INTO entries (seq, ts, author, type, text) VALUES (1, 1, 'maya', 'note', 'hello')").run();
    db.prepare("INSERT INTO audit (board_id, actor, action, target, detail, ts) VALUES ('b_left', ?, ?, ?, NULL, 1)")
      .run(column === "actor" ? "maya" : "theo", column === "actor" ? "left" : "removed", column === "target" ? "maya" : null);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tape").get()).toEqual({ n: 0 });
    const stub = vi.fn(() => b as unknown as BoardForget);
    const r = await deleteAccount(env, "maya", stub);
    expect(stub).toHaveBeenCalledWith("b_left");
    expect(r.boards_kept).toBe(1);
    expect(boardDb.prepare("SELECT author, text FROM entries").all()).toEqual([{ author: r.tombstone, text: "hello" }]);
  });

  it("rewrites only exact author tokens in report and purge details on their boards", async () => {
    const { env, db } = fakeEnv();
    user(db, "may");
    user(db, "theo");
    for (const id of ["b_shared", "b_other"]) {
      board(db, id, "theo");
      member(db, id, "theo");
    }
    member(db, "b_shared", "may");
    const details = [
      ["b_shared", "renamed", "plans for may"],
      ["b_shared", "renamed", "may: plans"],
      ["b_shared", "renamed", "note by may"],
      ["b_other", "reported", "may: spam"],
      ["b_other", "purge", "note by may"],
      ["b_shared", "reported", "may: may be spam"],
      ["b_shared", "purge", "note by may"],
      ["b_shared", "purge", "task by may, purged by their agent"],
      ["b_shared", "reported", "theo: may be spam"],
      ["b_shared", "reported", "mayanne: spam"],
      ["b_shared", "reported", "May: spam"],
      ["b_shared", "purge", "note by mayanne"],
      ["b_shared", "purge", "note by May"],
      ["b_shared", "purge", "note by may.other"],
      ["b_shared", "purge", "note by may with extra text"],
    ];
    for (const [id, action, detail] of details) {
      db.prepare("INSERT INTO audit (board_id, actor, action, target, detail, ts) VALUES (?, 'theo', ?, '#1', ?, 1)").run(id, action, detail);
    }
    const { stub, forgot } = fakeBoards();
    const r = await deleteAccount(env, "may", stub);
    expect(forgot.map((f) => f.id)).toEqual(["b_shared"]);
    const expected = details.map((row) => row[2]);
    expected[5] = `${r.tombstone}: may be spam`;
    expected[6] = `note by ${r.tombstone}`;
    expected[7] = `task by ${r.tombstone}, purged by their agent`;
    expect(db.prepare("SELECT detail FROM audit WHERE actor = 'theo' ORDER BY id").all().map((row: { detail: string }) => row.detail)).toEqual(expected);
  });

  it("a large account stays within D1's 100-value limit per statement", async () => {
    const { env, db, maxBinds } = fakeEnv();
    user(db, "maya");
    user(db, "theo");
    for (let i = 0; i < 300; i++) {
      board(db, `b_${i}`, i % 2 ? "theo" : "maya");
      member(db, `b_${i}`, "maya", i % 2 ? "contributor" : "owner");
      member(db, `b_${i}`, "theo");
      tape(db, `b_${i}`, "maya");
      db.prepare("INSERT INTO audit (board_id, actor, action, target, detail, ts) VALUES (?, 'theo', 'reported', '#1', 'maya: spam', 1)").run(`b_${i}`);
    }
    // More than one page of audit details on a single board, as well as more than 100 boards.
    for (let i = 0; i < 50; i++) {
      db.prepare("INSERT INTO audit (board_id, actor, action, target, detail, ts) VALUES ('b_0', 'theo', 'purge', '#1', 'note by maya', 1)").run();
    }
    const { stub, forgot } = fakeBoards();
    const r = await deleteAccount(env, "maya", stub);
    expect(forgot).toHaveLength(300);
    expect(r.owners_promoted).toBe(150);
    expect(maxBinds()).toBeLessThanOrEqual(100);
    expect(leftovers(db, "maya")).toEqual([]);
  });

  it("an active Pro plan keeps its Stripe ids for ops (not cancelled in code); a past customer doesn't flag", async () => {
    const { env, db } = fakeEnv();
    user(db, "maya", { pro: true, customer: "cus_123" });
    user(db, "theo", { customer: "cus_old" });
    expect((await deleteAccount(env, "maya", fakeBoards().stub)).stripe_followup).toBe(true);
    expect((await deleteAccount(env, "theo", fakeBoards().stub)).stripe_followup).toBe(false);
    expect(db.prepare("SELECT stripe_customer, stripe_subscription FROM deleted_handles WHERE stripe_customer IS NOT NULL").all()).toEqual([{ stripe_customer: "cus_123", stripe_subscription: "sub_1" }]);
  });

  it("deleting needs the code emailed to the account: none, a wrong one or an old one fails; a right one works once", async () => {
    const { env } = fakeEnv();
    const t0 = 1_000_000;
    // A stand-in for WorkOS magic auth: the code it emailed, to which address, and whether it's been used.
    const issued = new Map<string, { email: string; used: boolean }>();
    const verify = async (email: string, code: string) => {
      const c = issued.get(code);
      if (!c || c.used || c.email !== email) throw new Error("invalid_code");
      c.used = true;
      return { email };
    };
    // A stolen session or token alone: no code was ever sent for this account.
    expect(await checkDeleteCode(env, "maya", "maya@example.com", "123456", verify, t0)).toBe("none");
    await noteDeleteCodeSent(env, "maya", t0);
    issued.set("123456", { email: "maya@example.com", used: false });
    expect(await checkDeleteCode(env, "maya", "maya@example.com", "999999", verify, t0 + 1000)).toBe("bad"); // wrong
    expect(await checkDeleteCode(env, "maya", "maya@example.com", "12345", verify, t0 + 1000)).toBe("bad"); // not 6 digits
    expect(await checkDeleteCode(env, "maya", "maya@example.com", "123456", verify, t0 + DELETE_CODE_TTL_MS + 1)).toBe("expired"); // old
    expect(await checkDeleteCode(env, "maya", "maya@example.com", "123456", verify, t0 + 2000)).toBe("ok");
    expect(await checkDeleteCode(env, "maya", "maya@example.com", "123456", verify, t0 + 3000)).toBe("none"); // once
    // A code someone got for another address (their own) doesn't confirm maya's deletion.
    await noteDeleteCodeSent(env, "maya", t0 + 5000);
    issued.set("555555", { email: "thief@example.com", used: false });
    expect(await checkDeleteCode(env, "maya", "maya@example.com", "555555", verify, t0 + 6000)).toBe("bad");
    const lying = async (_e: string, _c: string) => ({ email: "thief@example.com" });
    expect(await checkDeleteCode(env, "maya", "maya@example.com", "555555", lying, t0 + 7000)).toBe("bad");
  });

  it("tombstones can't be registered, read as 'Deleted user', and a handle is swapped only as a whole word", () => {
    expect(isReservedUser("deleted-1a2b3c4d5e")).toBe(true);
    expect(isReservedUser("deleteduser")).toBe(false);
    expect(shownName("deleted-1a2b3c4d5e")).toBe("Deleted user");
    expect(shownName("theo")).toBe("theo");
    expect(swapHandle("maya ↔ theo", "maya", "T")).toBe("T ↔ theo");
    expect(swapHandle("note by mayanne, and maya.", "maya", "T")).toBe("note by mayanne, and T.");
    expect(swapHandle("maya.bot was here", "maya", "T")).toBe("maya.bot was here");
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
type Forget = { forgetUser(u: string, t: string, o?: { title?: string | null }): Promise<{ entries: number }> };

describe("a board forgets a deleted member", () => {
  it("their messages stay under the tombstone; their reactions, mentions and read state follow", async () => {
    const { b, db } = boardFixture();
    const T = "deleted-0011223344";
    db.prepare("INSERT INTO members (name, cursor, joined_at, last_seen) VALUES ('maya', 3, 1, 1), ('theo', 3, 1, 1)").run();
    db.prepare("INSERT INTO entries (seq, ts, author, type, text, mentions, to_people) VALUES (1, 1, 'maya', 'note', 'hello all', NULL, NULL)").run();
    db.prepare(`INSERT INTO entries (seq, ts, author, type, text, mentions, to_people) VALUES (2, 1, 'theo', 'note', '@maya look', '[{"user":"maya","agent":false}]', '["maya","theo"]')`).run();
    db.prepare("INSERT INTO reactions (seq, user, emoji, ts) VALUES (2, 'maya', '👍', 1)").run();
    const r = await (b as unknown as Forget).forgetUser("maya", T);
    expect(r.entries).toBe(1);
    expect(db.prepare("SELECT author FROM entries WHERE seq = 1").get()).toEqual({ author: T });
    const e2 = db.prepare("SELECT mentions, to_people FROM entries WHERE seq = 2").get() as { mentions: string; to_people: string };
    expect(JSON.parse(e2.mentions)).toEqual([{ user: T, agent: false }]);
    expect(JSON.parse(e2.to_people)).toEqual([T, "theo"]);
    expect(db.prepare("SELECT user FROM reactions").all()).toEqual([{ user: T }]);
    expect(db.prepare("SELECT name FROM members ORDER BY name").all()).toEqual([{ name: "theo" }]);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'created_by'").get()).toEqual({ value: T });
  });

  it("purges, sealed secrets, lapsed leases, JSON and a conversation's title follow too (jxn's agent #4389)", async () => {
    const { b, db } = boardFixture();
    const T = "deleted-5566778899";
    db.prepare("INSERT INTO members (name, cursor, joined_at, last_seen) VALUES ('maya', 3, 1, 1), ('theo', 3, 1, 1)").run();
    db.prepare(`INSERT INTO entries (seq, ts, author, type, text, purged, sealed_to, data) VALUES (1, 1, 'theo', 'note', 'x', '{"by":"maya","via":"person"}', 'maya', '{"people":["maya/alt-b","theo"]}')`).run();
    db.prepare("INSERT INTO tasks (seq, status, updated_at, lapsed_holder) VALUES (1, 'todo', 1, 'maya/alt-b')").run();
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('title', 'maya ↔ theo')").run();
    await (b as unknown as Forget).forgetUser("maya", T, { title: `${T} ↔ theo` });
    const e = db.prepare("SELECT purged, sealed_to, data FROM entries WHERE seq = 1").get() as { purged: string; sealed_to: string; data: string };
    expect(JSON.parse(e.purged)).toEqual({ by: T, via: "person" });
    expect(e.sealed_to).toBe(T);
    expect(JSON.parse(e.data)).toEqual({ people: [`${T}/alt-b`, "theo"] });
    expect(db.prepare("SELECT lapsed_holder FROM tasks").get()).toEqual({ lapsed_holder: `${T}/alt-b` });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'title'").get()).toEqual({ value: `${T} ↔ theo` });
  });
});
