import { beforeEach, describe, expect, it } from "vitest";
import {
  admit,
  beginWait,
  bump,
  flushAll,
  isEssentialMcp,
  isEssentialRest,
  isMcpWait,
  isWaitRequest,
  nearQuotaActive,
  nearQuotaAllowed,
  publicAllowed,
  pollAfterMs,
  rateCheck,
  secondsToMidnight,
  setNearQuota,
  setOverrides,
  setShedLevel,
  shedLevel,
  shedLevelFor,
  stretchWait,
  superseded,
  updateShedLevel,
  type Admit,
} from "../src/limits";
import type { Env } from "../src/types";

// A D1 stand-in over node:sqlite (Node 22+) with every migration, counting the statements the code sends.
const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

function fakeEnv(vars: Partial<Env> = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const sent: string[] = [];
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (sent.push(sql), db.prepare(sql).get(...args) ?? null),
    all: async () => (sent.push(sql), { results: db.prepare(sql).all(...args) }),
    run: async () => (sent.push(sql), db.prepare(sql).run(...args), { results: [], meta: {} }),
  });
  const env = { DB: { prepare: (sql: string) => stmt(sql) }, ...vars } as unknown as Env;
  return { env, db, sent };
}

const T0 = Date.UTC(2026, 9, 3, 12, 0, 0); // noon UTC
const agent = (o: Partial<Admit> = {}): Admit => ({ user: "vedu", kind: "agent", tokenKey: "tok-a", wait: false, write: false, essential: false, ...o });
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
const settle = async () => {
  while (pending.length) await pending.shift();
};

beforeEach(() => {
  setOverrides({}, true);
});

