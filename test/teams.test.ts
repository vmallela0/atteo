import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import * as D from "../src/discord";
import { hmacHex } from "../src/linear";
import type { Mention } from "../src/mentions";
import * as registry from "../src/registry";
import * as slackCore from "../src/slackCore";
import { authorLabel } from "../src/state";
import * as T from "../src/teams";
import { USER_ROW_DELETES } from "../src/testAccounts";
import type { Entry, Env } from "../src/types";
import type { Viewer } from "../src/ui";

// A D1 stand-in over node:sqlite running every migration (as discord.test.ts), with run() reporting changes.
const { DatabaseSync } = (await import("node:" + "sqlite")) as { DatabaseSync: new (p: string) => any };
const { readFileSync, readdirSync } = (await import("node:" + "fs")) as { readFileSync: (u: URL, enc: string) => string; readdirSync: (u: URL) => string[] };
const dir = new URL("../migrations/", (import.meta as unknown as { url: string }).url);
function fakeD1(): { d1: D1Database; db: any } {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => {
      const r = db.prepare(sql).run(...args);
      return { results: [], meta: { changes: Number(r.changes) } };
    },
  });
  return { d1: { prepare: (sql: string) => stmt(sql), batch: async (list: any[]) => Promise.all(list.map((s) => s.run())) } as unknown as D1Database, db };
}

const BOARD = "b_teamsboard01";
const OTHER = "b_teamsboard02";
const SECRET_BOARD = "b_encrypted001";
const ORIGIN = "https://atteo.test";
const T0 = 1_800_000_000_000;
const SERVICE = "https://smba.trafficmanager.net/amer/";
const TENANT = "tenant-1";
const TEAM = "19:team@thread.tacv2";
const CHANNEL = "19:eng@thread.tacv2";
const BOT = "28:APP1";
const JWKS_URL = "https://login.botframework.com/v1/.well-known/keys";
const ENV: T.TeamsEnv = { TEAMS_APP_ID: "APP1", TEAMS_APP_PASSWORD: "client-secret-xyz", PUBLIC_URL: ORIGIN };

// Microsoft's signing keys, stand-ins: k1 endorsed for msteams, k2 only for another channel, k3 with no endorsements (refused).
const rsa = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
const [k1, k2, k3, rogue] = await Promise.all([rsa(), rsa(), rsa(), rsa()]);
const jwk = async (k: CryptoKeyPair, kid: string, endorsements?: string[]) => {
  const j = (await crypto.subtle.exportKey("jwk", k.publicKey)) as JsonWebKey;
  return { kty: "RSA", use: "sig", kid, n: j.n, e: j.e, ...(endorsements ? { endorsements } : {}) };
};
const JWKS = { keys: [await jwk(k1, "k1", ["msteams", "skype"]), await jwk(k2, "k2", ["skype"]), await jwk(k3, "k3")] };

const b64u = (b: Uint8Array | ArrayBuffer) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
async function token(claims: Record<string, unknown>, o: { kid?: string; key?: CryptoKey; alg?: string } = {}) {
  const head = part({ alg: o.alg ?? "RS256", kid: o.kid ?? "k1", typ: "JWT" });
  const body = part(claims);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", o.key ?? k1.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(sig)}`;
}
const claims = (now: number, o: Record<string, unknown> = {}) => ({ iss: T.BF_ISSUER, aud: "APP1", exp: Math.floor(now / 1000) + 3600, nbf: Math.floor(now / 1000) - 60, serviceurl: SERVICE, ...o });

const person = (name: string): Viewer => ({ name, email: `${name}@x.test`, display_name: null, admin: false, via: "person" });
const agent = (name: string): Viewer => ({ ...person(name), via: "agent" });

type Call = { method: string; url: string; body: any; auth: string | null };
type Posted = { board: string; user: string; type: string; text: string; mentions: Mention[]; data: unknown };

