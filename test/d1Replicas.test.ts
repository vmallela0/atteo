// D1 read replicas (vedu #6581, src/replicas.ts). A fake D1 with a primary and one replica that lags until it's told to
// catch up, and Sessions that follow D1's rules: "first-primary" sends the first query to the primary, every later read
// may go to the replica but only once it has caught up to the Session's bookmark, writes always go to the primary.
// What must hold: the switch off changes nothing; on, only the hot board GETs get a Session; the sign-in lookup is on the
// primary and the access check sees every removal, demotion and revocation made before the request, however far the
// replica lags; a client reads its own writes; the response carries the Session's bookmark.
import { describe, expect, it } from "vitest";
import { begin, isHotRead, readSession, stamp, BOOKMARK_HEADER } from "../src/replicas";
import { boardAccess, boardMembers } from "../src/registry";
import { createToken, getSession, sha256hex, tokenIdentity } from "../src/auth";
import { meterD1, type Hops } from "../src/devHops";
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
const schema = () => {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  return db;
};
const isWrite = (sql: string) => !/^\s*(SELECT|WITH)\b/i.test(sql);
const bm = (v: number) => `00000000-${v.toString(16).padStart(8, "0")}`; // sortable, like D1's bookmarks
const ver = (b: string) => parseInt(b.split("-")[1], 16);

type How = "first" | "all" | "run" | "raw";
type Runner = (sql: string, args: unknown[], how: How, col?: string) => Promise<unknown>;
interface Served { sql: string; by: "primary" | "replica"; session: boolean }

function replicated() {
  const primary = schema(), replica = schema();
  const log: { sql: string; args: unknown[] }[] = []; // every write on the primary, in order: its version is log.length
  let rv = 0; // how far the replica has applied the log
  const served: Served[] = [];
  let sessions = 0;
  const catchUp = (to: number) => {
    for (; rv < Math.min(to, log.length); rv++) {
      const q = positional(log[rv].sql, log[rv].args);
      replica.prepare(q.sql).run(...q.args);
    }
  };
  const on = (db: any, sql: string, args: unknown[], how: How, col: string | undefined, primaryServed: boolean) => {
    const q = positional(sql, args);
    const st = db.prepare(q.sql);
    const meta = { served_by_primary: primaryServed, changes: 0 };
    if (how === "first") {
      const row = st.get(...q.args) ?? null;
      return col === undefined ? row : (row?.[col] ?? null);
    }
    if (how === "raw") return st.all(...q.args).map((r: Record<string, unknown>) => Object.values(r));
    if (how === "all") return { results: st.all(...q.args), meta, success: true };
    const i = st.run(...q.args);
    return { results: [], meta: { ...meta, changes: i.changes ?? 0 }, success: true };
  };
  const onPrimary = (sql: string, args: unknown[], how: How, col?: string, session = false) => {
    served.push({ sql, by: "primary", session });
    const r = on(primary, sql, args, how, col, true);
    if (isWrite(sql)) log.push({ sql, args });
    return r;
  };
  const stmt = (run: Runner, sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(run, sql, a),
    first: (col?: string) => run(sql, args, "first", col),
    all: () => run(sql, args, "all"),
    run: () => run(sql, args, "run"),
    raw: () => run(sql, args, "raw"),
    _q: { sql, args },
  });
  const runPrimary: Runner = async (sql, args, how, col) => onPrimary(sql, args, how, col);
  const db = {
    prepare: (sql: string) => stmt(runPrimary, sql),
    batch: async (stmts: any[]) => stmts.map((s) => onPrimary(s._q.sql, s._q.args, "run")),
    withSession(c: string = "first-unconstrained") {
      sessions++;
      let bookmark: number | null = c === "first-primary" || c === "first-unconstrained" ? null : ver(c);
      const run: Runner = async (sql, args, how, col) => {
        if (isWrite(sql) || (bookmark == null && c === "first-primary")) {
          const r = onPrimary(sql, args, how, col, true);
          bookmark = Math.max(bookmark ?? 0, log.length);
          return r;
        }
        if (bookmark != null) catchUp(bookmark); // a replica answers only once it has caught up to the bookmark
        served.push({ sql, by: "replica", session: true });
        const r = on(replica, sql, args, how, col, false);
        bookmark = Math.max(bookmark ?? 0, rv);
        return r;
      };
      return {
        prepare: (sql: string) => stmt(run, sql),
        batch: async (stmts: any[]) => Promise.all(stmts.map((s) => run(s._q.sql, s._q.args, "all"))),
        getBookmark: () => (bookmark == null ? null : bm(bookmark)),
      };
    },
  };
  const env = { DB: db, D1_REPLICAS: "1" } as unknown as Env;
  const sync = () => catchUp(log.length);
  return { env, db, primary, replica, log, served, sync, sessions: () => sessions, version: () => log.length, replicaVersion: () => rv };
}

