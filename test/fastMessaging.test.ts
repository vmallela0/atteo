// Faster messaging (vedu #6564): the reads a post and a live update make were folded together, so each one must still
// answer exactly what the separate reads did. And the bench's hop meter (src/devHops.ts) counts what it says it counts.
import { describe, expect, it, vi } from "vitest";
import { boardAccess, deletedAt, memberRole } from "../src/registry";
import { createToken, tokenIdentity } from "../src/auth";
import { meter, meterD1, meterDO, stamp } from "../src/devHops";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

/** node:sqlite binds `?` only; D1 also takes `?1`. */
function positional(sql: string, args: unknown[]): { sql: string; args: unknown[] } {
  if (!/\?\d/.test(sql)) return { sql, args };
  const used: unknown[] = [];
  return { sql: sql.replace(/\?(\d+)/g, (_m, n) => (used.push(args[Number(n) - 1]), "?")), args: used };
}
function fakeEnv() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => { const q = positional(sql, args); return db.prepare(q.sql).get(...q.args) ?? null; },
    all: async () => { const q = positional(sql, args); return { results: db.prepare(q.sql).all(...q.args) }; },
    run: async () => { const q = positional(sql, args); const i = db.prepare(q.sql).run(...q.args); return { results: [], meta: { changes: i.changes ?? 0 } }; },
  });
  const env = { DB: { prepare: (sql: string) => stmt(sql), batch: async (s: any[]) => Promise.all(s.map((x) => x.run())) } } as unknown as Env;
  return { env, db };
}
const user = (db: any, name: string) => db.prepare(`INSERT INTO users (name, email, email_verified, first_seen, last_seen) VALUES (?, ?, 1, 0, 0)`).run(name, `${name}@example.com`);
const board = (db: any, id: string, by: string) => db.prepare(`INSERT INTO boards (id, title, created_by, created_at, last_activity) VALUES (?, ?, ?, 0, 0)`).run(id, id, by);
const member = (db: any, id: string, name: string, role = "contributor", expires: number | null = null) =>
  db.prepare(`INSERT INTO members (board_id, user, joined_at, last_seen, role, expires_at) VALUES (?, ?, 0, 0, ?, ?)`).run(id, name, role, expires);

describe("boardAccess: one read answers the soft-delete guard, the viewer guard and canSee", () => {
  const B = "b_aaaaaaaa";
  it("matches deletedAt and memberRole for every kind of viewer", async () => {
    const { env, db } = fakeEnv();
    for (const u of ["own", "con", "vie", "old", "out"]) user(db, u);
    board(db, B, "own");
    member(db, B, "own", "owner");
    member(db, B, "con");
    member(db, B, "vie", "viewer");
    member(db, B, "old", "contributor", Date.now() - 1000); // access expired
    const cases: [string | null, boolean, string | null][] = [["own", true, "owner"], ["con", true, "contributor"], ["vie", true, "viewer"], ["old", false, null], ["out", false, null], [null, false, null]];
    for (const [u, isMember, role] of cases) {
      const a = await boardAccess(env, B, u);
      expect(a, String(u)).toEqual({ exists: true, member: isMember, role, deleted_at: null });
      if (u) expect(a.role).toBe(await memberRole(env, B, u));
    }
    expect(await deletedAt(env, B)).toBeNull();
  });
  it("a deleted board: there for the deleted guard (its time), gone for everything else", async () => {
    const { env, db } = fakeEnv();
    user(db, "own");
    board(db, B, "own");
    member(db, B, "own", "owner");
    db.prepare(`UPDATE boards SET deleted_at = 1234 WHERE id = ?`).run(B);
    expect(await boardAccess(env, B, "own")).toEqual({ exists: false, member: false, role: null, deleted_at: 1234 });
    expect(await deletedAt(env, B)).toBe(1234);
    expect(await memberRole(env, B, "own")).toBeNull();
  });
  it("a board that was never there", async () => {
    const { env } = fakeEnv();
    expect(await boardAccess(env, "b_nothere1", "own")).toEqual({ exists: false, member: false, role: null, deleted_at: null });
  });
});

