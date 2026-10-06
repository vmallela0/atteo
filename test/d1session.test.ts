import { beforeEach, describe, expect, it } from "vitest";
import { createToken, forgetUserTokens, getSession, resolveToken, setSessionUser, sha256hex } from "../src/auth";
import { attachReadSession, continueRead, readDb, sessionBookmark } from "../src/d1session";
import { boardAccess, isMember, memberRole, setMemberAccess } from "../src/registry";
import { retryingReads } from "../src/retry";
import { get, liveByBoard, onBoard, resetLiveCache } from "../src/sessions";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as {
  readFileSync: (p: string | URL, enc: string) => string;
  readdirSync: (p: string | URL) => string[];
};
const migrations = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

/** node:sqlite binds `?` only. D1 also uses `?1`; expand those to positional `?`. */
function positional(sql: string, args: unknown[]): { sql: string; args: unknown[] } {
  if (!/\?\d/.test(sql)) return { sql, args };
  const used: unknown[] = [];
  const next = sql.replace(/\?(\d+)/g, (_m, n) => {
    used.push(args[Number(n) - 1]);
    return "?";
  });
  return { sql: next, args: used };
}

type Via = "primary" | "session";
interface Query { sql: string; via: Via }

/**
 * A D1 stand-in over the real schema. `withSession` records the constraint and serves the same rows,
 * tagged so a test can see which handle ran the statement. `sessions: false` is miniflare: no Sessions API.
 */
function directory(opts: { sessions?: boolean; throwOnOpen?: boolean } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, migrations), "utf8"));
  const queries: Query[] = [];
  const constraints: string[] = [];
  let n = 0;
  const make = (via: Via) => {
    let queried = false;
    const id = ++n;
    const stmt = (sql: string, args: unknown[] = []): any => ({
      bind: (...a: unknown[]) => stmt(sql, a),
      first: async () => {
        queried = true;
        queries.push({ sql, via });
        const q = positional(sql, args);
        return sqlite.prepare(q.sql).get(...(q.args as [])) ?? null;
      },
      all: async () => {
        queried = true;
        queries.push({ sql, via });
        const q = positional(sql, args);
        return { results: sqlite.prepare(q.sql).all(...(q.args as [])) };
      },
      run: async () => {
        queried = true;
        queries.push({ sql, via });
        const q = positional(sql, args);
        const info = sqlite.prepare(q.sql).run(...(q.args as []));
        return { results: [], meta: { changes: info.changes ?? 0 } };
      },
      raw: async () => {
        queried = true;
        queries.push({ sql, via });
        return [];
      },
    });
    const handle: any = {
      prepare: (sql: string) => stmt(sql),
      batch: async (list: any[]) => Promise.all(list.map((s) => s.run())),
      // Null until a query on THIS handle, matching D1DatabaseSession.getBookmark.
      getBookmark: () => (queried ? `bm-${id}` : null),
    };
    if (via === "primary" && opts.throwOnOpen) handle.withSession = () => { throw new Error("Sessions API unavailable"); };
    else if (via === "primary" && opts.sessions !== false) handle.withSession = (constraint: string) => {
      constraints.push(constraint);
      return make("session");
    };
    return handle;
  };
  const raw = make("primary");
  const envFor = () => ({ DB: retryingReads(raw as unknown as D1Database), PUBLIC_URL: "https://atteo.dev" }) as Env;
  return { sqlite, queries, constraints, envFor };
}

const BOARD = "b_aaaaaaaa";
const AGENT = "as_abcdefghijkl";

function cookie(secret: string): Request {
  return new Request("https://atteo.dev/", { headers: { cookie: `ab_session=${secret}` } });
}