const B = "b_aaaaaaaa";
const hot = (path = `/api/boards/${B}/updates`, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, { headers });
const w = (env: Env, sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).run();

/** A board B owned by "own" with member "bob", and a signed-in web session for each; the replica caught up. */
async function world() {
  const f = replicated();
  for (const u of ["own", "bob", "carol"]) await w(f.env, `INSERT INTO users (name, email, email_verified, first_seen, last_seen) VALUES (?, ?, 1, 0, 0)`, u, `${u}@example.com`);
  await w(f.env, `INSERT INTO boards (id, title, created_by, created_at, last_activity) VALUES (?, ?, ?, 0, 0)`, B, "B", "own");
  await w(f.env, `INSERT INTO members (board_id, user, joined_at, last_seen, role) VALUES (?, ?, 0, 0, 'owner')`, B, "own");
  await w(f.env, `INSERT INTO members (board_id, user, joined_at, last_seen, role) VALUES (?, ?, 1, 0, 'contributor')`, B, "bob");
  for (const u of ["own", "bob"])
    await w(f.env, `INSERT INTO sessions (id_hash, user, workos_id, email, email_verified, created_at, expires_at) VALUES (?, ?, 'w', ?, 1, 0, ?)`, await sha256hex(`secret-${u}`), u, `${u}@example.com`, Date.now() + 3_600_000);
  f.sync();
  return f;
}
const cookie = (u: string) => ({ cookie: `ab_session=secret-${u}` });

/** One hot request's env, as index.ts builds it: the Session's db in place of env.DB. */
function request(f: ReturnType<typeof replicated>, req: Request) {
  const rs = begin(f.env, req);
  if (!rs) throw new Error("expected a replica Session");
  return { rs, env: { ...f.env, DB: rs.db } as Env };
}

describe("the switch", () => {
  it("off (unset, or anything but 1): no Session for any request, env.DB untouched", async () => {
    for (const v of [undefined, "", "0", "true"]) {
      const f = await world();
      const env = { ...f.env, D1_REPLICAS: v } as Env;
      for (const p of [`/b/${B}`, `/api/boards/${B}/updates`, `/api/boards/${B}/entries`]) expect(begin(env, hot(p))).toBeNull();
      expect(f.sessions()).toBe(0);
    }
  });
  it("a binding without Sessions (an old local runtime): off", () => {
    const env = { DB: { prepare() {}, batch() {} }, D1_REPLICAS: "1" } as unknown as Env;
    expect(begin(env, hot())).toBeNull();
  });
  it("on: only GETs of the board page, /updates and /entries; every write, MCP, sign-in, token and OAuth route stays on the primary", async () => {
    for (const p of [`/b/${B}`, `/api/boards/${B}/updates`, `/api/boards/${B}/entries`, `/api/boards/${B}/entries/12`]) expect(isHotRead("GET", p), p).toBe(true);
    for (const [m, p] of [
      ["POST", `/api/boards/${B}/entries`], ["PATCH", `/api/boards/${B}/entries/12`], ["DELETE", `/api/boards/${B}/entries/12`], ["POST", `/b/${B}`],
      ["GET", "/mcp"], ["POST", "/mcp"], ["GET", "/api/tokens"], ["POST", "/oauth/token"], ["GET", "/oauth/authorize"], ["GET", "/auth/callback"],
      ["GET", `/api/boards/${B}/invites`], ["GET", `/api/boards/${B}/members`], ["GET", `/b/${B}/call`], ["GET", "/api/boards"], ["GET", "/b/not-a-board"],
      ["GET", `/api/boards/${B}/entries/12/history`],
    ] as const) expect(isHotRead(m, p), `${m} ${p}`).toBe(false);
    const f = await world();
    expect(begin(f.env, new Request(`http://localhost/api/boards/${B}/entries`, { method: "POST" }))).toBeNull();
    expect(begin(f.env, hot(`/b/${B}`))).not.toBeNull();
  });
});