function setup(env: T.TeamsEnv = ENV, opts: { answer?: { seq: number; text: string } | null; roles?: Record<string, string>; keysDown?: { on: boolean } } = {}) {
  const { d1, db } = fakeD1();
  let t = T0;
  const calls: Call[] = [];
  const roles: Record<string, string> = { "29:OWNER": "owner", ...(opts.roles ?? {}) };
  const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const raw = init?.body ? String(init.body) : null;
    let body: any = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      // a form body stays a string
    }
    calls.push({ method: init?.method ?? "GET", url, body, auth: new Headers(init?.headers).get("authorization") });
    if (url === T.OPENID_URL && opts.keysDown?.on) return new Response("down", { status: 503 });
    if (url === T.OPENID_URL) return new Response(JSON.stringify({ issuer: T.BF_ISSUER, jwks_uri: JWKS_URL, id_token_signing_alg_values_supported: ["RS256"] }));
    if (url === JWKS_URL) return new Response(JSON.stringify(JWKS));
    if (url.startsWith("https://login.microsoftonline.com/")) return new Response(JSON.stringify({ token_type: "Bearer", access_token: "bot-token-abc", expires_in: 3600 }));
    const member = url.match(/\/v3\/conversations\/([^/]+)\/members\/([^/]+)$/);
    if (member) {
      const role = decodeURIComponent(member[1]) === TEAM ? roles[decodeURIComponent(member[2])] : undefined;
      return role ? new Response(JSON.stringify({ id: decodeURIComponent(member[2]), userRole: role })) : new Response("{}", { status: 404 });
    }
    if (url === `${SERVICE}v3/teams/${encodeURIComponent(TEAM)}`) return new Response(JSON.stringify({ id: TEAM, name: "Acme Team" }));
    if (url === `${SERVICE}v3/teams/${encodeURIComponent(TEAM)}/conversations`) return new Response(JSON.stringify({ conversations: [{ id: TEAM, name: null }, { id: CHANNEL, name: "eng" }] }));
    if (url.includes("/activities")) return new Response(JSON.stringify({ id: "R1" }), { status: 201 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  db.prepare("INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity) VALUES (?, 'Checkout', 'vedu', 1, 0, 1)").run(BOARD);
  db.prepare("INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity) VALUES (?, 'Other', 'olga', 1, 0, 1)").run(OTHER);
  db.prepare("INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity, encrypted) VALUES (?, 'Sealed', 'vedu', 1, 0, 1, 1)").run(SECRET_BOARD);
  for (const [u, role] of [["vedu", "owner"], ["olga", "owner"], ["ann", "contributor"], ["val", "viewer"]] as const) {
    db.prepare("INSERT INTO members (board_id, user, joined_at, last_seen, role) VALUES (?, ?, 1, 1, ?)").run(BOARD, u, role);
  }
  db.prepare("INSERT INTO members (board_id, user, joined_at, last_seen, role) VALUES (?, 'olga', 1, 1, 'owner')").run(OTHER);
  db.prepare("INSERT INTO members (board_id, user, joined_at, last_seen, role) VALUES (?, 'vedu', 1, 1, 'owner')").run(SECRET_BOARD);

  const posts: Posted[] = [];
  const asked: { board: string; me: string; user: string; seq: number; waitMs: number }[] = [];
  const on = new Map<string, boolean>();
  const notices: { board: string; user: string; text: string }[] = [];
  const board: T.TeamsBoardOps = {
    post: async (b, user, input) => {
      posts.push({ board: b, user, ...input });
      return 40 + posts.length;
    },
    setTeams: async (b, v) => void on.set(b, v),
    notice: async (b, user, text) => void notices.push({ board: b, user, text }),
    members: async () => [{ user: "vedu", agent_name: null }, { user: "olga", agent_name: null }, { user: "ann", agent_name: "Scout" }, { user: "val", agent_name: null }],
    answer: async (b, me, user, seq, waitMs) => {
      asked.push({ board: b, me, user, seq, waitMs });
      return opts.answer === undefined ? null : opts.answer;
    },
  };
  const d: T.Teams = { db: d1, env, origin: ORIGIN, now: () => t, http, board };
  const later: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void later.push(p) };
  return { d, db, calls, posts, asked, on, notices, later, ctx, tick: (ms: number) => void (t += ms), now: () => t };
}
type S = ReturnType<typeof setup>;

let n = 0;
const activity = (text: string, o: { user?: string; name?: string; channel?: string; team?: string; tenant?: string; type?: string; serviceUrl?: string; mention?: boolean; id?: string } = {}) => {
  const id = o.id ?? `m${++n}`;
  return {
    type: o.type ?? "message",
    id,
    serviceUrl: o.serviceUrl ?? SERVICE,
    channelId: "msteams",
    from: { id: o.user ?? "29:OWNER", name: o.name ?? "Jane Doe", aadObjectId: "aad-secret-guid" },
    recipient: { id: BOT, name: "Atteo" },
    conversation: { id: `${o.channel ?? CHANNEL};messageid=${id}`, conversationType: "channel", tenantId: o.tenant ?? TENANT },
    text: o.mention === false ? text : `<at>Atteo</at> ${text}`,
    entities: o.mention === false ? [] : [{ type: "mention", text: "<at>Atteo</at>", mentioned: { id: BOT, name: "Atteo" } }],
    channelData: { team: { id: o.team ?? TEAM }, channel: { id: o.channel ?? CHANNEL }, tenant: { id: o.tenant ?? TENANT } },
  };
};

