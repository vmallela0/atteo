import { describe, expect, it, vi } from "vitest";

// route() checks membership and the board through registry: a stand-in (only "ann", "bo", "cy", "di", "ed" are members of b_xboard001).
vi.mock("../src/registry", () => ({
  isMember: async (_env: unknown, board: string, user: string) => board.startsWith("b_") && ["ann", "bo", "cy", "di", "ed"].includes(user),
  getBoard: async (_env: unknown, id: string) => (id === "b_xboard001" ? { id, title: "X", encrypted: 0 } : id === "b_encboard1" ? { id, title: "E", encrypted: 1 } : null),
}));

import { addressesAtteo, cloudflareSfu, handle, lengthText, reapAll, route, sfuFor, STALE_MS, stubSfu, summaryText, type CallDeps, type Sfu } from "../src/calls";
import { CALL_GATE_JS } from "../src/callWeb";
import { createSession, fakeProvider, finishSession, usedSeconds, type VoiceDeps } from "../src/voice";

// A D1 stand-in over node:sqlite running the real migrations (as voice.test.ts).
const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string };
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  for (const f of ["0038_app_signin.sql", "0050_voice_usage.sql", "0075_calls.sql"]) db.exec(readFileSync(new URL(`../migrations/${f}`, (import.meta as unknown as { url: string }).url), "utf8"));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => (/\bRETURNING\b/i.test(sql) ? { results: db.prepare(sql).all(...args) } : (db.prepare(sql).run(...args), { results: [] })),
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (list: any[]) => Promise.all(list.map((s) => s.run())) } as unknown as D1Database;
}

const BOARD = "b_xboard001";
type Post = { board: string; author: string; text: string; reply_to?: number | null; data?: any };

/** Calls with the real voice sessions behind the Atteo turn (fake provider): minutes count as Talk's do. */
function setup(o: { sfu?: Sfu | null; budgetMinutes?: number; voiceStart?: CallDeps["voiceStart"] } = {}) {
  const db = fakeD1();
  let t = 1_800_000_000_000;
  const posts: Post[] = [];
  const ends: { session_id: string; seconds: number }[] = [];
  const voiceDeps = (): VoiceDeps => ({ db, provider: fakeProvider, budgetMinutes: o.budgetMinutes ?? 180, sessionMinutes: 10, perMinute: 100, board: async (id) => ({ id, title: "X" }), now: () => t });
  const depsFor = (user: string): CallDeps => ({
    db,
    now: () => t,
    sfu: o.sfu === undefined ? stubSfu : o.sfu,
    voiceStart: o.voiceStart ?? ((board) => createSession({ name: user }, { board, hands_free: true }, voiceDeps())),
    voiceEnd: async (body) => (ends.push(body), finishSession(user, body, voiceDeps())),
    post: async (board, author, input) => (posts.push({ board, author, ...input }), posts.length),
  });
  const call = async (user: string, sub: string, body?: unknown, method = sub === "" ? "GET" : "POST") => {
    const r = await handle(method, BOARD, sub, user, body ?? {}, depsFor(user));
    return { status: r.status, j: (await r.json()) as any };
  };
  /** Time passes while these people stay on (their pages ping every 20 s). */
  const stay = async (ms: number, ...users: string[]) => {
    for (let left = ms; left > 0; left -= 20_000) {
      t += Math.min(20_000, left);
      for (const u of users) await call(u, "ping");
    }
  };
  return { db, posts, ends, call, depsFor, stay, tick: (ms: number) => (t += ms), now: () => t };
}

describe("addressesAtteo: the words that reach Atteo", () => {
  const YES = ["Atteo, what's next?", "atteo what did we decide", "Hey Atteo, summarize", "ok so atteo can you check", "@atteo status?", "What's on the roadmap, Atteo?", "Ateo, are you there", "  “Atteo, hi”".replace("“", '"'), "Atteo"];
  const NO = ["I asked Atteo yesterday", "Atteo's summary was good", "atteolike", "let's ask atteo later about it", "", "what's next", "the atteo app", "Atteo’s reply"];
  for (const t of YES) it(`yes: ${JSON.stringify(t)}`, () => expect(addressesAtteo(t)).toBe(true));
  for (const t of NO) it(`no: ${JSON.stringify(t)}`, () => expect(addressesAtteo(t)).toBe(false));
  it("the web page's copy (callAddressed) agrees on every case", () => {
    const callAddressed = new Function(`${CALL_GATE_JS}; return callAddressed;`)() as (t: string) => boolean;
    for (const t of [...YES, ...NO]) expect([t, callAddressed(t)]).toEqual([t, addressesAtteo(t)]);
  });
});