describe("security reads see everything committed before the request, however far the replica lags", () => {
  it("the sign-in lookup goes to the primary (the Session's first query), then the rest read the replica", async () => {
    const f = await world();
    const { env } = request(f, hot());
    const before = f.served.length;
    const session = await getSession(hot(`/api/boards/${B}/updates`, cookie("bob")), env);
    expect(session?.user).toBe("bob");
    await boardAccess(env, B, "bob");
    await boardMembers(env, B);
    expect(f.served.slice(before).map((s) => s.by)).toEqual(["primary", "replica", "replica"]);
    expect(f.served[before].sql).toMatch(/FROM sessions/);
  });
  it("a member removed just before: refused, though the replica still has them", async () => {
    const f = await world();
    await w(f.env, `DELETE FROM members WHERE board_id = ? AND user = ?`, B, "bob"); // committed, not yet on the replica
    // The lag is real: a Session that may start on the replica still lets bob in.
    const loose = { ...f.env, DB: f.db.withSession("first-unconstrained") } as unknown as Env;
    expect((await boardAccess(loose, B, "bob")).member).toBe(true);
    const { env } = request(f, hot());
    expect(await getSession(hot(undefined, cookie("own")), env)).toBeTruthy(); // anyone's sign-in: the first query
    expect(await boardAccess(env, B, "bob")).toMatchObject({ member: false, role: null });
    expect(f.served.at(-1)).toMatchObject({ by: "replica", session: true }); // and still from the replica, caught up
  });
  it("a demotion just before: the access check reads the new role", async () => {
    const f = await world();
    await w(f.env, `UPDATE members SET role = 'viewer' WHERE board_id = ? AND user = ?`, B, "bob");
    const { env } = request(f, hot());
    await getSession(hot(undefined, cookie("bob")), env);
    expect((await boardAccess(env, B, "bob")).role).toBe("viewer");
  });
  it("a board deleted just before: gone", async () => {
    const f = await world();
    await w(f.env, `UPDATE boards SET deleted_at = 5 WHERE id = ?`, B);
    const { env } = request(f, hot());
    await getSession(hot(undefined, cookie("own")), env);
    expect(await boardAccess(env, B, "own")).toMatchObject({ exists: false, member: false });
  });
  it("a token revoked just before: not valid (its lookup is the request's first query, on the primary)", async () => {
    const f = await world();
    const { id, token } = await createToken(f.env, "bob", "test");
    f.sync();
    await w(f.env, `UPDATE tokens SET revoked_at = ? WHERE id = ?`, Date.now(), id);
    const loose = { ...f.env, DB: f.db.withSession("first-unconstrained") } as unknown as Env;
    expect(await tokenIdentity(loose, token, true)).toMatchObject({ user: "bob" }); // the lagging replica would accept it
    const { env } = request(f, hot(undefined, { authorization: `Bearer ${token}` }));
    expect(await tokenIdentity(env, token, true)).toBeNull();
    expect(f.served.at(-1)).toMatchObject({ by: "primary", session: true });
  });
  it("a client's bookmark is never where the Session starts (it can't pull the sign-in lookup back onto a stale replica)", async () => {
    const f = await world();
    const old = bm(1); // a bookmark from long ago, or a made-up one
    await w(f.env, `DELETE FROM sessions WHERE user = ?`, "bob"); // signed out everywhere
    const { env } = request(f, hot(undefined, { ...cookie("bob"), [BOOKMARK_HEADER]: old }));
    expect(await getSession(hot(undefined, { ...cookie("bob"), [BOOKMARK_HEADER]: old }), env)).toBeNull();
  });
});