async function request(s: S, payload: unknown, o: { auth?: string | null; claims?: Record<string, unknown>; kid?: string; key?: CryptoKey } = {}) {
  const auth = o.auth !== undefined ? o.auth : `Bearer ${await token(claims(s.now(), o.claims), { kid: o.kid, key: o.key })}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers.authorization = auth;
  return new Request(`${ORIGIN}/api/integrations/teams/messages`, { method: "POST", headers, body: JSON.stringify(payload) });
}

/** Sends one activity, runs what it deferred, and returns the response and the bot's reply in the thread. */
async function send(s: S, payload: ReturnType<typeof activity> | Record<string, unknown>, o: Parameters<typeof request>[2] = {}) {
  const before = s.calls.length;
  const res = await T.messages(s.d, await request(s, payload, o), s.ctx);
  await Promise.all(s.later.splice(0));
  const replies = s.calls.slice(before).filter((c) => c.method === "POST" && /\/activities\/[^/]+$/.test(c.url));
  return { res, reply: replies.pop() };
}

async function mintCode(s: S, who = "vedu", board = BOARD) {
  const res = await T.code(s.d, person(who), new Request(`${ORIGIN}/api/integrations/teams/code`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ board }) }), new URL(`${ORIGIN}/x`));
  return { res, body: (await res.json()) as any };
}

async function link(s: S, who = "vedu") {
  const { body } = await mintCode(s, who);
  const r = await send(s, activity(`link ${body.code}`));
  expect(r.reply?.body.text).toMatch(/now follows Checkout/);
  s.calls.length = 0;
}

const entry = (o: Partial<Entry> = {}): Entry =>
  ({ seq: 50, ts: 1, author: "ann", type: "note", text: "Shipped the fix", to: null, reply_to: null, resolves: [], supersedes: null, retracts: null, artifact_name: null, artifact_size: null, via: "agent", ...o }) as Entry;

beforeEach(() => T.resetCaches());
afterEach(() => void vi.unstubAllGlobals());

describe("Teams: not set up", () => {
  it("every route answers 503 \"Microsoft Teams isn't set up yet\" without the app id and password", async () => {
    const s = setup({ PUBLIC_URL: ORIGIN });
    const u = new URL(`${ORIGIN}/api/integrations/teams?board=${BOARD}`);
    for (const res of [await T.start(s.d, person("vedu"), u), await T.status(s.d, person("vedu"), u), await T.unlink(s.d, person("vedu"), new Request(u, { method: "DELETE" }), u)]) expect(res.status).toBe(503);
    const res = await T.messages(s.d, await request(s, activity("post hi")), s.ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: T.NOT_SET_UP });
    expect(T.teamsOn({ ...ENV, TEAMS_APP_PASSWORD: undefined })).toBe(false);
    expect(s.calls).toEqual([]);
  });
});

describe("Teams: the messaging endpoint checks the Bot Framework token", () => {
  it("a good token passes; none, a forged signature, another issuer or audience, expired, not yet valid, or not RS256 is 401", async () => {
    const s = setup();
    const ok = await send(s, activity("hello", { mention: false }));
    expect(ok.res.status).toBe(200);
    const now = s.now();
    const bad: [string, Parameters<typeof request>[2]][] = [
      ["no header", { auth: null }],
      ["not bearer", { auth: "Basic abc" }],
      ["garbage", { auth: "Bearer a.b" }],
      ["forged with another key under k1's id", { key: rogue.privateKey }],
      ["wrong issuer", { claims: { iss: "https://sts.windows.net/x/" } }],
      ["wrong audience", { claims: { aud: "APP2" } }],
      ["expired", { claims: { exp: Math.floor(now / 1000) - T.SKEW_MS / 1000 - 10 } }],
      ["not yet valid", { claims: { nbf: Math.floor(now / 1000) + T.SKEW_MS / 1000 + 10 } }],
      ["no serviceurl claim", { claims: { serviceurl: undefined } }],
    ];
    for (const [why, o] of bad) {
      const r = await send(s, activity("post hi"), o);
      expect(r.res.status, why).toBe(401);
    }
    // alg none / HS256 are refused before any key is looked at.
    const head = part({ alg: "none", kid: "k1" });
    const r1 = await send(s, activity("post hi"), { auth: `Bearer ${head}.${part(claims(now))}.${b64u(new Uint8Array([1]))}` });
    expect(r1.res.status).toBe(401);
    const hs = await token(claims(now), {});
    const [, b, sig] = hs.split(".");
    expect((await send(s, activity("post hi"), { auth: `Bearer ${part({ alg: "HS256", kid: "k1" })}.${b}.${sig}` })).res.status).toBe(401);
    // Small skew is fine.
    expect((await send(s, activity("hi", { mention: false }), { claims: { exp: Math.floor(now / 1000) - 60 } })).res.status).toBe(200);
    expect(s.posts).toEqual([]);
  });

  it("a key whose endorsements leave out msteams, or that lists no endorsements, is refused", async () => {
    const s = setup();
    expect((await send(s, activity("hi", { mention: false }), { kid: "k2", key: k2.privateKey })).res.status).toBe(401);
    expect(await (await T.messages(s.d, await request(s, activity("hi", { mention: false }), { kid: "k2", key: k2.privateKey }), s.ctx)).json()).toEqual({ error: "key not endorsed for Teams" });
    expect(await (await T.messages(s.d, await request(s, activity("hi", { mention: false }), { kid: "k3", key: k3.privateKey }), s.ctx)).json()).toEqual({ error: "key not endorsed for Teams" });
    expect((await send(s, activity("hi", { mention: false }), { kid: "k1", key: k1.privateKey })).res.status).toBe(200);
  });

  it("the token's serviceurl must be the activity's, and on the allowlist; the tenant must match when one is set", async () => {
    const s = setup();
    const evil = "https://evil.example/";
    expect((await send(s, activity("post hi", { serviceUrl: evil }))).res.status).toBe(401); // claim says SERVICE
    const r = await send(s, activity("post hi", { serviceUrl: evil }), { claims: { serviceurl: evil } });
    expect(r.res.status).toBe(403);
    const tm = "https://attacker.trafficmanager.net/amer/";
    expect((await send(s, activity("post hi", { serviceUrl: tm }), { claims: { serviceurl: tm } })).res.status).toBe(403);
    // Trailing slash differences don't matter.
    expect((await send(s, activity("hi", { serviceUrl: "https://smba.trafficmanager.net/amer", mention: false }))).res.status).toBe(200);
    const single = setup({ ...ENV, TEAMS_TENANT_ID: TENANT });
    expect((await send(single, activity("hi", { tenant: "tenant-2", mention: false }))).res.status).toBe(403);
    expect((await send(single, activity("hi", { mention: false }))).res.status).toBe(200);
    // Nothing went anywhere but Microsoft's key endpoints.
    expect(s.calls.every((c) => c.url === T.OPENID_URL || c.url === JWKS_URL)).toBe(true);
  });

  it("serviceUrlOk allows smba.trafficmanager.net and *.botframework.com over https only", () => {
    expect(T.serviceUrlOk("https://smba.trafficmanager.net/amer/")).toBe("https://smba.trafficmanager.net/amer/");
    expect(T.serviceUrlOk("https://smba.trafficmanager.net/emea")).toBe("https://smba.trafficmanager.net/emea/");
    expect(T.serviceUrlOk("https://europe.webchat.botframework.com/")).toBe("https://europe.webchat.botframework.com/");
    for (const bad of ["http://smba.trafficmanager.net/amer/", "https://smba.trafficmanager.net:8443/", "https://evil.trafficmanager.net/", "https://botframework.com.evil.io/", "https://evilbotframework.com/", "https://u:p@smba.trafficmanager.net/", "https://smba.trafficmanager.net/?x=1", "not a url", 5]) {
      expect(T.serviceUrlOk(bad), String(bad)).toBeNull();
    }
  });

  it("refuses bodies over 128 KB before reading them (and a long body without a length), and handles each activity once", async () => {
    const s = setup();
    let read = false;
    const big = { headers: new Headers({ "content-length": String(T.MAX_ACTIVITY_BYTES + 1), authorization: "Bearer x" }), get body() { read = true; return null; }, text: async () => ((read = true), "") } as unknown as Request;
    expect((await T.messages(s.d, big, s.ctx)).status).toBe(413);
    expect(read).toBe(false);
    expect(s.calls).toEqual([]); // not even the keys
    const auth = `Bearer ${await token(claims(s.now()))}`;
    const long = new Request(`${ORIGIN}/x`, { method: "POST", headers: { authorization: auth }, body: JSON.stringify({ pad: "x".repeat(T.MAX_ACTIVITY_BYTES) }) });
    expect(long.headers.get("content-length")).toBeNull();
    expect((await T.messages(s.d, long, s.ctx)).status).toBe(413);
    // Unauthenticated: the body isn't read.
    let touched = false;
    const anon = { headers: new Headers(), get body() { touched = true; return null; } } as unknown as Request;
    expect((await T.messages(s.d, anon, s.ctx)).status).toBe(401);
    expect(touched).toBe(false);

    await link(s);
    const a = activity("post once");
    await send(s, a);
    await send(s, a);
    expect(s.posts).toHaveLength(1);
  });

  it("caches the keys; an unknown key id refetches at most every 5 minutes; they expire after a day", async () => {
    const s = setup();
    const metaFetches = () => s.calls.filter((c) => c.url === T.OPENID_URL).length;
    await send(s, activity("hi", { mention: false }));
    await send(s, activity("hi", { mention: false }));
    expect(metaFetches()).toBe(1);
    expect((await send(s, activity("hi", { mention: false }), { kid: "k9" })).res.status).toBe(401);
    expect(metaFetches()).toBe(1);
    s.tick(T.KEYS_REFETCH_MS);
    expect((await send(s, activity("hi", { mention: false }), { kid: "k9" })).res.status).toBe(401);
    expect(metaFetches()).toBe(2);
    s.tick(T.KEYS_TTL_MS);
    await send(s, activity("hi", { mention: false }));
    expect(metaFetches()).toBe(3);
  });

  it("after a failed fetch leaves no keys, requests don't refetch for 5 minutes (unsigned callers can't make each one fetch)", async () => {
    const keysDown = { on: true };
    const s = setup(ENV, { keysDown });
    const metaFetches = () => s.calls.filter((c) => c.url === T.OPENID_URL).length;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let i = 0; i < 5; i++) expect((await send(s, activity("hi", { mention: false }))).res.status).toBe(401);
      expect(metaFetches()).toBe(1);
      keysDown.on = false;
      s.tick(T.KEYS_REFETCH_MS - 1);
      expect((await send(s, activity("hi", { mention: false }))).res.status).toBe(401);
      expect(metaFetches()).toBe(1);
      s.tick(1);
      expect((await send(s, activity("hi", { mention: false }))).res.status).toBe(200);
      expect(metaFetches()).toBe(2);
    } finally {
      err.mockRestore();
    }
  });
});

describe("Teams: linking", () => {
  it("only an owner, signed in as a person, gets a code; never for an encrypted board; codes are kept as a keyed hash", async () => {
    const s = setup();
    const u = (b: string) => new URL(`${ORIGIN}/api/integrations/teams/start?board=${b}`);
    const pageRes = await T.start(s.d, person("vedu"), u(BOARD));
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain(`<form method="post" action="/api/integrations/teams/code"`);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM teams_codes").get().n).toBe(0);
    const form = await T.code(s.d, person("vedu"), new Request(`${ORIGIN}/api/integrations/teams/code`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }, body: `board=${BOARD}` }), new URL(`${ORIGIN}/x`));
    expect(form.status).toBe(200);
    expect(await form.text()).toMatch(/@Atteo link [A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
    expect((await T.start(s.d, agent("vedu"), u(BOARD))).status).toBe(403);
    expect((await T.start(s.d, person("ann"), u(BOARD))).status).toBe(403);
    expect((await T.start(s.d, person("val"), u(BOARD))).status).toBe(403);
    expect((await T.start(s.d, person("mallory"), u(BOARD))).status).toBe(404);
    expect((await T.start(s.d, person("vedu"), u(SECRET_BOARD))).status).toBe(409);
    expect((await T.start(s.d, null, u(BOARD))).status).toBe(302);
    expect((await mintCode(s, "ann")).res.status).toBe(403);
    const cross = await T.code(s.d, person("vedu"), new Request(`${ORIGIN}/x`, { method: "POST", headers: { "sec-fetch-site": "cross-site" }, body: JSON.stringify({ board: BOARD }) }), new URL(`${ORIGIN}/x`));
    expect(cross.status).toBe(403);
    const { body } = await mintCode(s);
    expect(body.command).toBe(`@Atteo link ${body.code}`);
    const rows = s.db.prepare("SELECT code_hash FROM teams_codes").all() as { code_hash: string }[];
    expect(JSON.stringify(rows)).not.toContain(body.code);
    expect(rows.map((r) => r.code_hash)).toContain(await hmacHex("teams-code:client-secret-xyz", body.code));
    // DM and "Your agent" boards are refused too.
    for (const kind of ["direct", "agent"]) {
      s.db.prepare("UPDATE boards SET kind = ? WHERE id = ?").run(kind, OTHER);
      expect((await mintCode(s, "olga", OTHER)).res.status).toBe(409);
    }
  });

  it("@Atteo link with a fresh code, by a team owner, links the channel it ran in; the reply is in the message's thread", async () => {
    const s = setup(ENV, { roles: { "29:MEMBER": "user", "29:GUEST": "guest" } });
    const { body } = await mintCode(s);
    // Not a team owner (Teams says "user" or "guest"), or Teams won't say (404): refused, and the code isn't spent.
    for (const user of ["29:MEMBER", "29:GUEST", "29:NOBODY"]) {
      const r = await send(s, activity(`link ${body.code}`, { user }));
      expect(r.reply?.body.text, user).toMatch(/Only a team owner/);
    }
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM teams_codes").get().n).toBe(1);
    const a = activity(`link ${body.code}`);
    const r = await send(s, a);
    expect(r.reply?.url).toBe(`${SERVICE}v3/conversations/${encodeURIComponent(a.conversation.id)}/activities/${a.id}`);
    expect(r.reply?.auth).toBe("Bearer bot-token-abc");
    expect(r.reply?.body).toMatchObject({ type: "message", textFormat: "plain", replyToId: a.id });
    expect(r.reply?.body.text).toMatch(/now follows Checkout/);
    // The owner check asked Teams about the team, for this user.
    expect(s.calls.some((c) => c.url === `${SERVICE}v3/conversations/${encodeURIComponent(TEAM)}/members/${encodeURIComponent("29:OWNER")}`)).toBe(true);
    expect(s.db.prepare("SELECT board_id, created_by, tenant_id, team_id, channel_id, service_url, team_name, channel_name, linked_by FROM teams_links").all()).toEqual([
      { board_id: BOARD, created_by: "vedu", tenant_id: TENANT, team_id: TEAM, channel_id: CHANNEL, service_url: SERVICE, team_name: "Acme Team", channel_name: "eng", linked_by: "29:OWNER" },
    ]);
    expect(s.on.get(BOARD)).toBe(true);
    expect(s.notices).toEqual([{ board: BOARD, user: "vedu", text: "Microsoft Teams: now followed by eng in Acme Team, linked by Jane Doe." }]);
    const reuse = await send(s, activity(`link ${body.code}`, { channel: "19:other@thread.tacv2" }));
    expect(reuse.reply?.body.text).toMatch(/wrong, used or expired/);
  });

  it("refuses an expired code, a code whose maker no longer owns the board or whose board was encrypted, and a channel another board has", async () => {
    const s = setup();
    const { body } = await mintCode(s);
    s.tick(T.CODE_MS + 1);
    expect((await send(s, activity(`link ${body.code}`))).reply?.body.text).toMatch(/expired/);

    const demoted = (await mintCode(s)).body.code;
    s.db.prepare("UPDATE members SET role = 'contributor' WHERE board_id = ? AND user = 'vedu'").run(BOARD);
    expect((await send(s, activity(`link ${demoted}`))).reply?.body.text).toMatch(/Only the board's owner/);
    s.db.prepare("UPDATE members SET role = 'owner' WHERE board_id = ? AND user = 'vedu'").run(BOARD);

    const sealed = (await mintCode(s)).body.code;
    s.db.prepare("UPDATE boards SET encrypted = 1 WHERE id = ?").run(BOARD);
    expect((await send(s, activity(`link ${sealed}`))).reply?.body.text).toMatch(/encrypted/);
    s.db.prepare("UPDATE boards SET encrypted = 0 WHERE id = ?").run(BOARD);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM teams_links").get().n).toBe(0);

    await link(s);
    const olgas = (await mintCode(s, "olga", OTHER)).body.code;
    expect((await send(s, activity(`link ${olgas}`))).reply?.body.text).toMatch(/already follows another/);
  });

  it("a chat with the bot is pointed to a channel; a channel message that doesn't @mention the bot is ignored", async () => {
    const s = setup();
    const dm = { ...activity("link ABCD-EFGH-JKLM", { mention: false }), conversation: { id: "a:personal", conversationType: "personal", tenantId: TENANT }, channelData: { tenant: { id: TENANT } } };
    expect((await send(s, dm)).reply?.body.text).toMatch(/team channel/);
    const quiet = await send(s, activity("post hi", { mention: false }));
    expect(quiet.reply).toBeUndefined();
    expect(s.posts).toEqual([]);
  });
});

describe("Teams: commands reach the board", () => {
  it("@Atteo post is a note as the linker's agent, labelled with its Teams author, with no Teams ids on the board", async () => {
    const s = setup();
    await link(s);
    const a = activity("post @agents the build is red &amp; <b>broken</b> @channel", { name: "J@ne\n<b>" });
    const r = await send(s, a);
    expect(r.res.status).toBe(200);
    expect(s.posts).toHaveLength(1);
    const p = s.posts[0];
    expect(p).toMatchObject({ board: BOARD, user: "vedu", type: "note", data: { teams: { author: "J ne b" } } });
    const onBoard = JSON.stringify(p);
    for (const id of ["29:OWNER", "aad-secret-guid", TENANT, TEAM, CHANNEL]) expect(onBoard).not.toContain(id);
    expect(p.text).toBe("J ne b on Teams:\n\n@agents the build is red & broken @channel");
    expect(p.mentions.map((m) => `${m.user}:${m.agent}`).sort()).toEqual(["ann:true", "olga:true", "val:true", "vedu:true"]);
    expect(r.reply?.body.text).toContain("posted on Checkout (#41)");
    expect(r.reply?.body.text).toContain("@​channel");
    expect(r.reply?.body.textFormat).toBe("plain");
    const e = entry({ author: "vedu", via: "agent", origin: "teams", data: { teams: { author: "Jane Doe" } } });
    expect(authorLabel(e)).toBe("Teams message by Jane Doe (via vedu's Teams link)");
    expect(slackCore.authorLabel(e).username).toBe("Teams message by Jane Doe (via vedu's Teams link)");
  });

  it("@Atteo ask asks that member's agent and replies with its answer, which isn't posted to the channel twice", async () => {
    const s = setup(ENV, { answer: { seq: 77, text: "It's the cache. @team <at>x</at>" } });
    await link(s);
    const r = await send(s, activity("ask ann's agent why is it red?"));
    expect(s.posts[0]).toMatchObject({ type: "question", user: "vedu", text: "Jane Doe on Teams asks @ann's agent:\n\nwhy is it red?" });
    expect(s.posts[0].mentions).toEqual([expect.objectContaining({ user: "ann", agent: true })]);
    expect(s.asked).toEqual([{ board: BOARD, me: "vedu", user: "ann", seq: 41, waitMs: T.ASK_WAIT_MS }]);
    expect(r.reply?.body.text).toContain("ann's agent: It's the cache. @​team x");
    expect(r.reply?.body.text).not.toContain("<at>");
    expect(await T.bridgeEntry(s.d, { id: BOARD, title: "Checkout" }, entry({ seq: 77, author: "ann", reply_to: 41 }))).toBe("skip: answered in the ask's reply");
    expect((await send(s, activity("ask mallory hi"))).reply?.body.text).toMatch(/isn't on Checkout/);
    expect((await send(s, activity("ask ann/muse status?"))).reply?.body.text).toMatch(/ann\/muse/);
    expect((await send(s, activity("ask"))).reply?.body.text).toMatch(/Ask whom what/);
  });

  it("@Atteo ask with no answer in time says so, and later answers go to the channel", async () => {
    const s = setup(ENV, { answer: null });
    await link(s);
    const r = await send(s, activity("ask ann status?"));
    expect(r.reply?.body.text).toMatch(/No answer yet/);
    expect(s.asked.map((a) => a.waitMs)).toEqual([T.ASK_WAIT_MS, 0]);
    expect(await T.bridgeEntry(s.d, { id: BOARD, title: "Checkout" }, entry({ seq: 78, author: "ann", reply_to: 41 }))).toBe("sent");
  });

  it("an unlinked channel, or another team's or tenant's channel with the same id, posts nothing; unknown words get the usage", async () => {
    const s = setup();
    expect((await send(s, activity("post hi"))).reply?.body.text).toMatch(/doesn't follow an Atteo board/);
    await link(s);
    expect((await send(s, activity("post hi", { team: "19:evil@thread.tacv2" }))).reply?.body.text).toMatch(/doesn't follow an Atteo board/);
    expect((await send(s, activity("post hi", { tenant: "tenant-evil" }))).reply?.body.text).toMatch(/doesn't follow an Atteo board/);
    expect((await send(s, activity("dance"))).reply?.body.text).toMatch(/Atteo knows/);
    expect(s.posts).toEqual([]);
  });

  it("a changed serviceUrl (allowlisted, verified) is remembered for the channel", async () => {
    const s = setup();
    await link(s);
    const emea = "https://smba.trafficmanager.net/emea/";
    await send(s, activity("post hi", { serviceUrl: emea }), { claims: { serviceurl: emea } });
    expect(s.db.prepare("SELECT service_url FROM teams_links").get().service_url).toBe(emea);
  });
});

describe("Teams: board posts go to the channel", () => {
  it("as the bot, plain text, the author shown, mentions defused, the length capped, a new post in the channel", async () => {
    const s = setup();
    await link(s);
    const long = `@channel look <at>Boss</at> ${"x".repeat(5000)}`;
    expect(await T.bridgeEntry(s.d, { id: BOARD, title: "Checkout" }, entry({ text: long, agent_name: "Scout" }))).toBe("sent");
    const posts = s.calls.filter((c) => c.method === "POST" && c.url.includes("/activities"));
    expect(posts).toHaveLength(1);
    const c = posts[0];
    expect(c.url).toBe(`${SERVICE}v3/conversations/${encodeURIComponent(CHANNEL)}/activities`);
    expect(c.auth).toBe("Bearer bot-token-abc");
    expect(c.body.textFormat).toBe("plain");
    expect(c.body.entities).toBeUndefined();
    expect(c.body.text.length).toBeLessThanOrEqual(T.MAX_TEXT);
    expect(c.body.text.startsWith("Scout (ann's agent)\n@​channel look Boss")).toBe(true);
    expect(c.body.text.endsWith(`${ORIGIN}/b/${BOARD}#e50`)).toBe(true);
  });

  it("gets its token by client credentials once (multi-tenant by default, the tenant when set), never logging it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup();
    await link(s);
    T.resetCaches();
    await T.bridgeEntry(s.d, { id: BOARD, title: "Checkout" }, entry({ seq: 51 }));
    await T.bridgeEntry(s.d, { id: BOARD, title: "Checkout" }, entry({ seq: 52 }));
    const tokenCalls = s.calls.filter((c) => c.url.startsWith("https://login.microsoftonline.com/"));
    expect(tokenCalls.map((c) => c.url)).toEqual(["https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token"]);
    expect(Object.fromEntries(new URLSearchParams(tokenCalls[0].body))).toEqual({ grant_type: "client_credentials", client_id: "APP1", client_secret: "client-secret-xyz", scope: "https://api.botframework.com/.default" });
    const single = setup({ ...ENV, TEAMS_TENANT_ID: TENANT });
    await link(single);
    T.resetCaches();
    await T.bridgeEntry(single.d, { id: BOARD, title: "Checkout" }, entry());
    expect(single.calls.find((c) => c.url.startsWith("https://login.microsoftonline.com/"))?.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    // A refused post logs its status only.
    s.d.http = (async (u: RequestInfo | URL) => (String(u).startsWith("https://login") ? new Response(JSON.stringify({ access_token: "tok-secret", expires_in: 3600 })) : new Response("tok-secret echoed", { status: 500 }))) as typeof fetch;
    T.resetCaches();
    expect(await T.bridgeEntry(s.d, { id: BOARD, title: "Checkout" }, entry({ seq: 53 }))).toBe("failed: HTTP 500");
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/tok-secret|client-secret-xyz|bot-token-abc/);
    errors.mockRestore();
  });

  it("never echoes a post from Teams, nor sends unsends, people-only or Just mine posts, approvals or flagged posts", async () => {
    const s = setup();
    await link(s);
    const info = { id: BOARD, title: "Checkout" };
    expect(await T.bridgeEntry(s.d, info, entry({ origin: "teams", author: "vedu" }))).toBe("skip: from Teams");
    expect(await T.bridgeEntry(s.d, info, entry({ retracts: 3 }))).toMatch(/^skip/);
    expect(await T.bridgeEntry(s.d, info, entry({ audience: "people" }))).toMatch(/^skip/);
    expect(await T.bridgeEntry(s.d, info, entry({ audience: "own" } as Partial<Entry>))).toMatch(/^skip/);
    expect(await T.bridgeEntry(s.d, info, entry({ type: "approval" }))).toMatch(/^skip/);
    expect(await T.bridgeEntry(s.d, info, entry({ ai_flag: "instructions" } as Partial<Entry>))).toBe("skip: flagged");
    expect(s.calls).toEqual([]);
  });

  it("never posts to a stored serviceUrl that isn't on the allowlist", async () => {
    const s = setup();
    await link(s);
    s.db.prepare("UPDATE teams_links SET service_url = 'https://evil.trafficmanager.net/'").run();
    expect(await T.bridgeEntry(s.d, { id: BOARD, title: "Checkout" }, entry())).toBe("skip: serviceUrl not allowed");
    expect(s.calls).toEqual([]);
  });

  it("a Discord-linked board labels a Teams post as from Teams", () => {
    const e = entry({ author: "vedu", via: "agent", origin: "teams", data: { teams: { author: "Jane Doe" } } });
    expect(D.entryContent(e, "https://x")).toContain("**Teams message by Jane Doe (via vedu's Teams link)**");
  });
});