describe("calls: join, who's in, leave, the posts", () => {
  it("the first join starts the call and posts it; others join; GET shows who's in without SFU sessions", async () => {
    const s = setup();
    expect((await s.call("ann", "")).j).toMatchObject({ call: null, stub: true, max: 4 });
    const a = await s.call("ann", "join");
    expect(a.status).toBe(200);
    expect(a.j.call.members.map((m: any) => m.user)).toEqual(["ann"]);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]).toMatchObject({ board: BOARD, author: "ann", data: { call: { state: "live" } } });
    expect(s.posts[0].text).toMatch(/Started a call/);
    await s.call("bo", "join");
    expect(s.posts).toHaveLength(1); // one post per call, not per join
    const g = await s.call("bo", "");
    expect(g.j.joined).toBe(true);
    expect(g.j.call.members.map((m: any) => [m.user, m.you])).toEqual([["ann", false], ["bo", true]]);
    expect(JSON.stringify(g.j)).not.toMatch(/sfu_session|sessionId/);
  });

  it("four people at most", async () => {
    const s = setup();
    for (const u of ["ann", "bo", "cy", "di"]) expect((await s.call(u, "join")).status).toBe(200);
    const e = await s.call("ed", "join");
    expect(e.status).toBe(409);
    expect(e.j.error).toMatch(/full \(4 people\)/);
    expect((await s.call("ann", "join")).status).toBe(200); // someone already in can rejoin
  });

  it("the last one out ends it, and a reply says who joined, how long, and what Atteo was asked", async () => {
    const s = setup();
    await s.call("ann", "join");
    await s.call("bo", "join");
    await s.stay(5 * 60_000, "ann", "bo");
    await s.call("bo", "atteo", { op: "ask" });
    await s.call("bo", "atteo", { op: "done", seconds: 20, question: "what's left this week?", answer: "Two tasks: the deploy and the docs." });
    await s.stay(7 * 60_000, "ann", "bo");
    await s.call("ann", "leave");
    expect(s.posts).toHaveLength(1);
    const out = await s.call("bo", "leave");
    expect(out.j.call).toBeNull();
    expect(s.posts).toHaveLength(2);
    const sum = s.posts[1];
    expect(sum).toMatchObject({ author: "ann", reply_to: 1, data: { call: { state: "ended", people: ["ann", "bo"], atteo_questions: 1 } } });
    expect(sum.text).toContain("Call ended after 12 min. Joined: ann, bo.");
    expect(sum.text).toContain("bo: “what's left this week?” → Two tasks: the deploy and the docs.");
    // A new call after that is a new call (and a new post).
    await s.call("cy", "join");
    expect(s.posts).toHaveLength(3);
  });

  it("someone who stops pinging is out after 30 s; a call nobody pings is ended by the cron", async () => {
    const s = setup();
    await s.call("ann", "join");
    await s.call("bo", "join");
    s.tick(STALE_MS - 1000);
    await s.call("ann", "ping");
    s.tick(2000);
    const g = await s.call("ann", "");
    expect(g.j.call.members.map((m: any) => m.user)).toEqual(["ann"]);
    s.tick(STALE_MS + 1000);
    await reapAll(s.depsFor("cron"));
    expect(s.posts).toHaveLength(2);
    expect(s.posts[1].text).toMatch(/^Call ended after under a minute\. Joined: ann, bo\./);
    expect((await s.call("ann", "")).j.call).toBeNull();
  });

  it("without an SFU (a server that isn't local, no Realtime app) joining says what's missing", async () => {
    const s = setup({ sfu: null });
    const r = await s.call("ann", "join");
    expect(r.status).toBe(503);
    expect(r.j.error).toMatch(/CF_REALTIME_APP_ID.*CF_REALTIME_APP_TOKEN/);
    expect(r.j.needs).toEqual(["CF_REALTIME_APP_ID", "CF_REALTIME_APP_TOKEN"]);
  });
});

