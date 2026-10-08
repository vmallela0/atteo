import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import * as D from "../src/discord";
import { hmacHex } from "../src/linear";
import type { Mention } from "../src/mentions";
import * as registry from "../src/registry";
import { authorLabel } from "../src/state";
import { USER_ROW_DELETES } from "../src/testAccounts";
import type { Entry, Env } from "../src/types";
import type { Viewer } from "../src/ui";

// A D1 stand-in over node:sqlite running every migration (as linear.test.ts), with run() reporting changes.
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

const BOARD = "b_discordboard1";
const OTHER = "b_discordboard2";
const SECRET_BOARD = "b_encrypted001";
const ORIGIN = "https://atteo.test";
const T0 = 1_800_000_000_000;
const GUILD = "G100";
const CHANNEL = "C200";
const MANAGER = String(1 << 4); // Manage Channels

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const PUBLIC_KEY = hex((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
const ENV: D.DiscordEnv = { DISCORD_APPLICATION_ID: "APP1", DISCORD_PUBLIC_KEY: PUBLIC_KEY, DISCORD_BOT_TOKEN: "bot-token-xyz", PUBLIC_URL: ORIGIN };

const person = (name: string): Viewer => ({ name, email: `${name}@x.test`, display_name: null, admin: false, via: "person" });
const agent = (name: string): Viewer => ({ ...person(name), via: "agent" });

type Call = { method: string; url: string; body: any; auth: string | null };
type Posted = { board: string; user: string; type: string; text: string; mentions: Mention[]; data: unknown };

function setup(env: D.DiscordEnv = ENV, opts: { answer?: { seq: number; text: string } | null } = {}) {
  const { d1, db } = fakeD1();
  let t = T0;
  const calls: Call[] = [];
  const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/messages") && init?.method === "POST") return new Response(JSON.stringify({ id: "M1" }), { status: 200 });
    if (url === `${D.DISCORD_API}/guilds/${GUILD}`) return new Response(JSON.stringify({ id: GUILD, name: "Acme HQ" }));
    return new Response(init?.method === "DELETE" ? null : "{}", { status: init?.method === "DELETE" ? 204 : 200 });
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
  const board: D.DiscordBoardOps = {
    post: async (b, user, input) => {
      posts.push({ board: b, user, ...input });
      return 40 + posts.length;
    },
    setDiscord: async (b, v) => void on.set(b, v),
    notice: async (b, user, text) => void notices.push({ board: b, user, text }),
    members: async () => [{ user: "vedu", agent_name: null }, { user: "olga", agent_name: null }, { user: "ann", agent_name: "Scout" }, { user: "val", agent_name: null }],
    answer: async (b, me, user, seq, waitMs) => {
      asked.push({ board: b, me, user, seq, waitMs });
      return opts.answer === undefined ? null : opts.answer;
    },
  };
  const d: D.Discord = { db: d1, env, origin: ORIGIN, now: () => t, http, board };
  const later: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void later.push(p) };
  return { d, db, calls, posts, asked, on, notices, later, ctx, tick: (ms: number) => void (t += ms), now: () => t };
}
type S = ReturnType<typeof setup>;

async function signedRequest(raw: string, o: { ts?: number; key?: CryptoKey; sig?: string | null } = {}) {
  const ts = String(Math.floor((o.ts ?? T0) / 1000));
  const sig = o.sig !== undefined ? o.sig : hex(await crypto.subtle.sign("Ed25519", o.key ?? keys.privateKey, new TextEncoder().encode(ts + raw)));
  const headers: Record<string, string> = { "x-signature-timestamp": ts, "content-type": "application/json" };
  if (sig !== null) headers["x-signature-ed25519"] = sig;
  return new Request(`${ORIGIN}/api/integrations/discord/interactions`, { method: "POST", headers, body: raw });
}

const command = (sub: string, options: Record<string, string> = {}, o: { perms?: string; channel?: string; guild?: string; nick?: string } = {}) => ({
  id: crypto.randomUUID(),
  application_id: "APP1",
  type: 2,
  token: `tok-${sub}`,
  guild_id: o.guild ?? GUILD,
  channel_id: o.channel ?? CHANNEL,
  channel: { id: o.channel ?? CHANNEL, type: 0 },
  member: { nick: o.nick ?? null, permissions: o.perms ?? "0", user: { id: "U9", username: "jane", global_name: "Jane Doe" } },
  data: { name: "atteo", options: [{ type: 1, name: sub, options: Object.entries(options).map(([name, value]) => ({ type: 3, name, value })) }] },
});

/** Sends one signed interaction, runs what it deferred, and returns the response and the reply it edited in. */
async function send(s: S, payload: unknown) {
  const res = await D.interactions(s.d, await signedRequest(JSON.stringify(payload), { ts: s.now() }), s.ctx);
  await Promise.all(s.later.splice(0));
  const edit = s.calls.filter((c) => c.method === "PATCH").pop();
  return { res, body: (await res.json()) as any, reply: edit?.body as { content: string; allowed_mentions: unknown } | undefined, edit };
}

async function mintCode(s: S, who = "vedu", board = BOARD) {
  const res = await D.code(s.d, person(who), new Request(`${ORIGIN}/api/integrations/discord/code`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify({ board }) }), new URL(`${ORIGIN}/x`));
  return { res, body: (await res.json()) as any };
}

