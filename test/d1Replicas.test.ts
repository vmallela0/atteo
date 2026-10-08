// D1 read replicas (vedu #6581, src/replicas.ts). A fake D1 with a primary and one replica that lags until it's told to
// catch up, and Sessions that follow D1's rules: "first-primary" sends the first query to the primary, every later read
// may go to the replica but only once it has caught up to the Session's bookmark, writes always go to the primary.
// What must hold: the switch off changes nothing; on, only the hot board GETs get a Session, and only the presentational
// reads a call site opts in to use it; nothing that decides access or visibility ever reads the replica, even for a
// change committed after the request's Session took its bookmark; a client reads its own writes; the response carries
// the Session's bookmark.
import { describe, expect, it } from "vitest";
import { begin, isHotRead, presentational, readSession, stamp, withRole, BOOKMARK_HEADER } from "../src/replicas";
import { boardAccess, boardMembers, isMember, memberRole, pendingInvites } from "../src/registry";
import { mutedOn } from "../src/moderation";
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

/** One hot request's env, as index.ts builds it: env.DB the primary, DB_REPLICA the Session (its anchor already sent). */
function request(f: ReturnType<typeof replicated>, req: Request) {
  const rs = begin(f.env, req);
  if (!rs) throw new Error("expected a replica Session");
  const env = { ...f.env, DB_REPLICA: rs.db } as Env;
  return { rs, env, pres: presentational(env) };
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

describe("live delivery stays on the primary (vedu-push-entry review)", () => {
  it("the WebSocket upgrade (its role check) gets no Session: plain env.DB, the primary", async () => {
    const f = await world();
    for (const p of [`/api/boards/${B}/ws`, `/b/${B}/ws`]) {
      expect(isHotRead("GET", p), p).toBe(false);
      expect(begin(f.env, new Request(`http://localhost${p}`, { headers: { upgrade: "websocket", ...cookie("bob") } }))).toBeNull();
    }
    expect(f.sessions()).toBe(0);
  });
  it("only the Worker's fetch opens a Session: never the board Durable Object (live pushes, its member reads) or anything else", () => {
    const { readFileSync: read, readdirSync: ls } = { readFileSync, readdirSync };
    const src = new URL("../src/", dir);
    const users = ls(src)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /withSession\s*\(|from "\.\/replicas"/.test(read(new URL(f, src), "utf8")));
    // replicas.ts makes the Session; index.ts calls replicas.begin in fetch() (devHops.ts only meters one it's handed).
    expect(users.sort()).toEqual(["index.ts", "replicas.ts"]);
    const index = read(new URL("index.ts", src), "utf8");
    expect(index.match(/replicas\.begin\(/g)).toHaveLength(1);
    expect(read(new URL("board.ts", src), "utf8")).not.toMatch(/withSession|replicas/);
  });
});

describe("a lagging replica never decides access or visibility, even for a change inside the request's window", () => {
  /** A hot request whose Session has taken its bookmark; then `change` commits on the primary (the 40–150 ms window, or
   *  any time later), and the replica never catches up past the bookmark. */
  async function inWindow(change: (f: ReturnType<typeof replicated>) => Promise<unknown>) {
    const f = await world();
    const r = request(f, hot(`/b/${B}`));
    const anchored = f.version();
    await change(f);
    expect(f.version()).toBeGreaterThan(anchored); // committed after the bookmark: a replica at the bookmark doesn't have it
    return { f, ...r };
  }
  const allPrimarySince = (f: ReturnType<typeof replicated>, from: number) => expect(f.served.slice(from).every((x) => x.by === "primary" && !x.session)).toBe(true);

  it("the anchor is the Session's first query, on the primary; nothing else has touched the Session", async () => {
    const f = await world();
    const before = f.served.length;
    const { rs } = request(f, hot());
    expect(f.served.slice(before)).toEqual([{ sql: "SELECT 1 AS anchor", by: "primary", session: true }]);
    expect(rs.bookmark()).toBe(bm(f.version()));
  });
  it("a member removed inside the window: refused (membership, role, isMember), while the replica would still list them", async () => {
    const { f, env, pres } = await inWindow((f) => w(f.env, `DELETE FROM members WHERE board_id = ? AND user = ?`, B, "bob"));
    const from = f.served.length;
    expect(await getSession(hot(undefined, cookie("bob")), env)).toBeTruthy();
    expect(await boardAccess(env, B, "bob")).toMatchObject({ member: false, role: null });
    expect(await memberRole(env, B, "bob")).toBeNull();
    expect(await isMember(env, B, "bob")).toBe(false);
    allPrimarySince(f, from);
    // The replica is genuinely behind: the displayed list (presentational) may still show bob. It decides nothing.
    expect((await boardMembers(pres, B)).map((m) => m.user)).toContain("bob");
    expect(f.served.at(-1)).toMatchObject({ by: "replica", session: true });
  });
  it("a demotion inside the window: the access row says viewer, and the page's own row for the viewer follows it", async () => {
    const { f, env, pres } = await inWindow((f) => w(f.env, `UPDATE members SET role = 'viewer' WHERE board_id = ? AND user = ?`, B, "bob"));
    const access = await boardAccess(env, B, "bob");
    expect(access.role).toBe("viewer");
    const shown = await boardMembers(pres, B);
    expect(shown.find((m) => m.user === "bob")?.role).toBe("contributor"); // stale on the replica
    expect(withRole(shown, "bob", access.role).find((m) => m.user === "bob")?.role).toBe("viewer"); // what the page uses
    expect(f.served.filter((x) => /AS role FROM boards/.test(x.sql)).every((x) => x.by === "primary" && !x.session)).toBe(true);
  });
  it("a board deleted inside the window: gone", async () => {
    const { env } = await inWindow((f) => w(f.env, `UPDATE boards SET deleted_at = 5 WHERE id = ?`, B));
    expect(await boardAccess(env, B, "own")).toMatchObject({ exists: false, member: false });
  });
  it("a token revoked or a session ended inside the window: not valid", async () => {
    const f0 = await world();
    const { id, token } = await createToken(f0.env, "bob", "test");
    f0.sync();
    const { env } = request(f0, hot(undefined, { authorization: `Bearer ${token}` }));
    await w(f0.env, `UPDATE tokens SET revoked_at = ? WHERE id = ?`, Date.now(), id);
    await w(f0.env, `DELETE FROM sessions WHERE user = ?`, "own");
    expect(await tokenIdentity(env, token, true)).toBeNull();
    expect(await getSession(hot(undefined, cookie("own")), env)).toBeNull();
  });
  it("an invite revoked and a mute added inside the window: the page reads both on the primary", async () => {
    const f = await world();
    await w(f.env, `INSERT INTO invites (id, board_id, email, invited_by, created_at, email_status) VALUES ('i1', ?, 'x@example.com', 'own', 0, 'sent')`, B);
    f.sync();
    const { env } = request(f, hot(`/b/${B}`));
    await w(f.env, `DELETE FROM invites WHERE id = 'i1'`);
    await w(f.env, `INSERT INTO mutes (user, board_id, muted, created_at) VALUES ('own', ?, 'bob', 0)`, B);
    const from = f.served.length;
    expect(await pendingInvites(env, B)).toEqual([]);
    expect(await mutedOn(env, "own", B)).toEqual(["bob"]);
    allPrimarySince(f, from);
  });
  it("withRole: the viewer's row always carries the primary's role (removed: dropped; missing: added)", () => {
    const list = [{ user: "own", role: "owner" }, { user: "bob", role: "contributor" }];
    expect(withRole(list, "bob", "viewer")).toEqual([{ user: "own", role: "owner" }, { user: "bob", role: "viewer" }]);
    expect(withRole(list, "bob", null)).toEqual([{ user: "own", role: "owner" }]);
    expect(withRole(list, "carol", "contributor").map((m) => [m.user, m.role])).toEqual([["own", "owner"], ["bob", "contributor"], ["carol", "contributor"]]);
  });
});

describe("which reads may use the replica: an explicit, presentational allow-list (src/index.ts)", () => {
  const src = new URL("../src/", dir);
  const index = readFileSync(new URL("index.ts", src), "utf8");
  // Every call handed the replica env: `fn(pres, …)` or `fn(replicas.presentational(env), …)`, or `pres.DB.prepare(sql)`.
  const handed = [...index.matchAll(/([\w.]+)\((?:pres|replicas\.presentational\(env\))[,)]/g)].map((m) => m[1]);
  const prepared = [...index.matchAll(/pres\.DB\.prepare\(`([^`]*)`/g)].map((m) => m[1]);
  it("only display reads: members shown, presence, sidebar, names, the board row, rules shown, Slack channels", () => {
    const allowed = new Set([
      "registry.boardMembers", "sessions.onBoard", "machines.forUsers", "sideBoardsNamed", "registry.agentsOnBoard", "registry.agentStatus",
      "registry.getBoard", "approvalRules.list", "registry.userByEmail", "sessions.list", "social.boardAgentNames",
    ]);
    expect(handed.length).toBeGreaterThan(10);
    expect(handed.filter((f) => !allowed.has(f))).toEqual([]);
    expect(prepared).toEqual(["SELECT channel_name FROM slack_links WHERE board_id = ? AND paused IS NULL"]);
  });
  it("never a gating read: access, membership, role, invites, mutes, sign-in, tokens", () => {
    const gating = /(?:boardAccess|accessOf|canSee|memberRole|isMember|pendingInvites|mutedOn|getSession|loadViewer|tokenIdentity|resolveToken|userForToken)\((?:pres|replicas\.presentational)/;
    for (const f of readdirSync(src).filter((f) => f.endsWith(".ts"))) expect(readFileSync(new URL(f, src), "utf8"), f).not.toMatch(gating);
  });
  it("DB_REPLICA is set in one place and read only through presentational()", () => {
    const users = readdirSync(src).filter((f) => f.endsWith(".ts") && /DB_REPLICA/.test(readFileSync(new URL(f, src), "utf8")));
    expect(users.sort()).toEqual(["index.ts", "replicas.ts", "types.ts"]);
    expect(index.match(/DB_REPLICA/g)).toHaveLength(2); // the comment and the one assignment in fetch()
    expect(index).toMatch(/DB_REPLICA: retryingReads\(rs\.db\)/);
  });
});

describe("read-your-writes and the bookmark", () => {
  it("a write before the request shows in the replica reads (they wait for the anchor's bookmark)", async () => {
    const f = await world();
    await w(f.env, `INSERT INTO members (board_id, user, joined_at, last_seen, role) VALUES (?, ?, 2, 0, 'contributor')`, B, "carol");
    expect(f.replicaVersion()).toBeLessThan(f.version());
    const { pres } = request(f, hot(`/b/${B}`));
    expect((await boardMembers(pres, B)).map((m) => m.user)).toEqual(["own", "bob", "carol"]);
    expect(f.served.at(-1)?.by).toBe("replica");
  });
  it("round trip: the response carries the Session's bookmark (≥ every write before the request), fresher each request", async () => {
    const f = await world();
    const one = request(f, hot());
    const v1 = f.version();
    await boardMembers(one.pres, B);
    const r1 = stamp(new Response("{}"), one.rs);
    const b1 = r1.headers.get(BOOKMARK_HEADER)!;
    expect(ver(b1)).toBeGreaterThanOrEqual(v1);
    expect(r1.headers.get("x-d1-served")).toBe("primary=1 replica=1"); // the anchor, then the members list
    await w(f.env, `UPDATE boards SET title = 'B2' WHERE id = ?`, B);
    const two = request(f, hot(undefined, { [BOOKMARK_HEADER]: b1 }));
    const b2 = stamp(new Response("{}"), two.rs).headers.get(BOOKMARK_HEADER)!;
    expect(b2 > b1).toBe(true); // bookmarks sort oldest to newest
  });
  it("a client's bookmark is never where the Session starts", async () => {
    const f = await world();
    request(f, hot(undefined, { [BOOKMARK_HEADER]: bm(1) }));
    expect(f.served.at(-1)).toMatchObject({ sql: "SELECT 1 AS anchor", by: "primary", session: true });
  });
  it("an immutable response is copied", async () => {
    const f = await world();
    const { rs } = request(f, hot());
    expect(stamp(Response.redirect("http://localhost/x", 302), rs).headers.get(BOOKMARK_HEADER)).toBeTruthy();
  });
});

describe("the replica env", () => {
  it("off: presentational(env) is env itself", async () => {
    const f = await world();
    const env = { ...f.env, D1_REPLICAS: undefined } as Env;
    expect(presentational(env)).toBe(env);
  });
  it("writes through it go to the primary outside the Session, so its bookmark doesn't move", async () => {
    const f = await world();
    const { rs, pres } = request(f, hot());
    const b = rs.bookmark();
    await pres.DB.prepare(`UPDATE users SET last_seen = ? WHERE name = ?`).bind(9, "own").run();
    expect(f.served.at(-1)).toMatchObject({ by: "primary", session: false });
    expect(rs.bookmark()).toBe(b);
  });
  it("a batch of reads goes to the Session; a batch with a write, to the primary", async () => {
    const f = await world();
    const { pres } = request(f, hot());
    await pres.DB.batch([pres.DB.prepare(`SELECT 1 AS x`), pres.DB.prepare(`SELECT name FROM users WHERE name = ?`).bind("own")]);
    expect(f.served.slice(-2).map((s) => s.by)).toEqual(["replica", "replica"]);
    await pres.DB.batch([pres.DB.prepare(`SELECT 1 AS x`), pres.DB.prepare(`UPDATE users SET last_seen = 1 WHERE name = ?`).bind("own")]);
    expect(f.served.slice(-2)).toMatchObject([{ by: "primary", session: false }, { by: "primary", session: false }]);
  });
  it("first(col), all and raw answer as on plain D1", async () => {
    const f = await world();
    const { pres } = request(f, hot());
    expect(await pres.DB.prepare(`SELECT title FROM boards WHERE id = ?`).bind(B).first("title")).toBe("B");
    expect((await pres.DB.prepare(`SELECT user FROM members WHERE board_id = ? ORDER BY joined_at`).bind(B).all()).results).toEqual([{ user: "own" }, { user: "bob" }]);
    expect(await pres.DB.prepare(`SELECT user FROM members WHERE board_id = ? ORDER BY joined_at`).bind(B).raw()).toEqual([["own"], ["bob"]]);
  });
});

describe("the hop meter (DEV_HOPS) sees a Session's queries", () => {
  it("its first query costs the primary's delay; the rest count as replica reads", async () => {
    const f = await world();
    const hops: Hops = { d1: 0, do: 0 };
    const log: string[] = [];
    const rs = readSession(meterD1(f.env.DB, hops, 0, (x) => log.push(x), 0));
    const pres = presentational({ ...f.env, DB_REPLICA: rs.db } as Env);
    await pres.DB.prepare(`SELECT 1 AS anchor`).all();
    await boardMembers(pres, B);
    await pres.DB.prepare(`UPDATE users SET last_seen = 3 WHERE name = 'own'`).run();
    expect(hops).toEqual({ d1: 3, do: 0, replica: 1 });
    expect(log.map((x) => x.split(" ").slice(0, 2).join(" "))).toEqual(["d1 SELECT", "d1 (replica)", "d1 UPDATE"]);
  });
});