describe("read-your-writes and the bookmark", () => {
  it("a write (on the primary, outside any Session) shows in the writer's next hot read while the replica lags", async () => {
    const f = await world();
    // POST: no Session, plain primary.
    expect(begin(f.env, new Request(`http://localhost/api/boards/${B}/members`, { method: "POST" }))).toBeNull();
    await w(f.env, `INSERT INTO members (board_id, user, joined_at, last_seen, role) VALUES (?, ?, 2, 0, 'contributor')`, B, "carol");
    expect(f.replicaVersion()).toBeLessThan(f.version());
    const { env } = request(f, hot(`/b/${B}`));
    await getSession(hot(`/b/${B}`, cookie("own")), env);
    expect((await boardMembers(env, B)).map((m) => m.user)).toEqual(["own", "bob", "carol"]);
    expect(f.served.at(-1)?.by).toBe("replica");
  });
  it("round trip: the response carries the Session's bookmark (≥ every write before the request), fresher each request", async () => {
    const f = await world();
    const one = request(f, hot());
    const v1 = f.version();
    await getSession(hot(undefined, cookie("own")), one.env);
    await boardMembers(one.env, B);
    const r1 = stamp(new Response("{}"), one.rs);
    const b1 = r1.headers.get(BOOKMARK_HEADER)!;
    expect(ver(b1)).toBeGreaterThanOrEqual(v1);
    expect(r1.headers.get("x-d1-served")).toBe("primary=0 replica=1"); // the sign-in lookup is a first(): no meta to count
    await w(f.env, `UPDATE boards SET title = 'B2' WHERE id = ?`, B);
    const two = request(f, hot(undefined, { [BOOKMARK_HEADER]: b1 }));
    await getSession(hot(undefined, cookie("own")), two.env);
    const b2 = stamp(new Response("{}"), two.rs).headers.get(BOOKMARK_HEADER)!;
    expect(b2 > b1).toBe(true); // bookmarks sort oldest to newest
  });
  it("no reads, no header; an immutable response is copied", async () => {
    const f = await world();
    const { rs, env } = request(f, hot());
    expect(stamp(new Response("x"), rs).headers.has(BOOKMARK_HEADER)).toBe(false);
    await getSession(hot(undefined, cookie("own")), env);
    const frozen = Response.redirect("http://localhost/x", 302); // headers immutable
    expect(stamp(frozen, rs).headers.get(BOOKMARK_HEADER)).toBeTruthy();
  });
});

describe("inside a hot GET", () => {
  it("writes go to the primary outside the Session, so its bookmark doesn't move and later reads don't wait on them", async () => {
    const f = await world();
    const { rs, env } = request(f, hot());
    await getSession(hot(undefined, cookie("own")), env);
    const b = rs.bookmark();
    await env.DB.prepare(`UPDATE users SET last_seen = ? WHERE name = ?`).bind(9, "own").run();
    expect(f.served.at(-1)).toMatchObject({ by: "primary", session: false });
    expect(rs.bookmark()).toBe(b);
    await boardMembers(env, B);
    expect(f.served.at(-1)?.by).toBe("replica");
  });
  it("a batch of reads goes to the Session; a batch with a write, to the primary", async () => {
    const f = await world();
    const { env } = request(f, hot());
    await getSession(hot(undefined, cookie("own")), env);
    await env.DB.batch([env.DB.prepare(`SELECT 1 AS x`), env.DB.prepare(`SELECT name FROM users WHERE name = ?`).bind("own")]);
    expect(f.served.slice(-2).map((s) => s.by)).toEqual(["replica", "replica"]);
    await env.DB.batch([env.DB.prepare(`SELECT 1 AS x`), env.DB.prepare(`UPDATE users SET last_seen = 1 WHERE name = ?`).bind("own")]);
    expect(f.served.slice(-2)).toMatchObject([{ by: "primary", session: false }, { by: "primary", session: false }]);
  });
  it("first(col), all, run and raw answer as on plain D1", async () => {
    const f = await world();
    const { env } = request(f, hot());
    await getSession(hot(undefined, cookie("own")), env);
    expect(await env.DB.prepare(`SELECT title FROM boards WHERE id = ?`).bind(B).first("title")).toBe("B");
    expect((await env.DB.prepare(`SELECT user FROM members WHERE board_id = ? ORDER BY joined_at`).bind(B).all()).results).toEqual([{ user: "own" }, { user: "bob" }]);
    expect(await env.DB.prepare(`SELECT user FROM members WHERE board_id = ? ORDER BY joined_at`).bind(B).raw()).toEqual([["own"], ["bob"]]);
  });
});

describe("the hop meter (DEV_HOPS) sees a Session's queries", () => {
  it("its first query costs the primary's delay; the rest count as replica reads", async () => {
    const f = await world();
    const hops: Hops = { d1: 0, do: 0 };
    const log: string[] = [];
    const metered = meterD1(f.env.DB, hops, 0, (x) => log.push(x), 0);
    const rs = readSession(metered);
    const env = { ...f.env, DB: rs.db } as Env;
    await getSession(hot(undefined, cookie("own")), env);
    await boardAccess(env, B, "own");
    await boardMembers(env, B);
    await env.DB.prepare(`UPDATE users SET last_seen = 3 WHERE name = 'own'`).run();
    expect(hops).toEqual({ d1: 4, do: 0, replica: 2 });
    expect(log.map((x) => x.split(" ").slice(0, 2).join(" "))).toEqual(["d1 SELECT", "d1 (replica)", "d1 (replica)", "d1 UPDATE"]);
  });
});