describe("tokenIdentity: the user comes with the token when it's read fresh", () => {
  it("a write reads the token and its user in one query; the cache serves only the token", async () => {
    const { env, db } = fakeEnv();
    user(db, "ag");
    db.prepare(`UPDATE users SET display_name = 'Agnes' WHERE name = 'ag'`).run();
    const { token } = await createToken(env, "ag", "test");
    const prepare = vi.spyOn(env.DB, "prepare");
    const fresh = await tokenIdentity(env, token, true);
    expect(fresh).toMatchObject({ user: "ag", userRow: { name: "ag", email: "ag@example.com", display_name: "Agnes" } });
    expect(prepare.mock.calls.filter(([sql]) => /FROM tokens/.test(sql))).toHaveLength(1);
    expect(prepare.mock.calls.some(([sql]) => /FROM users WHERE name/.test(sql))).toBe(false);
    // Within the cache window a read (not fresh) gets the token without its user: the caller reads the user as before.
    const cached = await tokenIdentity(env, token, false);
    expect(cached?.user).toBe("ag");
    expect(cached && "userRow" in cached).toBe(false);
  });
  it("a token whose user is gone has no user row (the viewer is null, as before)", async () => {
    const { env, db } = fakeEnv();
    user(db, "gone");
    const { token } = await createToken(env, "gone", "test");
    db.prepare(`DELETE FROM users WHERE name = 'gone'`).run();
    expect(await tokenIdentity(env, token, true)).toMatchObject({ user: "gone", userRow: null });
  });
  it("the once-a-minute last-used write goes to waitUntil when there's a ctx (it used to hold up the request)", async () => {
    const { env, db } = fakeEnv();
    user(db, "bg");
    const { token } = await createToken(env, "bg", "test");
    const waitUntil = vi.fn();
    await tokenIdentity(env, token, true, { waitUntil } as unknown as ExecutionContext);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });
});

describe("the hop meter (scripts/bench-messaging.mjs)", () => {
  it("counts each D1 query and each batch as one round trip, and logs them", async () => {
    const { env } = fakeEnv();
    const hops = { d1: 0, do: 0 }, log: string[] = [];
    const db = meterD1(env.DB, hops, 0, (w) => log.push(w));
    await db.prepare("SELECT 1 AS x").first();
    await db.prepare("SELECT ? AS x").bind(2).all();
    await db.batch([db.prepare("SELECT 1 AS x"), db.prepare("SELECT 2 AS x")]);
    expect(hops).toEqual({ d1: 3, do: 0 });
    expect(log).toEqual(["d1 SELECT 1 AS x", "d1 SELECT ? AS x", "d1 batch of 2"]);
  });
  it("counts each call on a Durable Object stub (not getting the stub)", async () => {
    const hops = { d1: 0, do: 0 };
    const stub = { snapshot: async (n: number) => n + 1, id: "x" };
    const ns = meterDO({ idFromName: (n: string) => n, get: () => stub } as unknown as DurableObjectNamespace, hops, 0);
    const s = ns.get(ns.idFromName("b")) as unknown as typeof stub;
    expect(await s.snapshot(1)).toBe(2);
    expect(s.id).toBe("x");
    expect(hops).toEqual({ d1: 0, do: 1 });
  });
  it("is off unless DEV_HOPS=1 on localhost, and stamps the header (not on a socket upgrade)", () => {
    const { env } = fakeEnv();
    const on = { ...env, BOARD: {} as DurableObjectNamespace, DEV_HOPS: "1" } as Env;
    expect(meter(env, new Request("http://localhost:8640/health"))).toBeNull();
    expect(meter(on, new Request("https://atteo.dev/health"))).toBeNull();
    const m = meter(on, new Request("http://localhost:8640/health"));
    expect(m).not.toBeNull();
    expect(stamp(new Response("ok"), { d1: 2, do: 1 }).headers.get("x-dev-hops")).toBe("d1=2 do=1");
  });
});