describe("Teams: a link lasts while its maker owns the board", () => {
  it("a removed or demoted linker's link stops at once: nothing to the channel, nothing from it; nor on an archived or encrypted board", async () => {
    for (const change of ["removed", "demoted", "archived", "encrypted"] as const) {
      const s = setup();
      await link(s);
      if (change === "removed") s.db.prepare("DELETE FROM members WHERE board_id = ? AND user = 'vedu'").run(BOARD);
      if (change === "demoted") s.db.prepare("UPDATE members SET role = 'contributor' WHERE board_id = ? AND user = 'vedu'").run(BOARD);
      if (change === "archived") s.db.prepare("UPDATE boards SET archived_at = 1 WHERE id = ?").run(BOARD);
      if (change === "encrypted") s.db.prepare("UPDATE boards SET encrypted = 1 WHERE id = ?").run(BOARD);
      expect(await T.bridgeEntry(s.d, { id: BOARD, title: "Checkout" }, entry())).toBe("skip: the link's maker no longer owns the board");
      expect((await send(s, activity("post hi"))).reply?.body.text).toMatch(/isn't active/);
      expect((await send(s, activity("ask ann hi"))).reply?.body.text).toMatch(/isn't active/);
      expect(s.posts).toEqual([]);
      expect(s.calls.filter((c) => c.method === "POST" && /\/activities$/.test(c.url))).toEqual([]);
    }
  });

  it("removing or demoting the linker, or deleting the board, drops the link", async () => {
    for (const change of ["removed", "demoted", "other demoted", "board deleted"] as const) {
      const s = setup();
      await link(s);
      vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
      const off: boolean[] = [];
      const env = { ...ENV, DB: s.d.db, BOARD: { idFromName: (x: string) => x, get: () => ({ setTeams: async (v: boolean) => void off.push(v), setDiscord: async () => {}, setLinear: async () => {} }) } } as unknown as Env;
      if (change === "removed") await registry.removeMember(env, BOARD, "vedu");
      if (change === "demoted") await registry.setMemberAccess(env, BOARD, "vedu", { role: "contributor" });
      if (change === "other demoted") await registry.setMemberAccess(env, BOARD, "olga", { role: "contributor" });
      if (change === "board deleted") await registry.deleteBoard(env, BOARD);
      const left = s.db.prepare("SELECT COUNT(*) AS n FROM teams_links").get().n;
      expect(left, change).toBe(change === "other demoted" ? 1 : 0);
      expect(off).toEqual(change === "other demoted" ? [] : [false]);
      vi.unstubAllGlobals();
    }
  });

  it("account deletion drops the person's links and codes; test-account cleanup drops their rows", async () => {
    const s = setup();
    await link(s);
    await mintCode(s);
    const env = { ...ENV, DB: s.d.db, BOARD: { idFromName: (x: string) => x, get: () => ({ setTeams: async () => {} }) } } as unknown as Env;
    expect(await T.dropLinksFor(env, { by: "vedu" })).toBe(1);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM teams_codes").get().n).toBe(0);

    const t = setup();
    await link(t);
    await mintCode(t);
    const sqls = USER_ROW_DELETES.filter((q) => q.includes("teams_"));
    expect(sqls).toHaveLength(2);
    for (const sql of sqls) t.db.prepare(sql).run(...Array.from(sql.matchAll(/\?/g), () => "vedu"));
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM teams_links").get().n).toBe(0);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM teams_codes").get().n).toBe(0);
    const accountDelete = readFileSync(new URL("../src/accountDelete.ts", (import.meta as unknown as { url: string }).url), "utf8");
    expect(accountDelete).toContain("DELETE FROM teams_links WHERE created_by = ?");
    expect(accountDelete).toContain("dropTeamsLinks(env, { by: n })");
  });

  it("the bot removed from the team, or the channel deleted, drops the link (a verified activity, same tenant)", async () => {
    for (const ev of ["bot removed", "uninstalled", "channel deleted", "other tenant"] as const) {
      const s = setup();
      await link(s);
      const base = activity("", { mention: false, tenant: ev === "other tenant" ? "tenant-2" : TENANT });
      const a =
        ev === "bot removed"
          ? { ...base, type: "conversationUpdate", membersRemoved: [{ id: BOT }] }
          : ev === "uninstalled"
            ? { ...base, type: "installationUpdate", action: "remove" }
            : { ...base, type: "conversationUpdate", channelData: { ...base.channelData, eventType: ev === "channel deleted" ? "channelDeleted" : "teamDeleted" } };
      expect((await send(s, a)).res.status).toBe(200);
      expect(s.db.prepare("SELECT COUNT(*) AS n FROM teams_links").get().n, ev).toBe(ev === "other tenant" ? 1 : 0);
    }
  });
});