async function seed(sqlite: any) {
  const now = Date.now();
  sqlite.prepare(`INSERT INTO users (name, email, email_verified, first_seen, last_seen) VALUES (?, ?, 1, 0, 0)`).run("ada", "ada@example.com");
  sqlite.prepare(`INSERT INTO users (name, email, email_verified, first_seen, last_seen) VALUES (?, ?, 1, 0, 0)`).run("bob", "bob@example.com");
  sqlite.prepare(`INSERT INTO boards (id, title, created_by, created_at, last_activity) VALUES (?, ?, ?, 0, 0)`).run(BOARD, "directory", "ada");
  sqlite.prepare(`INSERT INTO members (board_id, user, joined_at, last_seen, role) VALUES (?, ?, 0, 0, 'owner')`).run(BOARD, "ada");
  sqlite.prepare(`INSERT INTO sessions (id_hash, user, workos_id, email, email_verified, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)`).run(await sha256hex("cookie-ada"), "ada", "w_ada", "ada@example.com", now, now + 86_400_000);
  sqlite.prepare(`INSERT INTO sessions (id_hash, user, workos_id, email, email_verified, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)`).run(await sha256hex("cookie-bob"), "bob", "w_bob", "bob@example.com", now, now + 86_400_000);
  sqlite.prepare(`INSERT INTO sessions (id_hash, user, workos_id, email, email_verified, created_at, expires_at) VALUES (?, ?, ?, ?, 1, ?, ?)`).run(await sha256hex("cookie-old"), "ada", "w_ada", "ada@example.com", now, 1);
  sqlite.prepare(`INSERT INTO agent_sessions (id, user, name, client, boards, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(AGENT, "ada", "claude", "claude", JSON.stringify([BOARD]), now, now);
}

beforeEach(() => {
  resetLiveCache();
  forgetUserTokens("ada");
  forgetUserTokens("bob");
});

describe("bookmark absent", () => {
  it("starts each request at the primary, and a second attach cannot retarget it", async () => {
    const d = directory();
    await seed(d.sqlite);
    const env = d.envFor();
    attachReadSession(env);
    attachReadSession(env);
    expect(await getSession(cookie("cookie-ada"), env)).toMatchObject({ user: "ada" });
    expect(d.constraints).toEqual(["first-primary"]);
    expect(d.queries.some((q) => q.via === "session" && q.sql.includes("FROM sessions"))).toBe(true);
  });

  it("does not remember a session on a long-lived binding", () => {
    const d = directory();
    const env = d.envFor();
    readDb(env);
    readDb(env);
    expect(d.constraints).toEqual(["first-primary", "first-primary"]);
  });

  it("uses env.DB when withSession is missing (miniflare)", async () => {
    const d = directory({ sessions: false });
    await seed(d.sqlite);
    const env = d.envFor();
    attachReadSession(env);
    expect(await getSession(cookie("cookie-ada"), env)).toMatchObject({ user: "ada" });
    expect(await isMember(env, BOARD, "ada")).toBe(true);
    expect(d.constraints).toEqual([]);
    expect(d.queries.every((q) => q.via === "primary")).toBe(true);
  });

  it("uses env.DB when withSession throws", async () => {
    const d = directory({ throwOnOpen: true });
    await seed(d.sqlite);
    const env = d.envFor();
    attachReadSession(env);
    expect(await memberRole(env, BOARD, "ada")).toBe("owner");
    expect(d.constraints).toEqual([]);
    expect(d.queries.every((q) => q.via === "primary")).toBe(true);
  });

  it("retries a session read through a dropped connection", async () => {
    let fails = 1;
    const session = {
      prepare: (sql: string) => {
        const stmt = {
          bind: () => stmt,
          first: async () => {
            if (sql.startsWith("SELECT") && fails) {
              fails--;
              throw new Error("D1_ERROR: Network connection lost.");
            }
            return { id_hash: "h", user: "ada", workos_id: "w", email: "a@b.c", email_verified: 1, display_name: null, expires_at: Date.now() + 1000, u_name: "ada", u_email: null, u_display_name: null, u_display: null };
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
          raw: async () => [],
        };
        return stmt;
      },
      getBookmark: () => "bm-retry",
    };
    const primary = {
      prepare: () => { throw new Error("primary handled a read"); },
      batch: async () => [],
      withSession: (c: string) => {
        expect(c).toBe("first-primary");
        return session;
      },
    };
    const env = { DB: retryingReads(primary as unknown as D1Database) } as Env;
    attachReadSession(env);
    expect((await getSession(cookie("cookie-ada"), env))?.user).toBe("ada");
    expect(fails).toBe(0);
  });
});

describe("bookmark present", () => {
  it("sends a bookmark only for the request that observed it", async () => {
    const d = directory();
    await seed(d.sqlite);
    // Two requests, one binding: the case a shared isolate bookmark would get wrong.
    const ada = d.envFor();
    const bob = d.envFor();
    attachReadSession(ada);
    attachReadSession(bob);
    expect((await getSession(cookie("cookie-ada"), ada))?.user).toBe("ada");
    expect((await getSession(cookie("cookie-bob"), bob))?.user).toBe("bob");
    expect(await getSession(cookie("cookie-old"), ada)).toBeNull();
    const bm = sessionBookmark(ada);
    expect(bm).toMatch(/^bm-/);
    expect(sessionBookmark(bob)).not.toBe(bm);

    const own = continueRead(ada, bm);
    const foreign = continueRead(bob, bm);
    continueRead(ada, "bm-from-someone-else");
    expect(await own.prepare(`SELECT user FROM members WHERE board_id = ? AND user = ?`).bind(BOARD, "ada").first()).toMatchObject({ user: "ada" });
    expect(await own.prepare(`SELECT user FROM members WHERE board_id = ? AND user = ?`).bind(BOARD, "bob").first()).toBeNull();
    expect(await foreign.prepare(`SELECT user FROM sessions WHERE user = ?`).bind("bob").first()).toMatchObject({ user: "bob" });

    expect(d.constraints).toEqual(["first-primary", "first-primary", bm, "first-primary", "first-primary"]);
    expect(d.constraints.filter((c) => c === bm)).toEqual([bm]);
  });

  it("ignores a bookmark before this request has observed one", async () => {
    const d = directory();
    await seed(d.sqlite);
    const env = d.envFor();
    attachReadSession(env);
    expect(sessionBookmark(env)).toBeNull();
    continueRead(env, "bm-early");
    expect(d.constraints).toEqual(["first-primary", "first-primary"]);
  });
});

describe("read-only call sites", () => {
  it("reads membership and agent sessions on the session, and writes on the primary", async () => {
    const d = directory();
    await seed(d.sqlite);
    const env = d.envFor();
    attachReadSession(env);
    expect(await isMember(env, BOARD, "ada")).toBe(true);
    expect(await isMember(env, BOARD, "bob")).toBe(false);
    expect(await memberRole(env, BOARD, "bob")).toBeNull();
    expect(await boardAccess(env, BOARD, "ada")).toEqual({ exists: true, member: true, role: "owner" });
    expect(await boardAccess(env, BOARD, "bob")).toEqual({ exists: true, member: false, role: null });
    expect((await get(env, "ada", AGENT))?.name).toBe("claude");
    expect(await onBoard(env, BOARD)).toEqual([expect.objectContaining({ user: "ada", name: "claude" })]);
    expect((await liveByBoard(env)).get(BOARD)).toBe(1);

    const { token } = await createToken(env, "ada", "cli");
    expect((await resolveToken(env, token)).user).toBe("ada");
    await setSessionUser(env, await sha256hex("cookie-ada"), "ada");
    await setMemberAccess(env, BOARD, "ada", { role: "contributor" });

    const selects = d.queries.filter((q) => /^\s*(SELECT|WITH)\b/i.test(q.sql));
    const writes = d.queries.filter((q) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(q.sql));
    expect(selects.length).toBeGreaterThan(0);
    expect(selects.every((q) => q.via === "session")).toBe(true);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((q) => q.via === "primary")).toBe(true);
    expect(d.constraints).toEqual(["first-primary"]);
  });

  it("answers the same lookups with no Sessions API", async () => {
    const d = directory({ sessions: false });
    await seed(d.sqlite);
    const env = d.envFor();
    attachReadSession(env);
    expect((await getSession(cookie("cookie-ada"), env))?.user).toBe("ada");
    expect(await isMember(env, BOARD, "bob")).toBe(false);
    expect((await get(env, "ada", AGENT))?.user).toBe("ada");
    expect((await liveByBoard(env)).get(BOARD)).toBe(1);
    expect(d.queries.every((q) => q.via === "primary")).toBe(true);
  });
});
