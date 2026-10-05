// The cost guard (vedu #4340): thresholds, the once-a-day alerts, the hard cap's switch, the 503 on heavy paths, and
// the no-op without an analytics token. Cloudflare's GraphQL is faked; D1 is node:sqlite with every migration.
import { beforeEach, describe, expect, it } from "vitest";
import { capped, check, clearCap, isHeavyRest, judge, resetCapCache, thresholds, totals, type Usage } from "../src/costGuard";
import { admit, setOverrides, type Admit } from "../src/limits";
import type { Env } from "../src/types";

const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);

function fakeEnv(vars: Partial<Env> = {}) {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ results: [], meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  const env = { DB: { prepare: (sql: string) => stmt(sql) }, PUBLIC_URL: "https://atteo.dev", ...vars } as unknown as Env;
  return { env, db };
}

const TOKEN = { CF_ACCOUNT_ID: "acct", CF_ANALYTICS_TOKEN: "tok" } as Partial<Env>;
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const quiet: Usage = { d1RowsRead: 7_000_000, d1RowsWritten: 150_000, doRowsRead: 60_000_000, doRowsWritten: 50_000, doRequests: 160_000 };

/** A fake GraphQL endpoint answering with `u` (split over two groups, as Cloudflare does), and the calls it saw. */
function graphql(u: Usage) {
  const calls: { auth: string | null; body: { variables: { a: string; d: string } } }[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    calls.push({ auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
    const half = (n: number) => [{ sum: { x: Math.floor(n / 2) } }, { sum: { x: n - Math.floor(n / 2) } }];
    const rename = (g: { sum: { x: number } }[], k: string) => g.map((x) => ({ sum: { [k]: x.sum.x } }));
    const d1 = half(u.d1RowsRead).map((g, i) => ({ sum: { rowsRead: g.sum.x, rowsWritten: half(u.d1RowsWritten)[i].sum.x } }));
    const dosql = half(u.doRowsRead).map((g, i) => ({ sum: { rowsRead: g.sum.x, rowsWritten: half(u.doRowsWritten)[i].sum.x } }));
    return Response.json({ data: { viewer: { accounts: [{ d1, dosql, doreq: rename(half(u.doRequests), "requests") }] } } });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

beforeEach(() => {
  resetCapCache();
  setOverrides({}, true);
});

describe("thresholds", () => {
  it("defaults sit well above a normal day and below a runaway (docs/COSTS.md)", () => {
    const { env } = fakeEnv();
    const t = thresholds(env);
    const day = totals(quiet);
    expect(day.rows_read).toBeLessThan(t.softRowsRead / 5);
    expect(day.rows_written).toBeLessThan(t.softRowsWritten / 10);
    expect(day.do_requests).toBeLessThan(t.softDoRequests / 10);
    // Oct 4's loop: 2.1B Durable Object rows read in three hours.
    expect(judge({ ...quiet, doRowsRead: 2_100_000_000 }, t).soft).toContain("rows_read");
    expect(judge({ ...quiet, doRowsRead: 3_100_000_000 }, t).hard).toContain("rows_read");
  });

  it("vars override each threshold; 0 turns one off", () => {
    const { env } = fakeEnv({ COST_SOFT_ROWS_WRITTEN: "100", COST_HARD_ROWS_WRITTEN: "0" } as Partial<Env>);
    const t = thresholds(env);
    expect(t.softRowsWritten).toBe(100);
    expect(judge({ ...quiet, d1RowsWritten: 10_000_000_000 }, t)).toEqual({ soft: ["rows_written"], hard: [] });
  });

  it("reads and writes add D1 and Durable Object SQL together", () => {
    expect(totals(quiet)).toEqual({ rows_read: 67_000_000, rows_written: 200_000, do_requests: 160_000 });
  });
});

describe("the cron", () => {
  it("does nothing without an analytics token (and asks Cloudflare nothing)", async () => {
    const { env } = fakeEnv();
    const g = graphql(quiet);
    const posts: string[] = [];
    const tick = await check(env, async (t) => posts.push(t), T0, g.fetcher);
    expect(tick).toEqual({ usage: null, soft: [], hard: [], alerted: [], capped: false });
    expect(g.calls).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("a quiet day: reads today's usage with the token, no alert, no cap", async () => {
    const { env } = fakeEnv(TOKEN);
    const g = graphql(quiet);
    const posts: string[] = [];
    const tick = await check(env, async (t) => posts.push(t), T0, g.fetcher);
    expect(g.calls[0].auth).toBe("Bearer tok");
    expect(g.calls[0].body.variables).toEqual({ a: "acct", d: "2026-10-05" });
    expect(tick.usage).toEqual(quiet);
    expect(tick.soft).toEqual([]);
    expect(posts).toEqual([]);
    expect(await capped(env, T0)).toBeNull();
  });

  it("falls back to CF_API_TOKEN (the load shedder's) when there's no CF_ANALYTICS_TOKEN", async () => {
    const { env } = fakeEnv({ CF_ACCOUNT_ID: "acct", CF_API_TOKEN: "older" } as Partial<Env>);
    const g = graphql(quiet);
    await check(env, async () => {}, T0, g.fetcher);
    expect(g.calls[0].auth).toBe("Bearer older");
  });

  it("past a soft threshold: one alert a day per metric, no cap", async () => {
    const { env } = fakeEnv(TOKEN);
    const g = graphql({ ...quiet, doRowsRead: 900_000_000 });
    const posts: string[] = [];
    const first = await check(env, async (t) => posts.push(t), T0, g.fetcher);
    const again = await check(env, async (t) => posts.push(t), T0 + 300_000, g.fetcher);
    expect(first.soft).toEqual(["rows_read"]);
    expect(first.alerted).toEqual(["rows_read"]);
    expect(again.alerted).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/^⚠️ Cost guard: rows read \(D1 \+ Durable Object SQL\) today: 907,000,000 \(threshold 500,000,000\)/);
    expect(await capped(env, T0)).toBeNull();
    // The next day alerts again.
    await check(env, async (t) => posts.push(t), T0 + 86_400_000, g.fetcher);
    expect(posts).toHaveLength(2);
  });

  it("past a hard cap: alerts, trips the switch, and it stays on (even the next day) until cleared", async () => {
    const { env } = fakeEnv(TOKEN);
    const posts: string[] = [];
    const tick = await check(env, async (t) => posts.push(t), T0, graphql({ ...quiet, d1RowsWritten: 30_000_000 }).fetcher);
    expect(tick.hard).toEqual(["rows_written"]);
    expect(tick.capped).toBe(true);
    expect(posts[0]).toMatch(/^🛑 Cost guard tripped: rows written .* 30,050,000 \(threshold 25,000,000\)/);
    resetCapCache();
    const next = await check(env, async () => {}, T0 + 86_400_000, graphql(quiet).fetcher);
    expect(next.capped).toBe(true); // a quiet day doesn't lift it: someone has to look first
    const c = await capped(env, T0 + 86_400_000);
    expect(c?.reason).toMatch(/rows written/);
    await clearCap(env, "vedu", T0 + 86_400_000);
    resetCapCache();
    expect(await capped(env, T0 + 86_400_000)).toBeNull();
  });

  it("Cloudflare not answering is no usage (no alert, no cap)", async () => {
    const { env } = fakeEnv(TOKEN);
    const broken = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    const tick = await check(env, async () => {}, T0, broken);
    expect(tick.usage).toBeNull();
    expect(tick.capped).toBe(false);
  });
});

describe("while the cap is on", () => {
  const agent = (o: Partial<Admit> = {}): Admit => ({ user: "vedu", kind: "agent", tokenKey: "tok-a", wait: false, write: false, essential: false, ...o });

  it("waits and heavy reads get a 503 that says why; ordinary reads and posts go through", async () => {
    const { env } = fakeEnv(TOKEN);
    await check(env, async () => {}, T0, graphql({ ...quiet, doRowsRead: 5_000_000_000 }).fetcher);
    const wait = await admit(env, null, agent({ wait: true }), T0);
    expect(wait?.status).toBe(503);
    const body = (await wait!.json()) as { cost_cap: boolean; error: string };
    expect(body.cost_cap).toBe(true);
    expect(body.error).toMatch(/Reading and posting still work/);
    expect(wait!.headers.get("retry-after")).toBe("600");
    expect((await admit(env, null, agent({ heavy: true }), T0))?.status).toBe(503);
    expect(await admit(env, null, agent(), T0)).toBeNull();
    expect(await admit(env, null, agent({ write: true, essential: true }), T0)).toBeNull();
  });

  it("no cap: waits and heavy reads go through", async () => {
    const { env } = fakeEnv(TOKEN);
    expect(await admit(env, null, agent({ wait: true }), T0)).toBeNull();
    expect(await admit(env, null, agent({ heavy: true }), T0)).toBeNull();
  });

  it("which REST paths count as heavy", () => {
    for (const p of ["/api/boards/search", "/api/boards/b_x/search", "/api/grep", "/api/boards/b_x/grep", "/api/boards/b_x/audit/export", "/api/me/log.jsonl", "/api/boards/b_x/export"]) expect(isHeavyRest("GET", p), p).toBe(true);
    for (const p of ["/api/boards/b_x/entries", "/api/boards", "/api/inbox", "/api/boards/b_x/updates"]) expect(isHeavyRest("GET", p), p).toBe(false);
  });
});