describe("the Atteo turn: gated, one at a time, on the VOICE minutes", () => {
  it("only words said to Atteo, or the button; one person at a time; done frees it and settles the session", async () => {
    const s = setup();
    await s.call("ann", "join");
    await s.call("bo", "join");
    expect((await s.call("cy", "atteo", { op: "ask" })).status).toBe(409); // not in the call
    const said = await s.call("ann", "atteo", { op: "ask", text: "I think Atteo said that" });
    expect(said.status).toBe(400);
    expect(said.j.addressed).toBe(false);
    const ask = await s.call("ann", "atteo", { op: "ask", text: "Atteo, what's next?" });
    expect(ask.status).toBe(200);
    expect(ask.j).toMatchObject({ holder: "ann", provider: "fake", hands_free: true });
    expect(ask.j.session_id).toMatch(/^vs_/);
    expect(ask.j.protocols[0]).toMatch(/^xai-client-secret\.fake-client-secret-/);
    const busy = await s.call("bo", "atteo", { op: "ask" });
    expect(busy.status).toBe(409);
    expect(busy.j).toMatchObject({ holder: "ann" });
    expect((await s.call("bo", "")).j.call.atteo).toMatchObject({ holder: "ann" });
    expect((await s.call("bo", "atteo", { op: "done", seconds: 1 })).status).toBe(409); // not bo's turn
    // Charged up front against the person's voice minutes (as Talk), settled to what was used.
    expect(await usedSeconds(s.db, "ann", s.now())).toBe(600);
    expect((await s.call("ann", "atteo", { op: "done", seconds: 42, question: "what's next?", answer: "The deploy." })).status).toBe(200);
    expect(s.ends).toEqual([{ session_id: ask.j.session_id, seconds: 42 }]);
    expect(await usedSeconds(s.db, "ann", s.now())).toBe(42);
    expect((await s.call("bo", "atteo", { op: "ask" })).status).toBe(200);
  });

  it("a turn whose page closed lets go when its time is up", async () => {
    const s = setup();
    await s.call("ann", "join");
    await s.call("bo", "join");
    const a = await s.call("ann", "atteo", { op: "ask" });
    expect(a.j.until).toBe(s.now() + (600 + 15) * 1000);
    await s.stay(10_000, "ann", "bo");
    expect((await s.call("bo", "atteo", { op: "ask" })).status).toBe(409);
    await s.stay(610_000, "ann", "bo");
    const late = await s.call("bo", "atteo", { op: "ask" });
    expect([late.status, late.j.error]).toEqual([200, undefined]);
  });

  it("over the VOICE minutes: voice's 429, and the turn isn't held", async () => {
    const s = setup({ budgetMinutes: 0 }); // this month's minutes are used
    await s.call("ann", "join");
    const r = await s.call("ann", "atteo", { op: "ask" });
    expect(r.status).toBe(429);
    expect(r.j.error).toMatch(/voice time/);
    expect((await s.call("ann", "")).j.call.atteo).toBeNull();
  });

  it("leaving lets go of the turn", async () => {
    const s = setup();
    await s.call("ann", "join");
    await s.call("bo", "join");
    await s.call("ann", "atteo", { op: "ask" });
    await s.call("ann", "leave");
    expect((await s.call("bo", "atteo", { op: "ask" })).status).toBe(200);
  });
});