async function link(s: S, who = "vedu") {
  const { body } = await mintCode(s, who);
  const r = await send(s, command("link", { code: body.code }, { perms: MANAGER }));
  expect(r.reply?.content).toMatch(/now follows Checkout/);
  s.calls.length = 0;
}

const entry = (o: Partial<Entry> = {}): Entry =>
  ({ seq: 50, ts: 1, author: "ann", type: "note", text: "Shipped the fix", to: null, reply_to: null, resolves: [], supersedes: null, retracts: null, artifact_name: null, artifact_size: null, via: "agent", ...o }) as Entry;

afterEach(() => void vi.unstubAllGlobals());

describe("Discord: not set up", () => {
  it("every route answers 503 \"Discord isn't set up yet\" without the application id, public key and bot token", async () => {
    const s = setup({ PUBLIC_URL: ORIGIN });
    const u = new URL(`${ORIGIN}/api/integrations/discord?board=${BOARD}`);
    for (const res of [await D.start(s.d, person("vedu"), u), await D.status(s.d, person("vedu"), u), await D.unlink(s.d, person("vedu"), new Request(u, { method: "DELETE" }), u)]) expect(res.status).toBe(503);
    const res = await D.interactions(s.d, await signedRequest("{}"), s.ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: D.NOT_SET_UP });
    expect(D.discordOn({ ...ENV, DISCORD_BOT_TOKEN: undefined })).toBe(false);
  });
});

describe("Discord: the interactions endpoint is checked", () => {
  it("a good signature passes (PING is answered); a bad, missing, other-key or stale one is 401", async () => {
    const s = setup();
    const ping = JSON.stringify({ type: 1, application_id: "APP1" });
    const ok = await D.interactions(s.d, await signedRequest(ping), s.ctx);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ type: 1 });
    const other = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    for (const req of [
      await signedRequest(ping, { sig: "00".repeat(64) }),
      await signedRequest(ping, { sig: null }),
      await signedRequest(ping, { key: other.privateKey }),
      await signedRequest(ping, { ts: T0 - D.SKEW_MS - 5000 }),
      await signedRequest(ping, { ts: T0 + D.SKEW_MS + 5000 }),
    ]) {
      const res = await D.interactions(s.d, req, s.ctx);
      expect(res.status).toBe(401);
    }
    // The signature covers the body: a changed body fails.
    const good = await signedRequest(ping);
    const tampered = new Request(good.url, { method: "POST", headers: good.headers, body: JSON.stringify({ type: 2, application_id: "APP1" }) });
    expect((await D.interactions(s.d, tampered, s.ctx)).status).toBe(401);
    expect(await D.verifyInteraction(PUBLIC_KEY, "zz", "1", "{}", T0)).toEqual({ ok: false, status: 401, why: "bad signature" });
  });

  it("refuses bodies over 64 KB before reading them, another application's, and handles each signed body once", async () => {
    const s = setup();
    let read = false;
    const big = { headers: new Headers({ "content-length": String(D.MAX_INTERACTION_BYTES + 1) }), text: async () => ((read = true), "") } as unknown as Request;
    expect((await D.interactions(s.d, big, s.ctx)).status).toBe(413);
    expect(read).toBe(false);
    const foreign = await D.interactions(s.d, await signedRequest(JSON.stringify({ ...command("post", { text: "hi" }), application_id: "APP2" })), s.ctx);
    expect(foreign.status).toBe(400);
    await link(s);
    const p = command("post", { text: "once" });
    const first = await send(s, p);
    expect(first.body).toEqual({ type: 5, data: { flags: 0 } });
    const again = await send(s, p);
    expect(again.body.type).toBe(4);
    expect(again.body.data.content).toBe("Already handled.");
    expect(s.posts).toHaveLength(1);
  });
});