describe("per-token rate limit", () => {
  it("allows up to the limit a minute, then 429 with Retry-After until the window frees up", async () => {
    const { env } = fakeEnv({ RATE_AGENT_PER_MIN: "3" });
    for (let i = 0; i < 3; i++) expect(await admit(env, ctx, agent(), T0 + i)).toBeNull();
    const r = await admit(env, ctx, agent(), T0 + 10);
    expect(r?.status).toBe(429);
    expect(Number(r?.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await r!.json()) as { error: string; retry_after: number; scope: string };
    expect(body.scope).toBe("token");
    expect(body.error).toMatch(/at most 3 requests a minute per agent token/);
    // Another token (even the same person's) has its own window.
    expect(await admit(env, ctx, agent({ tokenKey: "tok-b" }), T0 + 11)).toBeNull();
  });

  it("app tokens get the higher person limit; web sessions (no token) aren't rate-limited", async () => {
    const { env } = fakeEnv({ RATE_AGENT_PER_MIN: "1", RATE_APP_PER_MIN: "2" });
    const app = agent({ kind: "person", tokenKey: "tok-app" });
    expect(await admit(env, ctx, app, T0)).toBeNull();
    expect(await admit(env, ctx, app, T0 + 1)).toBeNull();
    expect((await admit(env, ctx, app, T0 + 2))?.status).toBe(429);
    for (let i = 0; i < 5; i++) expect(await admit(env, ctx, agent({ kind: "person", tokenKey: null }), T0 + i)).toBeNull();
  });

  it("slides: the previous minute counts for the part of it still inside the last 60s", () => {
    for (let i = 0; i < 10; i++) expect(rateCheck("k", 10, T0 + i).ok).toBe(true);
    // A second into the next minute ~98% of the last one still counts (9.8): one more fits, then it's full.
    expect(rateCheck("k", 10, T0 + 60_000 + 1000).ok).toBe(true);
    expect(rateCheck("k", 10, T0 + 60_000 + 1001).ok).toBe(false);
    expect(rateCheck("k", 10, T0 + 60_000 + 30_000).ok).toBe(true); // half of it has slid out
  });
});

describe("daily budget", () => {
  it("is counted in memory and flushed in batches: no D1 per request", async () => {
    const { env, db, sent } = fakeEnv();
    for (let i = 0; i < 250; i++) expect(await admit(env, ctx, agent({ tokenKey: null }), T0 + i)).toBeNull();
    await settle();
    // 250 requests: two batch upserts (every 100) and one shed-level read (cached a minute) — nothing per request.
    expect(sent.filter((s) => /usage_daily/.test(s) && /INSERT/.test(s)).length).toBe(2);
    expect(sent.length).toBeLessThanOrEqual(3);
    await flushAll(env, T0 + 1000);
    expect(db.prepare(`SELECT count FROM usage_daily WHERE metric = 'requests' AND key = 'vedu'`).get().count).toBe(250);
  });

  it("over the Free budget: agents get 429 'Daily limit reached' until midnight UTC; refused calls don't count", async () => {
    const { env } = fakeEnv({ DAILY_REQUESTS_FREE: "5" });
    for (let i = 0; i < 5; i++) expect(await admit(env, ctx, agent({ tokenKey: null }), T0 + i)).toBeNull();
    const r = await admit(env, ctx, agent({ tokenKey: null }), T0 + 10);
    expect(r?.status).toBe(429);
    expect(Number(r?.headers.get("retry-after"))).toBe(12 * 3600);
    expect(((await r!.json()) as { error: string }).error).toMatch(/^Daily limit reached/);
    // Waits are refused too once over (they aren't counted, but the agent is done for the day).
    expect((await admit(env, ctx, agent({ tokenKey: null, wait: true }), T0 + 11))?.status).toBe(429);
    // A new UTC day starts fresh.
    expect(await admit(env, ctx, agent({ tokenKey: null }), T0 + 12 * 3600_000 + 1)).toBeNull();
  });

  it("the person keeps reading on the web (GETs) but changes get the 429", async () => {
    const { env } = fakeEnv({ DAILY_REQUESTS_FREE: "2" });
    const web = agent({ kind: "person", tokenKey: null });
    expect(await admit(env, ctx, web, T0)).toBeNull();
    expect(await admit(env, ctx, web, T0 + 1)).toBeNull();
    expect(await admit(env, ctx, web, T0 + 2)).toBeNull(); // a read, over budget: still fine
    const w = await admit(env, ctx, { ...web, write: true }, T0 + 3);
    expect(w?.status).toBe(429);
    expect(((await w!.json()) as { error: string }).error).toMatch(/you can still read/);
  });

  it("waits (long-polls) aren't counted", async () => {
    const { env } = fakeEnv({ DAILY_REQUESTS_FREE: "3" });
    for (let i = 0; i < 50; i++) expect(await admit(env, ctx, agent({ tokenKey: null, wait: true }), T0 + i)).toBeNull();
    for (let i = 0; i < 3; i++) expect(await admit(env, ctx, agent({ tokenKey: null }), T0 + 100 + i)).toBeNull();
    expect((await admit(env, ctx, agent({ tokenKey: null }), T0 + 200))?.status).toBe(429);
  });

  it("Pro is unlimited by default (the plan is read only once someone is over the Free budget), or DAILY_REQUESTS_PRO", async () => {
    const { env, db, sent } = fakeEnv({ DAILY_REQUESTS_FREE: "2" });
    db.prepare(`INSERT INTO users (name, plan, first_seen, last_seen) VALUES ('vedu', 'pro', 0, 0)`).run();
    for (let i = 0; i < 2; i++) await admit(env, ctx, agent({ tokenKey: null }), T0 + i);
    expect(sent.some((s) => /FROM users/.test(s))).toBe(false);
    for (let i = 0; i < 20; i++) expect(await admit(env, ctx, agent({ tokenKey: null }), T0 + 10 + i)).toBeNull();
    expect(sent.filter((s) => /FROM users/.test(s)).length).toBe(1); // cached
    setOverrides({ dailyPro: 25 });
    for (let i = 0; i < 3; i++) await admit(env, ctx, agent({ tokenKey: null }), T0 + 100 + i);
    expect((await admit(env, ctx, agent({ tokenKey: null }), T0 + 200))?.status).toBe(429);
  });

  it("operators (ADMIN_EMAIL) get Pro limits on a Free plan: no daily cap; a Free account with another email does (#2107)", async () => {
    const { env, db } = fakeEnv({ DAILY_REQUESTS_FREE: "2", ADMIN_EMAIL: "Boss@Example.com, other@example.com" } as Partial<Env>);
    db.prepare(`INSERT INTO users (name, email, first_seen, last_seen) VALUES ('vedu', 'boss@example.com', 0, 0)`).run();
    db.prepare(`INSERT INTO users (name, email, first_seen, last_seen) VALUES ('jo', 'jo@example.com', 0, 0)`).run();
    for (let i = 0; i < 30; i++) expect(await admit(env, ctx, agent({ tokenKey: null }), T0 + i)).toBeNull();
    for (let i = 0; i < 2; i++) expect(await admit(env, ctx, agent({ user: "jo", tokenKey: null }), T0 + i)).toBeNull();
    expect((await admit(env, ctx, agent({ user: "jo", tokenKey: null }), T0 + 10))?.status).toBe(429);
    // The per-token rate limit still applies to an operator's tokens (it protects the Worker, not a plan).
    setOverrides({ agentPerMin: 2 });
    for (let i = 0; i < 2; i++) expect(await admit(env, ctx, agent({ tokenKey: "tok-op" }), T0 + 100 + i)).toBeNull();
    expect((await admit(env, ctx, agent({ tokenKey: "tok-op" }), T0 + 110))?.status).toBe(429);
  });

  it("counts from every isolate add up through the flush (it returns the global total)", async () => {
    const { env, db } = fakeEnv({ DAILY_REQUESTS_FREE: "150" });
    db.prepare(`INSERT INTO usage_daily (day, metric, key, count) VALUES ('2026-10-03', 'requests', 'vedu', 120)`).run(); // other isolates
    for (let i = 0; i < 100; i++) await admit(env, ctx, agent({ tokenKey: null }), T0 + i); // the 100th flushes and learns 220
    await settle();
    expect((await admit(env, ctx, agent({ tokenKey: null }), T0 + 500))?.status).toBe(429);
  });
});

describe("load shedding", () => {
  it("levels from today's requests or D1 rows read, whichever is worse", () => {
    const lim = { shedL1Requests: 70, shedL2Requests: 90, shedL1RowsRead: 3500, shedL2RowsRead: 4500 };
    expect(shedLevelFor({ requests: 10 }, lim)).toBe(0);
    expect(shedLevelFor({ requests: 70 }, lim)).toBe(1);
    expect(shedLevelFor({ requests: 95 }, lim)).toBe(2);
    expect(shedLevelFor({ requests: 10, rowsRead: 4000 }, lim)).toBe(1);
    expect(shedLevelFor({ requests: 80, rowsRead: 5000 }, lim)).toBe(2);
    expect(shedLevelFor({ requests: 10_000 }, { ...lim, shedL1Requests: 0, shedL2Requests: 0 })).toBe(0); // 0 turns a threshold off
  });

  it("the cron flushes, reads today's total and stores the level; requests read it at most once a minute", async () => {
    const { env, sent } = fakeEnv({ SHED_L1_REQUESTS: "3", SHED_L2_REQUESTS: "1000" });
    for (let i = 0; i < 4; i++) bump(env, null, "requests_all", "", 1, T0);
    expect(await updateShedLevel(env, T0)).toEqual({ level: 1, requests: 4, rows_read: null });
    setOverrides({}, true); // another isolate: nothing cached
    const before = sent.length;
    expect(await shedLevel(env, T0 + 1)).toBe(1);
    expect(await shedLevel(env, T0 + 30_000)).toBe(1);
    expect(sent.length - before).toBe(1);
  });

  it("DEV_FAKE_NEAR_QUOTA fakes level 1 on localhost for tests", async () => {
    const { env } = fakeEnv({ PUBLIC_URL: "http://localhost:8787" });
    expect(nearQuotaAllowed(env)).toBe(false);
    const on = fakeEnv({ PUBLIC_URL: "http://localhost:8787", DEV_FAKE_NEAR_QUOTA: "1" });
    expect(nearQuotaAllowed(on.env)).toBe(true);
    expect(setNearQuota(on.env, true)).toBe(true);
    expect(nearQuotaActive()).toBe(true);
    expect(await shedLevel(on.env, T0)).toBe(1);
    expect(await updateShedLevel(on.env, T0)).toMatchObject({ level: 1 });
    setOverrides({}, true);
    expect(nearQuotaActive()).toBe(false);
    expect(setNearQuota({ PUBLIC_URL: "http://localhost:8787" } as typeof on.env, true)).toBe(false);
  });

  it("level 1 stretches waits and asks clients to poll less; level 2 also refuses non-essential agent writes with 503", async () => {
    const { env } = fakeEnv();
    expect(stretchWait(25_000, 50_000, 0)).toBe(25_000);
    expect(stretchWait(25_000, 50_000, 1)).toBe(50_000);
    expect(stretchWait(45_000, 55_000, 2)).toBe(55_000);
    expect(pollAfterMs(0)).toBe(0);
    expect(pollAfterMs(1)).toBeGreaterThan(0);
    await setShedLevel(env, 1, T0);
    expect(await admit(env, ctx, agent({ write: true }), T0)).toBeNull();
    await setShedLevel(env, 2, T0);
    const r = await admit(env, ctx, agent({ write: true }), T0 + 1);
    expect(r?.status).toBe(503);
    expect(r?.headers.get("retry-after")).toBeTruthy();
    expect(await admit(env, ctx, agent({ write: true, essential: true }), T0 + 2)).toBeNull(); // posting still works
    expect(await admit(env, ctx, agent({ write: false }), T0 + 3)).toBeNull(); // reads too
    expect(await admit(env, ctx, agent({ kind: "person", write: true }), T0 + 4)).toBeNull(); // people aren't shed
  });
});

describe("one open wait per session", () => {
  it("a newer wait ends the older one (superseded); a session's own wait ends cleanly", () => {
    const a = beginWait("s:1", T0);
    const b = beginWait("s:1", T0 + 1);
    expect(superseded(a.signal)).toBe(true);
    expect(b.signal?.aborted).toBe(false);
    b.done();
    expect(superseded(b.signal)).toBe(false);
    expect(beginWait(null).signal).toBeUndefined(); // no session: not limited (web tabs)
  });

  it("two loops fighting over one session: after 5 takeovers a minute the newest is refused", () => {
    let last = beginWait("s:2", T0);
    for (let i = 1; i <= 5; i++) last = beginWait("s:2", T0 + i);
    expect(beginWait("s:2", T0 + 10).refused).toBe(10);
    last.done();
    expect(beginWait("s:2", T0 + 61_000 + 10).refused).toBeUndefined(); // a minute later
  });
});

describe("classification", () => {
  const u = (s: string) => new URL(`https://x${s}`);
  it("REST waits", () => {
    expect(isWaitRequest("GET", "/api/mailbox", u("/api/mailbox?wait=25"))).toBe(true);
    expect(isWaitRequest("GET", "/api/mailbox", u("/api/mailbox?peek=1"))).toBe(false);
    expect(isWaitRequest("GET", "/api/sessions/as_x/wait", u("/api/sessions/as_x/wait?timeout=45"))).toBe(true);
    expect(isWaitRequest("GET", "/api/boards/b_1/updates", u("/api/boards/b_1/updates?after=3&wait=25"))).toBe(true);
    expect(isWaitRequest("GET", "/api/boards/b_1/ws", u("/api/boards/b_1/ws"))).toBe(true);
    expect(isWaitRequest("POST", "/api/boards/b_1/entries", u("/api/boards/b_1/entries?wait=5"))).toBe(false);
  });
  it("MCP waits", () => {
    expect(isMcpWait({ method: "tools/call", params: { name: "wait" } })).toBe(true);
    expect(isMcpWait({ method: "tools/call", params: { name: "mailbox", arguments: { wait_seconds: 30 } } })).toBe(true);
    expect(isMcpWait({ method: "tools/call", params: { name: "mailbox" } })).toBe(false);
    expect(isMcpWait({ method: "tools/call", params: { name: "approval", arguments: { action: "wait" } } })).toBe(true);
    expect(isMcpWait({ method: "tools/call", params: { name: "read" } })).toBe(false);
  });
  it("essential agent writes", () => {
    expect(isEssentialRest("/api/boards/b_1/entries")).toBe(true);
    expect(isEssentialRest("/api/boards/b_1/entries/4/retract")).toBe(true);
    expect(isEssentialRest("/api/sessions")).toBe(true);
    expect(isEssentialRest("/api/boards/b_1/entries/4/react")).toBe(false); // reactions can wait
    expect(isEssentialRest("/api/boards/b_1/reactions")).toBe(false);
    expect(isEssentialRest("/api/boards/b_1/memory")).toBe(false);
    expect(isEssentialRest("/api/me/profile")).toBe(false);
    expect(isEssentialMcp("post")).toBe(true);
    expect(isEssentialMcp("react")).toBe(false);
  });
  it("Retry-After for the daily budget runs to 00:00 UTC", () => {
    expect(secondsToMidnight(Date.UTC(2026, 9, 3, 23, 59, 30))).toBe(30);
  });
});

describe("an MCP batch counts as its calls (calls/counted)", () => {
  it("rate limit: a batch of 3 takes 3 slots; one that doesn't fit is refused whole", async () => {
    const { env } = fakeEnv({ RATE_AGENT_PER_MIN: "4" });
    expect(await admit(env, ctx, agent({ calls: 3, counted: 3 }), T0)).toBeNull();
    expect((await admit(env, ctx, agent({ calls: 2, counted: 2 }), T0 + 1))?.status).toBe(429);
    expect(await admit(env, ctx, agent(), T0 + 2)).toBeNull(); // the 4th slot
    expect((await admit(env, ctx, agent(), T0 + 3))?.status).toBe(429);
  });

  it("daily budget: counts each non-wait call, refuses a batch that would go past it, and a refusal counts nothing", async () => {
    const { env } = fakeEnv({ DAILY_REQUESTS_FREE: "4" });
    expect(await admit(env, ctx, agent({ tokenKey: null, calls: 3, counted: 3 }), T0)).toBeNull();
    expect((await admit(env, ctx, agent({ tokenKey: null, calls: 2, counted: 2 }), T0 + 1))?.status).toBe(429);
    expect(await admit(env, ctx, agent({ tokenKey: null }), T0 + 2)).toBeNull(); // the refused batch didn't count
    expect((await admit(env, ctx, agent({ tokenKey: null }), T0 + 3))?.status).toBe(429);
  });
});

describe("publicAllowed (signed-out endpoints, vedu #4598)", () => {
  const binding = (success: boolean | Error) => {
    const keys: string[] = [];
    return { keys, limit: async ({ key }: { key: string }) => { keys.push(key); if (success instanceof Error) throw success; return { success }; } };
  };
  const prod = { PUBLIC_URL: "https://atteo.dev" };
  const req = (h: Record<string, string> = { "cf-connecting-ip": "1.2.3.4" }) => new Request("https://x.test/", { headers: h });
  it("asks the binding per endpoint and address", async () => {
    const b = binding(true);
    expect(await publicAllowed({ ...prod, PUBLIC_WRITES: b } as never, "oauth-register", req())).toBe(true);
    expect(b.keys).toEqual(["oauth-register:1.2.3.4"]);
  });
  it("refuses once the binding says so", async () => {
    expect(await publicAllowed({ ...prod, PUBLIC_WRITES: binding(false) } as never, "device-start", req())).toBe(false);
  });
  it("lets the request through without a binding, on a local server, or when the limiter fails", async () => {
    expect(await publicAllowed(prod as never, "health", req())).toBe(true);
    const b = binding(false);
    expect(await publicAllowed({ PUBLIC_URL: "http://localhost:8787", PUBLIC_WRITES: b } as never, "health", req())).toBe(true);
    expect(b.keys).toEqual([]);
    expect(await publicAllowed({ ...prod, PUBLIC_WRITES: binding(new Error("down")) } as never, "health", req())).toBe(true);
  });
  it("doesn't count requests that come through the atteo.dev proxy (all of them share its address)", async () => {
    const b = binding(false);
    expect(await publicAllowed({ ...prod, PUBLIC_WRITES: b } as never, "oauth-register", req({ "cf-connecting-ip": "2a06:98c0:3600::103", "cf-worker": "atteo.dev" }))).toBe(true);
    expect(b.keys).toEqual([]);
  });
});