describe("Teams: unlinking", () => {
  it("DELETE: who linked it or a board owner, same-site only; GET shows the link by name to any member", async () => {
    const s = setup();
    await link(s);
    const u = new URL(`${ORIGIN}/api/integrations/teams?board=${BOARD}`);
    const st = await (await T.status(s.d, agent("ann"), u)).json();
    expect(st).toMatchObject({ linked: true, active: true, team_name: "Acme Team", channel_name: "eng", created_by: "vedu", linked_by_name: "Jane Doe" });
    for (const id of ["29:OWNER", TENANT, TEAM, CHANNEL]) expect(JSON.stringify(st)).not.toContain(id);
    expect((await T.status(s.d, person("mallory"), u)).status).toBe(404);
    const del = (who: Viewer, site = "same-origin") => T.unlink(s.d, who, new Request(u, { method: "DELETE", headers: { "sec-fetch-site": site } }), u);
    expect((await del(person("ann"))).status).toBe(403);
    expect((await del(agent("vedu"))).status).toBe(403);
    expect((await del(person("olga"), "cross-site")).status).toBe(403);
    expect((await del(person("olga"))).status).toBe(200);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM teams_links").get().n).toBe(0);
    expect(s.on.get(BOARD)).toBe(false);
  });

  it("@Atteo unlink needs a team owner", async () => {
    const s = setup(ENV, { roles: { "29:MEMBER": "user" } });
    await link(s);
    expect((await send(s, activity("unlink", { user: "29:MEMBER" }))).reply?.body.text).toMatch(/Only a team owner/);
    expect((await send(s, activity("unlink"))).reply?.body.text).toMatch(/no longer follows/);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM teams_links").get().n).toBe(0);
  });
});