describe("the SFU go-between", () => {
  function fakeRealtime() {
    const seen: { method: string; url: string; body: any; auth: string | null }[] = [];
    let n = 0;
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init.headers).get("authorization") });
      if (url.endsWith("/sessions/new")) return Response.json({ sessionId: `sess${++n}` });
      return Response.json({ sessionDescription: { type: "answer", sdp: "v=0 answer" }, tracks: [{ mid: "0" }], requiresImmediateRenegotiation: false });
    }) as unknown as typeof fetch;
    return { seen, sfu: cloudflareSfu("app123", "TOKEN-xyz", fetcher) };
  }

  it("publishes your mic, pulls only tracks of people in this call, never says a session id", async () => {
    const rt = fakeRealtime();
    const s = setup({ sfu: rt.sfu });
    await s.call("ann", "join");
    await s.call("bo", "join");
    expect(rt.seen.filter((x) => x.url === "https://rtc.live.cloudflare.com/v1/apps/app123/sessions/new")).toHaveLength(2);
    expect(rt.seen.every((x) => x.auth === "Bearer TOKEN-xyz")).toBe(true);
    const pub = await s.call("ann", "sfu", { op: "publish", sdp: "v=0 offer", tracks: [{ mid: "0", trackName: "mic" }] });
    expect(pub.status).toBe(200);
    expect(pub.j.sessionDescription.type).toBe("answer");
    expect(rt.seen.at(-1)).toMatchObject({ method: "POST", url: expect.stringMatching(/\/sessions\/sess1\/tracks\/new$/), body: { sessionDescription: { type: "offer", sdp: "v=0 offer" }, tracks: [{ location: "local", mid: "0", trackName: "mic" }] } });
    expect((await s.call("bo", "")).j.call.members.find((m: any) => m.user === "ann").tracks).toEqual(["mic"]);
    const pull = await s.call("bo", "sfu", { op: "pull", tracks: [{ user: "ann", trackName: "mic" }] });
    expect(pull.status).toBe(200);
    expect(rt.seen.at(-1)).toMatchObject({ url: expect.stringMatching(/\/sessions\/sess2\/tracks\/new$/), body: { tracks: [{ location: "remote", sessionId: "sess1", trackName: "mic" }] } });
    expect((await s.call("bo", "sfu", { op: "pull", tracks: [{ user: "cy", trackName: "mic" }] })).status).toBe(404); // not in the call
    expect((await s.call("bo", "sfu", { op: "pull", tracks: [{ user: "ann", trackName: "atteo" }] })).status).toBe(404); // no such track
    expect((await s.call("cy", "sfu", { op: "publish", sdp: "x", tracks: [{ mid: "0", trackName: "mic" }] })).status).toBe(409); // join first
    const ren = await s.call("bo", "sfu", { op: "renegotiate", sdp: "v=0 answer2" });
    expect(ren.status).toBe(200);
    expect(rt.seen.at(-1)).toMatchObject({ method: "PUT", url: expect.stringMatching(/\/sessions\/sess2\/renegotiate$/) });
    expect((await s.call("bo", "sfu", { op: "bogus" })).status).toBe(400);
  });

  it("only whoever holds the Atteo turn publishes the atteo track", async () => {
    const rt = fakeRealtime();
    const s = setup({ sfu: rt.sfu });
    await s.call("ann", "join");
    const pub = () => s.call("ann", "sfu", { op: "publish", sdp: "v=0", tracks: [{ mid: "1", trackName: "atteo" }] });
    expect((await pub()).status).toBe(409);
    await s.call("ann", "atteo", { op: "ask" });
    expect((await pub()).status).toBe(200);
    expect((await s.call("ann", "sfu", { op: "publish", sdp: "v=0", tracks: [{ mid: "2", trackName: "screen" }] })).status).toBe(400);
  });

  it("the stub room answers {stub: true}; sfuFor picks the stub only on localhost", async () => {
    const s = setup();
    await s.call("ann", "join");
    expect((await s.call("ann", "sfu", { op: "publish", sdp: "v=0", tracks: [{ mid: "0", trackName: "mic" }] })).j).toEqual({ stub: true });
    expect(sfuFor({}, new Request("http://localhost:8787/x"))).toBe(stubSfu);
    expect(sfuFor({}, new Request("https://atteo.dev/x"))).toBeNull();
    expect(sfuFor({ CF_REALTIME_APP_ID: "a", CF_REALTIME_APP_TOKEN: "t" }, new Request("https://atteo.dev/x"))?.stub).toBe(false);
    expect(sfuFor({ CF_REALTIME_APP_ID: "a" }, new Request("https://atteo.dev/x"))).toBeNull();
  });
});

describe("route: people who are members only", () => {
  const env = { DB: fakeD1() } as any;
  const req = (path: string, method = "GET") => new Request(`http://localhost${path}`, method === "POST" ? { method, body: "{}" } : { method });
  it("not a call path: null", async () => expect(await route(req("/api/boards/b_xboard001/calls"), env, "/api/boards/b_xboard001/calls", { name: "ann" })).toBeNull());
  it("signed out 401, an agent's token 403, not a member 404, an encrypted board 403", async () => {
    expect((await route(req("/api/boards/b_xboard001/call"), env, "/api/boards/b_xboard001/call", null))!.status).toBe(401);
    expect((await route(req("/api/boards/b_xboard001/call"), env, "/api/boards/b_xboard001/call", { name: "ann", via: "agent" }))!.status).toBe(403);
    expect((await route(req("/api/boards/b_xboard001/call"), env, "/api/boards/b_xboard001/call", { name: "zed", via: "person" }))!.status).toBe(404);
    expect((await route(req("/api/boards/b_encboard1/call"), env, "/api/boards/b_encboard1/call", { name: "ann", via: "person" }))!.status).toBe(403);
    const ok = await route(req("/api/boards/b_xboard001/call"), env, "/api/boards/b_xboard001/call", { name: "ann", via: "person" });
    expect(ok!.status).toBe(200);
    expect(await ok!.json()).toMatchObject({ call: null, stub: true });
  });
});

describe("the summary's words", () => {
  it("lengthText", () => {
    expect(lengthText(20_000)).toBe("under a minute");
    expect(lengthText(12 * 60_000)).toBe("12 min");
    expect(lengthText(65 * 60_000)).toBe("1 h 5 min");
    expect(lengthText(120 * 60_000)).toBe("2 h");
  });
  it("summaryText with nothing asked", () => {
    expect(summaryText({ started_at: 0, ended_at: 3 * 60_000, people: ["ann", "bo"], log: [] })).toBe("Call ended after 3 min. Joined: ann, bo.\nAtteo wasn't asked anything.");
  });
});