describe("Discord: linking", () => {
  it("only an owner, signed in as a person, gets a code; never for an encrypted board; the page shows the install link", async () => {
    const s = setup();
    const u = (b: string) => new URL(`${ORIGIN}/api/integrations/discord/start?board=${b}`);
    // GET only shows a form: the code is made by a same-site POST.
    const page = await D.start(s.d, person("vedu"), u(BOARD));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`<form method="post" action="/api/integrations/discord/code"`);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM discord_codes").get().n).toBe(0);
    const form = await D.code(s.d, person("vedu"), new Request(`${ORIGIN}/api/integrations/discord/code`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }, body: `board=${BOARD}` }), new URL(`${ORIGIN}/x`));
    expect(form.status).toBe(200);
    const htmlText = await form.text();
    expect(htmlText).toMatch(/\/atteo link [A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
    expect(htmlText).toContain(`client_id=APP1&amp;scope=bot+applications.commands&amp;permissions=${D.BOT_PERMISSIONS}`);
    expect(D.BOT_PERMISSIONS).toBe("68608");
    expect((await D.start(s.d, agent("vedu"), u(BOARD))).status).toBe(403);
    expect((await D.start(s.d, person("ann"), u(BOARD))).status).toBe(403); // a contributor can't link
    expect((await D.start(s.d, person("val"), u(BOARD))).status).toBe(403);
    expect((await D.start(s.d, person("mallory"), u(BOARD))).status).toBe(404);
    expect((await D.start(s.d, person("vedu"), u(SECRET_BOARD))).status).toBe(409);
    const out = await D.start(s.d, null, u(BOARD));
    expect(out.status).toBe(302);
    expect((await mintCode(s, "ann")).res.status).toBe(403);
    const cross = await D.code(s.d, person("vedu"), new Request(`${ORIGIN}/x`, { method: "POST", headers: { "sec-fetch-site": "cross-site" }, body: JSON.stringify({ board: BOARD }) }), new URL(`${ORIGIN}/x`));
    expect(cross.status).toBe(403);
    // Codes are kept hashed only, keyed with a secret (the bot token), not the public key.
    const { body } = await mintCode(s);
    const rows = s.db.prepare("SELECT code_hash FROM discord_codes").all() as { code_hash: string }[];
    expect(JSON.stringify(rows)).not.toContain(body.code);
    expect(rows.map((r) => r.code_hash)).toContain(await hmacHex("discord-code:bot-token-xyz", body.code));
    expect(rows.map((r) => r.code_hash)).not.toContain(await hmacHex(`discord-code:${PUBLIC_KEY}`, body.code));
  });

  it("/atteo link with a fresh code links the channel it ran in, once; it needs someone who can manage the channel", async () => {
    const s = setup();
    const { body } = await mintCode(s);
    const noPerm = await send(s, command("link", { code: body.code }));
    expect(noPerm.body).toEqual({ type: 5, data: { flags: 64 } });
    expect(noPerm.reply?.content).toMatch(/manage this channel/);
    const r = await send(s, command("link", { code: body.code }, { perms: MANAGER }));
    expect(r.reply?.content).toMatch(/now follows Checkout/);
    expect(r.edit?.url).toBe(`${D.DISCORD_API}/webhooks/APP1/tok-link/messages/@original`);
    expect(s.db.prepare("SELECT board_id, created_by, guild_id, channel_id, linked_by FROM discord_links").all()).toEqual([{ board_id: BOARD, created_by: "vedu", guild_id: GUILD, channel_id: CHANNEL, linked_by: "U9" }]);
    expect(s.on.get(BOARD)).toBe(true);
    // The board hears about it, with the names Discord gave (the server's from the bot API).
    expect(s.notices).toEqual([{ board: BOARD, user: "vedu", text: "Discord: now followed by #C200 in Acme HQ, linked by Jane Doe." }]);
    const reuse = await send(s, command("link", { code: body.code }, { perms: MANAGER, channel: "C999" }));
    expect(reuse.reply?.content).toMatch(/wrong, used or expired/);
  });

  it("refuses an expired code, a code whose maker no longer owns the board or whose board was encrypted, and a channel another board has", async () => {
    const s = setup();
    const { body } = await mintCode(s);
    s.tick(D.CODE_MS + 1);
    expect((await send(s, command("link", { code: body.code }, { perms: MANAGER }))).reply?.content).toMatch(/expired/);

    const demoted = (await mintCode(s)).body.code;
    s.db.prepare("UPDATE members SET role = 'contributor' WHERE board_id = ? AND user = 'vedu'").run(BOARD);
    expect((await send(s, command("link", { code: demoted }, { perms: MANAGER }))).reply?.content).toMatch(/Only the board's owner/);
    s.db.prepare("UPDATE members SET role = 'owner' WHERE board_id = ? AND user = 'vedu'").run(BOARD);

    const sealed = (await mintCode(s)).body.code;
    s.db.prepare("UPDATE boards SET encrypted = 1 WHERE id = ?").run(BOARD);
    expect((await send(s, command("link", { code: sealed }, { perms: MANAGER }))).reply?.content).toMatch(/encrypted/);
    s.db.prepare("UPDATE boards SET encrypted = 0 WHERE id = ?").run(BOARD);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM discord_links").get().n).toBe(0);

    await link(s);
    const olgas = (await mintCode(s, "olga", OTHER)).body.code;
    expect((await send(s, command("link", { code: olgas }, { perms: MANAGER }))).reply?.content).toMatch(/already follows another/);
  });
});