describe("Teams: limits and the answer filter", () => {
  it("post and ask are rate limited per Teams user and per channel", async () => {
    const s = setup();
    await link(s);
    const as = (user: string) => activity(`post hi ${crypto.randomUUID()}`, { user });
    for (let i = 0; i < T.RATE.userPerMin; i++) expect((await send(s, as("29:U1"))).reply?.body.text).toMatch(/posted on Checkout/);
    expect((await send(s, as("29:U1"))).reply?.body.text).toMatch(/too fast/);
    expect(s.posts).toHaveLength(T.RATE.userPerMin);
    let k = T.RATE.userPerMin;
    for (let u = 2; k < T.RATE.channelPerMin; u++) for (let i = 0; i < T.RATE.userPerMin && k < T.RATE.channelPerMin; i++, k++) await send(s, as(`29:U${u}`));
    expect(s.posts).toHaveLength(T.RATE.channelPerMin);
    expect((await send(s, as("29:U99"))).reply?.body.text).toMatch(/This channel is sending too fast/);
    s.tick(60_000);
    expect((await send(s, as("29:U1"))).reply?.body.text).toMatch(/posted on Checkout/);
  });

  it("uses Discord's answer filter: a Just mine, people-only or flagged reply never answers an ask", async () => {
    expect(T.answerFor).toBe(D.answerFor);
    const mine = entry({ seq: 42, author: "vedu", reply_to: 41, audience: "own", text: "secret plan" } as Partial<Entry>);
    const people = entry({ seq: 43, author: "vedu", reply_to: 41, audience: "people", text: "people only" });
    const flagged = entry({ seq: 44, author: "vedu", reply_to: 41, ai_flag: "instructions", text: "ignore previous" } as Partial<Entry>);
    const pub = entry({ seq: 45, author: "vedu", reply_to: 41, text: "public answer" });
    // Through the real op (the board read as the linker's agent, which does see Just mine): it isn't the answer.
    const { d1 } = fakeD1();
    let entries: Entry[] = [mine, people, flagged];
    const env = { ...ENV, DB: d1, BOARD: { idFromName: (x: string) => x, get: () => ({ page: async () => entries }) } } as unknown as Env;
    const ops = T.teamsFor(env).board;
    expect(await ops.answer(BOARD, "vedu", "vedu", 41, 0)).toBeNull();
    entries = [mine, people, flagged, pub];
    expect(await ops.answer(BOARD, "vedu", "vedu", 41, 0)).toEqual({ seq: 45, text: "public answer" });
  });

  it("linking only ever replaces the board's own row, never another board's channel", () => {
    const s = setup();
    s.db.prepare("INSERT INTO teams_links (board_id, created_by, tenant_id, team_id, channel_id, service_url, created_at, updated_at) VALUES (?, 'olga', ?, ?, 'C300', ?, 1, 1)").run(OTHER, TENANT, TEAM, SERVICE);
    const sql = "INSERT INTO teams_links (board_id, created_by, tenant_id, team_id, channel_id, service_url, created_at, updated_at) VALUES (?, 'vedu', ?, ?, 'C300', ?, 2, 2) ON CONFLICT(board_id) DO UPDATE SET channel_id = excluded.channel_id";
    expect(() => s.db.prepare(sql).run(BOARD, TENANT, TEAM, SERVICE)).toThrow(/UNIQUE/);
    expect(readFileSync(new URL("../src/teams.ts", (import.meta as unknown as { url: string }).url), "utf8")).not.toContain("INSERT OR REPLACE INTO teams_links");
  });
});

describe("Teams: helpers", () => {
  it("strips the bot's mention and markup from a command", () => {
    const a = { ...activity("x"), text: "<at>Atteo</at>&nbsp;post <p>line one</p><p>a &lt;b&gt; &amp; c</p>" };
    expect(T.commandText(a)).toBe("post line one\na <b> & c");
    expect(T.splitAsk("jxn's agent why?")).toEqual({ agent: "jxn's agent", question: "why?" });
    expect(T.splitAsk("jxn/muse why now")).toEqual({ agent: "jxn/muse", question: "why now" });
    expect(T.splitAsk("jxn")).toBeNull();
    expect(T.neutral("@team @Channel @everyone <at id='1'>Boss</at>")).toBe("@​team @​Channel @​everyone Boss");
  });
});