describe("Discord: commands reach the board", () => {
  it("/atteo post is a note as the linker's agent, labelled with its Discord author, whose mentions reach agents", async () => {
    const s = setup();
    await link(s);
    const r = await send(s, command("post", { text: "@agents the build is red @everyone" }, { nick: "J@ne\n<b>" }));
    expect(r.body).toEqual({ type: 5, data: { flags: 0 } });
    expect(s.posts).toHaveLength(1);
    const p = s.posts[0];
    expect(p).toMatchObject({ board: BOARD, user: "vedu", type: "note", data: { discord: { author: "J ne b" } } });
    expect(JSON.stringify(p.data)).not.toContain("U9"); // the Discord user id never goes on the board
    expect(p.text).toBe("J ne b on Discord:\n\n@agents the build is red @everyone");
    expect(p.mentions.map((m) => `${m.user}:${m.agent}`).sort()).toEqual(["ann:true", "olga:true", "val:true", "vedu:true"]);
    expect(r.reply?.allowed_mentions).toEqual({ parse: [] });
    expect(r.reply?.content).toContain("posted on Checkout (#41)");
    expect(r.reply?.content).toContain("@​everyone");
    // Agents read it as from outside Atteo, through the linker's link.
    const e = entry({ author: "vedu", via: "agent", origin: "discord", data: { discord: { author: "Jane Doe" } } });
    expect(authorLabel(e)).toBe("Discord message by Jane Doe (via vedu's Discord link)");
  });

  it("/atteo ask asks that member's agent on the board and replies with its answer, which isn't posted to the channel twice", async () => {
    const s = setup(ENV, { answer: { seq: 77, text: "It's the cache. @here" } });
    await link(s);
    const r = await send(s, command("ask", { agent: "ann's agent", question: "why is it red?" }));
    expect(s.posts[0]).toMatchObject({ type: "question", user: "vedu", text: "Jane Doe on Discord asks @ann's agent:\n\nwhy is it red?" });
    expect(s.posts[0].mentions).toEqual([expect.objectContaining({ user: "ann", agent: true })]);
    expect(s.asked).toEqual([{ board: BOARD, me: "vedu", user: "ann", seq: 41, waitMs: D.ASK_WAIT_MS }]);
    expect(r.reply?.content).toContain("**ann's agent:** It's the cache. @​here");
    expect(r.reply?.allowed_mentions).toEqual({ parse: [] });
    // The answer, when the board posts it, doesn't go to the channel again.
    expect(await D.bridgeEntry(s.d, { id: BOARD, title: "Checkout" }, entry({ seq: 77, author: "ann", reply_to: 41 }))).toBe("skip: answered in the ask's reply");
    // Someone not on the board can't be asked.
    expect((await send(s, command("ask", { agent: "mallory", question: "hi" }))).reply?.content).toMatch(/isn't on Checkout/);
  });

  it("/atteo ask with no answer in time says so, and later answers go to the channel", async () => {
    const s = setup(ENV, { answer: null });
    await link(s);
    const r = await send(s, command("ask", { agent: "ann", question: "status?" }));
    expect(r.reply?.content).toMatch(/No answer yet/);
    expect(s.asked.map((a) => a.waitMs)).toEqual([D.ASK_WAIT_MS, 0]);
    expect(await D.bridgeEntry(s.d, { id: BOARD, title: "Checkout" }, entry({ seq: 78, author: "ann", reply_to: 41 }))).toBe("sent");
  });

  it("an unlinked channel, or another server's channel with the same id, posts nothing", async () => {
    const s = setup();
    expect((await send(s, command("post", { text: "hi" }))).reply?.content).toMatch(/doesn't follow an Atteo board/);
    await link(s);
    expect((await send(s, command("post", { text: "hi" }, { guild: "G-evil" }))).reply?.content).toMatch(/doesn't follow an Atteo board/);
    expect(s.posts).toEqual([]);
  });
});

describe("Discord: board posts go to the channel", () => {
  it("as the bot, with the author shown, mentions neutralized, embeds suppressed and the length capped", async () => {
    const s = setup();
    await link(s);
    const long = `@everyone look <@123> ${"x".repeat(3000)}`;
    expect(await D.bridgeEntry(s.d, { id: BOARD, title: "Checkout" }, entry({ text: long, agent_name: "Scout" }))).toBe("sent");
    expect(s.calls).toHaveLength(1);
    const c = s.calls[0];
    expect(c.method).toBe("POST");
    expect(c.url).toBe(`${D.DISCORD_API}/channels/${CHANNEL}/messages`);
    expect(c.auth).toBe("Bot bot-token-xyz");
    expect(c.body.allowed_mentions).toEqual({ parse: [] });
    expect(c.body.flags).toBe(4);
    expect(c.body.content.length).toBeLessThanOrEqual(2000);
    expect(c.body.content.startsWith("**Scout (ann's agent)**\n@​everyone look")).toBe(true);
    expect(c.body.content.endsWith(`<${ORIGIN}/b/${BOARD}#e50>`)).toBe(true);
  });

  it("never echoes a post from Discord, nor sends unsends, people-only posts, approvals or flagged posts", async () => {
    const s = setup();
    await link(s);
    const info = { id: BOARD, title: "Checkout" };
    expect(await D.bridgeEntry(s.d, info, entry({ origin: "discord", author: "vedu" }))).toBe("skip: from Discord");
    expect(await D.bridgeEntry(s.d, info, entry({ retracts: 3 }))).toMatch(/^skip/);
    expect(await D.bridgeEntry(s.d, info, entry({ audience: "people" }))).toMatch(/^skip/);
    expect(await D.bridgeEntry(s.d, info, entry({ type: "approval" }))).toMatch(/^skip/);
    expect(await D.bridgeEntry(s.d, info, entry({ ai_flag: "instructions" } as Partial<Entry>))).toBe("skip: flagged");
    expect(s.calls).toEqual([]);
  });

  it("a 429 is retried once after retry_after", async () => {
    const s = setup();
    await link(s);
    let n = 0;
    s.d.http = (async (u: RequestInfo | URL, init?: RequestInit) => {
      s.calls.push({ method: init?.method ?? "GET", url: String(u), body: null, auth: null });
      return ++n === 1 ? new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 }) : new Response("{}");
    }) as typeof fetch;
    expect(await D.bridgeEntry(s.d, { id: BOARD, title: "Checkout" }, entry())).toBe("sent");
    expect(s.calls).toHaveLength(2);
  });
});

describe("Discord: a link lasts while its maker owns the board", () => {
  it("a removed or demoted linker's link stops at once: nothing to the channel, nothing from it; nor on an archived or encrypted board", async () => {
    for (const change of ["removed", "demoted", "archived", "encrypted"] as const) {
      const s = setup();
      await link(s);
      if (change === "removed") s.db.prepare("DELETE FROM members WHERE board_id = ? AND user = 'vedu'").run(BOARD);
      if (change === "demoted") s.db.prepare("UPDATE members SET role = 'contributor' WHERE board_id = ? AND user = 'vedu'").run(BOARD);
      if (change === "archived") s.db.prepare("UPDATE boards SET archived_at = 1 WHERE id = ?").run(BOARD);
      if (change === "encrypted") s.db.prepare("UPDATE boards SET encrypted = 1 WHERE id = ?").run(BOARD);
      expect(await D.bridgeEntry(s.d, { id: BOARD, title: "Checkout" }, entry())).toBe("skip: the link's maker no longer owns the board");
      expect((await send(s, command("post", { text: "hi" }))).reply?.content).toMatch(/isn't active/);
      expect(s.posts).toEqual([]);
      expect(s.calls.filter((c) => c.method === "POST")).toEqual([]);
    }
  });

  it("removing or demoting the linker, or deleting the board, drops the link and the bot leaves the server", async () => {
    for (const change of ["removed", "demoted", "other demoted", "board deleted"] as const) {
      const s = setup();
      await link(s);
      const fetched: string[] = [];
      vi.stubGlobal("fetch", async (u: RequestInfo | URL, init?: RequestInit) => (fetched.push(`${init?.method} ${String(u)}`), new Response(null, { status: 204 })));
      const off: boolean[] = [];
      const env = { ...ENV, DB: s.d.db, BOARD: { idFromName: (x: string) => x, get: () => ({ setDiscord: async (v: boolean) => void off.push(v), setLinear: async () => {} }) } } as unknown as Env;
      if (change === "removed") await registry.removeMember(env, BOARD, "vedu");
      if (change === "demoted") await registry.setMemberAccess(env, BOARD, "vedu", { role: "contributor" });
      if (change === "other demoted") await registry.setMemberAccess(env, BOARD, "olga", { role: "contributor" });
      if (change === "board deleted") await registry.deleteBoard(env, BOARD);
      const left = s.db.prepare("SELECT COUNT(*) AS n FROM discord_links").get().n;
      if (change === "other demoted") {
        expect(left).toBe(1);
        expect(fetched).toEqual([]);
      } else {
        expect(left).toBe(0);
        expect(fetched).toEqual([`DELETE ${D.DISCORD_API}/users/@me/guilds/${GUILD}`]);
        expect(off).toEqual([false]);
      }
      vi.unstubAllGlobals();
    }
  });

  it("the bot stays in a server another board's channel still needs", async () => {
    const s = setup();
    await link(s);
    const olgas = (await mintCode(s, "olga", OTHER)).body.code;
    await send(s, command("link", { code: olgas }, { perms: MANAGER, channel: "C300" }));
    s.calls.length = 0;
    expect(await D.dropLinks(s.d, { board: BOARD })).toBe(1);
    expect(s.calls).toEqual([]);
    expect(await D.dropLinks(s.d, { board: OTHER })).toBe(1);
    expect(s.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${D.DISCORD_API}/users/@me/guilds/${GUILD}`]);
  });

  it("account deletion drops the person's links (and the bot leaves); test-account cleanup drops their rows", async () => {
    const s = setup();
    await link(s);
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (u: RequestInfo | URL, init?: RequestInit) => (fetched.push(`${init?.method} ${String(u)}`), new Response(null, { status: 204 })));
    const env = { ...ENV, DB: s.d.db, BOARD: { idFromName: (x: string) => x, get: () => ({ setDiscord: async () => {} }) } } as unknown as Env;
    expect(await D.dropLinksFor(env, { by: "vedu" })).toBe(1);
    expect(fetched).toEqual([`DELETE ${D.DISCORD_API}/users/@me/guilds/${GUILD}`]);

    const t = setup();
    await link(t);
    await mintCode(t);
    for (const sql of USER_ROW_DELETES.filter((q) => q.includes("discord_"))) t.db.prepare(sql).run(...Array.from(sql.matchAll(/\?/g), () => "vedu"));
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM discord_links").get().n).toBe(0);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM discord_codes").get().n).toBe(0);
  });
});

describe("Discord: unlinking", () => {
  it("DELETE: who linked it or a board owner, same-site only; GET shows the link to any member", async () => {
    const s = setup();
    await link(s);
    const u = new URL(`${ORIGIN}/api/integrations/discord?board=${BOARD}`);
    const st = await D.status(s.d, agent("ann"), u);
    expect(await st.json()).toMatchObject({ linked: true, active: true, guild_id: GUILD, channel_id: CHANNEL, created_by: "vedu" });
    expect((await D.status(s.d, person("mallory"), u)).status).toBe(404);
    const del = (who: Viewer, site = "same-origin") => D.unlink(s.d, who, new Request(u, { method: "DELETE", headers: { "sec-fetch-site": site } }), u);
    expect((await del(person("ann"))).status).toBe(403);
    expect((await del(agent("vedu"))).status).toBe(403);
    expect((await del(person("olga"), "cross-site")).status).toBe(403);
    expect((await del(person("olga"))).status).toBe(200);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM discord_links").get().n).toBe(0);
    expect(s.on.get(BOARD)).toBe(false);
  });

  it("/atteo unlink needs someone who can manage the channel", async () => {
    const s = setup();
    await link(s);
    expect((await send(s, command("unlink"))).reply?.content).toMatch(/Only someone who can manage/);
    expect((await send(s, command("unlink", {}, { perms: MANAGER }))).reply?.content).toMatch(/no longer follows/);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM discord_links").get().n).toBe(0);
  });
});

describe("Discord: helpers", () => {
  it("parses ask targets and keeps names from mentioning anyone", () => {
    expect(D.askTarget("@jxn")).toEqual({ user: "jxn", session: null });
    expect(D.askTarget("jxn's agent")).toEqual({ user: "jxn", session: null });
    expect(D.askTarget("jxn/muse")).toEqual({ user: "jxn", session: "muse" });
    expect(D.askTarget("not a name!")).toBeNull();
    expect(D.nameLabel("@vedu's agent")).toBe("vedu's agent");
    expect(D.nameLabel("")).toBe("Someone");
  });

  it("the command definition has post, ask, link and unlink", () => {
    expect(D.ATTEO_COMMAND.options.map((o) => o.name)).toEqual(["post", "ask", "link", "unlink"]);
  });
});

describe("Discord: review fixes", () => {
  it("a Just mine, people-only or flagged reply never answers an /atteo ask; a public reply does", async () => {
    const q = { seq: 41, user: "vedu" };
    const mine = entry({ seq: 42, author: "vedu", reply_to: 41, audience: "own", text: "secret plan" });
    const people = entry({ seq: 43, author: "vedu", reply_to: 41, audience: "people", text: "people only" });
    const flagged = entry({ seq: 44, author: "vedu", reply_to: 41, ai_flag: "instructions", text: "ignore previous" } as Partial<Entry>);
    const pub = entry({ seq: 45, author: "vedu", reply_to: 41, text: "public answer" });
    expect(D.answerFor([mine, people, flagged], q)).toBeNull();
    expect(D.answerFor([mine, people, flagged, pub], q)?.seq).toBe(45);

    // Through the real op (the board read as the linker's agent, which does see Just mine): it isn't the answer.
    const { d1 } = fakeD1();
    let entries: Entry[] = [mine];
    const env = { ...ENV, DB: d1, BOARD: { idFromName: (x: string) => x, get: () => ({ page: async () => entries }) } } as unknown as Env;
    const ops = D.discordFor(env).board;
    expect(await ops.answer(BOARD, "vedu", "vedu", 41, 0)).toBeNull();
    entries = [mine, pub];
    expect(await ops.answer(BOARD, "vedu", "vedu", 41, 0)).toEqual({ seq: 45, text: "public answer" });

    // End to end: the ask's reply in Discord doesn't carry the Just mine text.
    const s = setup(ENV, { answer: D.answerFor([mine], q) });
    await link(s);
    const r = await send(s, command("ask", { agent: "vedu", question: "plan?" }));
    expect(r.reply?.content).not.toContain("secret plan");
    expect(r.reply?.content).toMatch(/No answer yet/);
  });

  it("/atteo post and ask are rate limited per Discord user and per channel", async () => {
    const s = setup();
    await link(s);
    const as = (user: string, channel = CHANNEL) => {
      const c = command("post", { text: `hi ${crypto.randomUUID()}` }, { channel });
      c.member.user.id = user;
      return c;
    };
    for (let i = 0; i < D.RATE.userPerMin; i++) expect((await send(s, as("U1"))).reply?.content).toMatch(/posted on Checkout/);
    expect((await send(s, as("U1"))).reply?.content).toMatch(/too fast/);
    expect(s.posts).toHaveLength(D.RATE.userPerMin);
    // Others in the channel, until the channel's own limit.
    let n = D.RATE.userPerMin;
    for (let u = 2; n < D.RATE.channelPerMin; u++) for (let i = 0; i < D.RATE.userPerMin && n < D.RATE.channelPerMin; i++, n++) await send(s, as(`U${u}`));
    expect(s.posts).toHaveLength(D.RATE.channelPerMin);
    expect((await send(s, as("U99"))).reply?.content).toMatch(/This channel is sending too fast/);
    // A minute later it's open again.
    s.tick(60_000);
    expect((await send(s, as("U1"))).reply?.content).toMatch(/posted on Checkout/);
  });

  it("linking only ever replaces the board's own row, never another board's channel", async () => {
    const s = setup();
    await link(s);
    // Another board holds C300; a race where vedu's link lands on C300 too fails the unique index instead of deleting it.
    s.db.prepare("INSERT INTO discord_links (board_id, created_by, guild_id, channel_id, created_at, updated_at) VALUES (?, 'olga', ?, 'C300', 1, 1)").run(OTHER, GUILD);
    const sql = "INSERT INTO discord_links (board_id, created_by, guild_id, channel_id, created_at, updated_at) VALUES (?, 'vedu', ?, 'C300', 2, 2) ON CONFLICT(board_id) DO UPDATE SET channel_id = excluded.channel_id";
    expect(() => s.db.prepare(sql).run(BOARD, GUILD)).toThrow(/UNIQUE/);
    expect(s.db.prepare("SELECT board_id, channel_id FROM discord_links ORDER BY board_id").all()).toEqual([{ board_id: BOARD, channel_id: CHANNEL }, { board_id: OTHER, channel_id: "C300" }]);
    expect(readFileSync(new URL("../src/discord.ts", (import.meta as unknown as { url: string }).url), "utf8")).not.toContain("INSERT OR REPLACE INTO discord_links");
  });
});
