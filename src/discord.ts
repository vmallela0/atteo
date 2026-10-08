// The Discord integration (vedu #6508, plan #6509 item 2). One Discord channel follows one Atteo board, like the Slack
// bridge: the board's posts show in the channel, and /atteo post and /atteo ask in the channel reach the board.
//
// - Link: a board owner, signed in on Atteo (never an agent token), opens GET /api/integrations/discord/start?board=<id>
//   and presses Get a link code, a same-site POST /api/integrations/discord/code {board} (JSON works too). That mints a
//   one-time code (10 minutes, single use, only its hash kept, keyed with the bot token, bound to them and the board) and
//   shows the bot's install link. In the channel, someone who can manage it runs
//   `/atteo link <code>`: the channel is where the command ran, so there's no picker and no OAuth callback, and no
//   token is stored (the bot's token is the DISCORD_BOT_TOKEN secret). Never an encrypted board, a DM or "Your agent".
//   One channel per board and one board per channel. The board gets a notice naming the channel, server and who ran it.
// - The link lasts while its maker owns the board: removing or demoting them, deleting the board or their account drops
//   it (dropLinks), and the bot leaves the server when no other board's channel there needs it (Discord's "revoke").
//   `/atteo unlink` (channel managers) and DELETE /api/integrations/discord (the linker or a board owner) drop it too.
// - Discord → board: POST /api/integrations/discord/interactions, Discord's Interactions endpoint. Every request is
//   checked: Ed25519 signature (X-Signature-Ed25519 over X-Signature-Timestamp + the raw body, DISCORD_PUBLIC_KEY),
//   a timestamp within 5 minutes, at most 64 KB (refused before reading), this application's, each signed body once.
//   PING is answered; commands are deferred at once (Discord allows 3 seconds) and finished in waitUntil by editing the
//   original reply. `/atteo post <text>` is a note on the board; `/atteo ask <agent> <question>` is a question on the
//   board to that member's agent, whose answer (if it comes within ~20s) is the command's reply. Both are the linker's
//   agent's post, client "Discord", origin "discord" (server-set), with the Discord name as a label in the text: agents
//   read it as "Discord message by <name> (via <linker>'s Discord link)", never as the linker's own words. Its @mentions
//   route like any post (@agents, @vedu's agent). It's untrusted board text like any other. Only the Discord display
//   name goes on the board, never the user id. Rate limited per Discord user and per channel (RATE). An ask's answer
//   must be public on the board (no Just mine or people-only reply, nothing flagged: answerFor).
// - Board → Discord: every public post on a linked board (not people-only or just-mine, not a notice, an approval, a
//   flagged post, an unsend, or a post from Discord) is a bot message in the channel: author shown, length-capped,
//   mentions neutralized (allowed_mentions: {parse: []}), link previews suppressed. Sent in the board object's
//   waitUntil, in order per board. Only while the linker still owns the board and it isn't deleted, archived or
//   encrypted.
//
// Off until DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY and DISCORD_BOT_TOKEN are set: the routes answer 503 "Discord
// isn't set up yet". DISCORD_CLIENT_SECRET isn't needed (no OAuth code exchange).

import type { Board } from "./board";
import { hmacHex, sha256 } from "./linear";
import { mayMention, parseMentions, type Mention, type MemberRef } from "./mentions";
import * as registry from "./registry";
import { flagOf } from "./slackCore";
import { authorLabel } from "./state";
import type { Entry, Env } from "./types";
import { page, type Viewer } from "./ui";
import { esc as html } from "./util";
import { waitForBoard } from "./waits";

export const DISCORD_API = "https://discord.com/api/v10";
export const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
/** View Channel (1 << 10) + Send Messages (1 << 11) + Read Message History (1 << 16). */
export const BOT_PERMISSIONS = String((1 << 10) + (1 << 11) + (1 << 16));
export const CODE_MS = 10 * 60_000;
export const SKEW_MS = 5 * 60_000;
export const SEEN_MS = 24 * 3600_000;
export const ASK_WAIT_MS = 20_000;
export const MAX_INTERACTION_BYTES = 64_000;
export const MAX_CONTENT = 1900; // Discord's limit is 2000
export const NOT_SET_UP = "Discord isn't set up yet";
const EPHEMERAL = 64;
const SUPPRESS_EMBEDS = 4;
// Discord permission bits a member needs to link or unlink a channel: Administrator, Manage Channels or Manage Server.
const MANAGE = (1n << 3n) | (1n << 4n) | (1n << 5n);

/** The /atteo command, registered once: PUT /applications/{id}/commands with [ATTEO_COMMAND] (docs/FEATURES.md). */
export const ATTEO_COMMAND = {
  name: "atteo",
  type: 1,
  description: "The Atteo board this channel follows",
  contexts: [0],
  integration_types: [0],
  options: [
    { type: 1, name: "post", description: "Post a note on the linked Atteo board", options: [{ type: 3, name: "text", description: "What to post", required: true, max_length: 2000 }] },
    {
      type: 1,
      name: "ask",
      description: "Ask a board member's agent; the answer comes back here",
      options: [
        { type: 3, name: "agent", description: "Whose agent: jxn, or jxn/muse for one of their sessions", required: true, max_length: 80 },
        { type: 3, name: "question", description: "The question", required: true, max_length: 2000 },
      ],
    },
    { type: 1, name: "link", description: "Link this channel to an Atteo board (the code is on Atteo)", options: [{ type: 3, name: "code", description: "The code from Atteo", required: true, max_length: 40 }] },
    { type: 1, name: "unlink", description: "Stop this channel following its Atteo board" },
  ],
};

export type DiscordEnv = {
  DISCORD_APPLICATION_ID?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_BOT_TOKEN?: string;
  PUBLIC_URL?: string;
};

/** Whether the integration exists here at all. */
export const discordOn = (env: DiscordEnv): boolean => !!(env.DISCORD_APPLICATION_ID && env.DISCORD_PUBLIC_KEY && env.DISCORD_BOT_TOKEN);

// ---- pure parts ----

const enc = new TextEncoder();
const fromHex = (s: string): Uint8Array | null => (/^(?:[0-9a-f]{2})+$/i.test(s) ? Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16)) : null);

export type Check = { ok: true } | { ok: false; status: number; why: string };

/** Whether a request really is Discord's: an Ed25519 signature over timestamp + raw body, sent in the last 5 minutes. */
export async function verifyInteraction(publicKey: string | undefined, signature: string | null, timestamp: string | null, raw: string, nowMs: number): Promise<Check> {
  if (!publicKey) return { ok: false, status: 503, why: NOT_SET_UP };
  if (!signature || !timestamp) return { ok: false, status: 401, why: "unsigned" };
  const sig = fromHex(signature.trim());
  const key = fromHex(publicKey.trim());
  if (!sig || sig.length !== 64 || !key || key.length !== 32) return { ok: false, status: 401, why: "bad signature" };
  let good = false;
  try {
    const k = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    good = await crypto.subtle.verify({ name: "Ed25519" }, k, sig, enc.encode(timestamp + raw));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, status: 401, why: "bad signature" };
  const ts = Number(timestamp);
  if (!/^\d{1,12}$/.test(timestamp) || !Number.isFinite(ts) || Math.abs(nowMs - ts * 1000) > SKEW_MS) return { ok: false, status: 401, why: "stale timestamp" };
  return { ok: true };
}

/** A Discord person's name as a plain label in board text: no @ (it can't mention anyone), one line, short. */
export function nameLabel(s: unknown): string {
  return String(s ?? "").replace(/[@\r\n\t<>`*_~[\]|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Someone";
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);

/** The board note for /atteo post: its Discord author as a label, then the words. */
export function postNote(author: string, text: string): string {
  const head = `${nameLabel(author)} on Discord:`;
  return `${head}\n\n${clip(text.trim(), 2900 - head.length)}`;
}

/** Board text going to Discord: no @everyone/@here even as text (allowed_mentions stops the pings as well). */
export function neutral(s: string): string {
  return s.replace(/@(everyone|here)\b/gi, "@​$1");
}

const KIND: Record<string, string> = { question: "❓ Question", decision: "✅ Decision", task: "📋 Task", change: "🔀 Change", handoff: "🚦 Ready to land", artifact: "📎 File", claim: "🙋 On it" };

/** A board entry as a Discord message's content: who, what kind, the words (capped), and the way back to the board. */
export function entryContent(e: Entry, url: string): string {
  const who = neutral(authorLabel(e)).replace(/[*_`~|]/g, "");
  const head = [`**${who}**`, KIND[e.type], e.title ? neutral(e.title) : null].filter(Boolean).join(" · ");
  const files = e.type === "artifact" || e.attachments?.length || e.media;
  const body = files ? `${e.artifact_name ?? e.attachments?.map((a) => a.name).join(", ") ?? "A file"} (open it in Atteo)${e.text ? `\n${e.text}` : ""}` : e.text;
  const tail = `\n<${url}>`;
  return clip(`${head}\n${neutral(body ?? "")}`.trim(), MAX_CONTENT - tail.length) + tail;
}

/** Who an /atteo ask is for: "jxn", "@jxn", "jxn's agent" → jxn; "jxn/muse" → one of jxn's sessions. */
export function askTarget(raw: string): { user: string; session: string | null } | null {
  const s = raw.trim().toLowerCase().replace(/[‘’`]/g, "'").replace(/^@/, "").replace(/(?:'s)? agents?$/, "").trim();
  const m = s.match(/^([a-z0-9][a-z0-9_.-]{0,31})(?:\/([a-z0-9][a-z0-9_.-]{0,39}))?$/);
  return m ? { user: m[1], session: m[2] ?? null } : null;
}

// ---- what the integration needs (tests pass stand-ins) ----

export interface DiscordBoardOps {
  /** As the linker's agent (client "Discord", origin "discord"). Returns the new entry's seq. */
  post(board: string, user: string, input: { type: "note" | "question"; text: string; mentions: Mention[]; data: { discord: { author: string } } }): Promise<number>;
  setDiscord(board: string, on: boolean): Promise<void>;
  /** A board notice (client "Discord", no origin): the board hears that a channel now follows it. */
  notice(board: string, user: string, text: string): Promise<void>;
  members(board: string): Promise<(MemberRef & object)[]>;
  /** The reply by `user`'s agent to question `seq` that may leave the board (answerFor), waiting up to waitMs; or null. */
  answer(board: string, me: string, user: string, seq: number, waitMs: number): Promise<{ seq: number; text: string } | null>;
}

export interface Discord {
  db: D1Database;
  env: DiscordEnv;
  origin: string;
  now(): number;
  http: typeof fetch;
  board: DiscordBoardOps;
}

const stubOf = (env: Env, id: string) => env.BOARD.get(env.BOARD.idFromName(id)) as DurableObjectStub<Board>;

export function discordFor(env: Env, origin?: string): Discord {
  return {
    db: env.DB,
    env,
    origin: (origin ?? env.PUBLIC_URL ?? "https://atteo.dev").replace(/\/$/, ""),
    now: () => Date.now(),
    http: (input, init) => fetch(input, init),
    board: {
      async post(board, user, input) {
        const e = await stubOf(env, board).post(user, { type: input.type, text: input.text, via: "agent", client: "Discord", mentions: input.mentions, data: input.data }, { origin: "discord" });
        await registry.bumpBoard(env, board, e.seq).catch(() => {});
        return e.seq;
      },
      setDiscord: (board, on) => stubOf(env, board).setDiscord(on),
      notice: async (board, user, text) => void (await stubOf(env, board).notice(user, "Discord", text, { via: "agent", client: "Discord", session: null })),
      members: async (board) => (await registry.boardMembers(env, board)).map((m) => ({ user: m.user, agent_name: m.agent_name })),
      async answer(board, me, user, seq, waitMs) {
        // Like askAgent.awaitAnswer, but read as the linker's agent, it would also see their Just mine and people-only
        // replies: only an answer that may leave the board counts (answerFor), else it keeps waiting.
        const s = stubOf(env, board);
        const deadline = Date.now() + Math.max(0, waitMs);
        for (;;) {
          const recent = (await s.page(null, 100, { user: me, person: false })).filter((e) => e.seq > seq);
          const hit = answerFor(recent, { seq, user });
          if (hit) return { seq: hit.seq, text: hit.text };
          const left = deadline - Date.now();
          if (left < 250) return null;
          await waitForBoard(s, { kind: "any", after: recent.length ? recent[recent.length - 1].seq : seq }, left);
        }
      },
    },
  };
}

/** The answer to an /atteo ask that may go to Discord: `user`'s agent's reply to `seq`, public (no audience) and not flagged. */
export function answerFor(entries: Entry[], q: { seq: number; user: string }): Entry | null {
  return entries.find((e) => e.seq > q.seq && e.author === q.user && e.via === "agent" && e.retracts == null && !e.audience && (e.reply_to === q.seq || (e.resolves ?? []).includes(q.seq)) && !flagOf(e)) ?? null;
}

// ---- D1 rows ----

export interface LinkRow {
  board_id: string;
  created_by: string;
  guild_id: string;
  channel_id: string;
  linked_by: string | null;
  linked_by_name: string | null;
  created_at: number;
  updated_at: number;
}

const linkOf = (d: Discord, board: string) => d.db.prepare(`SELECT * FROM discord_links WHERE board_id = ?`).bind(board).first<LinkRow>();
const linkOfChannel = (d: Discord, channel: string) => d.db.prepare(`SELECT * FROM discord_links WHERE channel_id = ?`).bind(channel).first<LinkRow>();

async function firstSeen(d: Discord, key: string): Promise<boolean> {
  const r = await d.db.prepare(`INSERT OR IGNORE INTO discord_seen (key, at) VALUES (?, ?)`).bind(key.slice(0, 200), d.now()).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** The link's maker still stands behind it: an owner of the board, which isn't deleted, archived or encrypted. */
async function linkerOk(d: Discord, board: string, user: string): Promise<boolean> {
  const r = await d.db
    .prepare(`SELECT m.role, m.expires_at, b.deleted_at, b.archived_at, b.encrypted FROM members m JOIN boards b ON b.id = m.board_id WHERE m.board_id = ? AND m.user = ?`)
    .bind(board, user)
    .first<{ role: string; expires_at: number | null; deleted_at: number | null; archived_at: number | null; encrypted: number | null }>();
  return !!r && r.role === "owner" && (r.expires_at == null || r.expires_at > d.now()) && !r.deleted_at && !r.archived_at && !r.encrypted;
}

// ---- Discord's HTTP ----

const bot = (d: Discord) => ({ authorization: `Bot ${d.env.DISCORD_BOT_TOKEN ?? ""}`, "content-type": "application/json", "user-agent": "DiscordBot (https://atteo.dev, 1)" });

/** One bot call; a 429 is retried once after Discord's retry_after (at most 5 seconds). */
async function api(d: Discord, method: string, path: string, body?: unknown): Promise<Response> {
  const go = () => d.http(`${DISCORD_API}${path}`, { method, headers: bot(d), ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
  let res = await go();
  if (res.status === 429) {
    const j = (await res.json().catch(() => null)) as { retry_after?: number } | null;
    await new Promise((r) => setTimeout(r, Math.min(5, Math.max(0, Number(j?.retry_after) || 1)) * 1000));
    res = await go();
  }
  return res;
}

/** The bot leaves a server no linked channel needs any more: the closest Discord has to revoking a token. */
async function leaveIfUnused(d: Discord, guild: string): Promise<void> {
  const still = await d.db.prepare(`SELECT 1 AS x FROM discord_links WHERE guild_id = ? LIMIT 1`).bind(guild).first();
  if (still || !discordOn(d.env)) return;
  const res = await api(d, "DELETE", `/users/@me/guilds/${encodeURIComponent(guild)}`).catch((e) => (console.error("discord leave failed", e), null));
  if (res && !res.ok && res.status !== 404) console.error("discord leave failed", res.status);
}

/**
 * Drop links (one board's, or every one a person made, or a person's on one board): the board stops posting to its
 * channel, their codes go, and the bot leaves servers nothing else needs. Best effort: never throws into what called it
 * (removing a member, deleting a board or an account).
 */
export async function dropLinks(d: Discord, where: { board?: string; by?: string }): Promise<number> {
  try {
    if (!where.board && !where.by) return 0;
    const conds = [where.board ? "board_id = ?" : null, where.by ? "created_by = ?" : null].filter(Boolean).join(" AND ");
    const args = [where.board, where.by].filter((x): x is string => !!x);
    const codeConds = [where.board ? "board_id = ?" : null, where.by ? "user = ?" : null].filter(Boolean).join(" AND ");
    await d.db.prepare(`DELETE FROM discord_codes WHERE ${codeConds}`).bind(...args).run();
    const links = (await d.db.prepare(`SELECT * FROM discord_links WHERE ${conds}`).bind(...args).all<LinkRow>()).results ?? [];
    for (const link of links) {
      await d.db.prepare(`DELETE FROM discord_links WHERE board_id = ?`).bind(link.board_id).run();
      await d.board.setDiscord(link.board_id, false).catch(() => {});
      await leaveIfUnused(d, link.guild_id);
    }
    return links.length;
  } catch (e) {
    console.error("discord unlink failed", e);
    return 0;
  }
}

/** For registry and account deletion: drop the links matching `where` (see dropLinks). */
export const dropLinksFor = (env: Env, where: { board?: string; by?: string }): Promise<number> => dropLinks(discordFor(env), where);

// ---- board → Discord ----

const entryUrl = (d: Discord, board: string, seq: number) => `${d.origin}/b/${board}#e${seq}`;
const askKey = (board: string, seq: number, user: string) => `ask:${board}:${seq}:${user}`;

/** What a linked board's new post does: one bot message in its channel, or nothing. Returns why, for tests and logs. */
export async function bridgeEntry(d: Discord, info: { id: string; title: string }, e: Entry): Promise<string> {
  if (e.origin === "discord") return "skip: from Discord"; // no echo
  if (e.retracts != null || e.audience || e.type === "approval") return "skip: not for the channel";
  if (flagOf(e)) return "skip: flagged"; // it looks like instructions to agents: not carried out of the board
  const link = await linkOf(d, info.id);
  if (!link) return "skip: not linked";
  if (!(await linkerOk(d, info.id, link.created_by))) return "skip: the link's maker no longer owns the board";
  // The answer to an /atteo ask goes back in that command's own reply: not twice.
  if (e.reply_to != null && (await d.db.prepare(`SELECT 1 AS x FROM discord_seen WHERE key = ?`).bind(askKey(info.id, e.reply_to, e.author)).first())) return "skip: answered in the ask's reply";
  const res = await api(d, "POST", `/channels/${encodeURIComponent(link.channel_id)}/messages`, { content: entryContent(e, entryUrl(d, info.id, e.seq)), allowed_mentions: { parse: [] }, flags: SUPPRESS_EMBEDS });
  if (!res.ok) {
    console.error("discord post failed", res.status, await res.text().catch(() => ""));
    return `failed: HTTP ${res.status}`;
  }
  return "sent";
}

/** From the board object, for each new post on a board linked to Discord. */
export async function onEntry(env: Env, info: { id: string; title: string }, e: Entry): Promise<void> {
  if (!discordOn(env)) return;
  await bridgeEntry(discordFor(env), info, e);
}

// ---- Discord → board ----

export interface Interaction {
  id?: string;
  application_id?: string;
  type?: number;
  token?: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { id?: string; type?: number; name?: string };
  member?: { nick?: string | null; permissions?: string; user?: { id?: string; username?: string; global_name?: string | null } };
  user?: { id?: string; username?: string };
  data?: { name?: string; options?: { name?: string; type?: number; value?: unknown; options?: { name?: string; value?: unknown }[] }[] };
}

type Later = { waitUntil(p: Promise<unknown>): void };

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const say = (content: string, ephemeral = true) => json({ type: 4, data: { content, flags: ephemeral ? EPHEMERAL : 0, allowed_mentions: { parse: [] } } });

/** The command's own reply, once it's done (the interaction token lasts 15 minutes; no bot token needed). */
async function finish(d: Discord, token: string, content: string): Promise<void> {
  const res = await d.http(`${DISCORD_API}/webhooks/${encodeURIComponent(d.env.DISCORD_APPLICATION_ID ?? "")}/${encodeURIComponent(token)}/messages/@original`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: clip(content, 2000), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) console.error("discord reply failed", res.status);
}

const optionsOf = (p: Interaction) => {
  const sub = p.data?.options?.[0];
  const o: Record<string, string> = {};
  for (const x of sub?.options ?? []) if (typeof x.name === "string" && typeof x.value === "string") o[x.name] = x.value;
  return { sub: typeof sub?.name === "string" ? sub.name : "", o };
};
const channelOf = (p: Interaction) => p.channel_id ?? p.channel?.id ?? "";
const whoOf = (p: Interaction) => ({ id: p.member?.user?.id ?? null, name: nameLabel(p.member?.nick || p.member?.user?.global_name || p.member?.user?.username) });
const canManage = (p: Interaction) => {
  try {
    return (BigInt(p.member?.permissions ?? "0") & MANAGE) !== 0n;
  } catch {
    return false;
  }
};

/** POST /api/integrations/discord/interactions: checked, deduped, PING answered, commands deferred and done later. */
export async function interactions(d: Discord, request: Request, later: Later): Promise<Response> {
  if (!discordOn(d.env)) return json({ error: NOT_SET_UP }, 503);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_INTERACTION_BYTES) return json({ error: "Payload too large" }, 413);
  const raw = await request.text();
  if (raw.length > MAX_INTERACTION_BYTES) return json({ error: "Payload too large" }, 413);
  const v = await verifyInteraction(d.env.DISCORD_PUBLIC_KEY, request.headers.get("x-signature-ed25519"), request.headers.get("x-signature-timestamp"), raw, d.now());
  if (!v.ok) return json({ error: v.why }, v.status);
  let p: Interaction;
  try {
    p = JSON.parse(raw) as Interaction;
  } catch {
    return json({ error: "not JSON" }, 400);
  }
  if (p.type === 1) return json({ type: 1 }); // PING
  if (p.application_id !== d.env.DISCORD_APPLICATION_ID) return json({ error: "another application" }, 400);
  // Deduped on what was signed (the body).
  if (!(await firstSeen(d, `d:${await sha256(raw)}`))) return say("Already handled.");
  if (p.type !== 2 || p.data?.name !== "atteo" || typeof p.token !== "string") return say("Atteo only knows /atteo post, ask, link and unlink.");
  if (!p.guild_id || !channelOf(p) || !p.member) return say("Use /atteo in a server channel.");
  const { sub } = optionsOf(p);
  if (!["post", "ask", "link", "unlink"].includes(sub)) return say("Atteo only knows /atteo post, ask, link and unlink.");
  const token = p.token;
  later.waitUntil(
    (async () => {
      await d.db.prepare(`DELETE FROM discord_seen WHERE at < ?`).bind(d.now() - SEEN_MS).run().catch(() => {});
      await d.db.prepare(`DELETE FROM discord_rate WHERE at < ?`).bind(d.now() - 2 * 3_600_000).run().catch(() => {});
      let content: string;
      try {
        content = await runCommand(d, p);
      } catch (e) {
        console.error("discord command failed", e);
        content = "Something went wrong on Atteo's side. Try again in a moment.";
      }
      await finish(d, token, content).catch((e) => console.error("discord reply failed", e));
    })(),
  );
  // Posts and asks show in the channel (the post itself is never echoed back); link and unlink only to whoever ran them.
  return json({ type: 5, data: { flags: sub === "post" || sub === "ask" ? 0 : EPHEMERAL } });
}

export const RATE = { userPerMin: 5, userPerHour: 40, channelPerMin: 20, channelPerHour: 200 };

/** One more /atteo post or ask from this person in this channel; why not, when over a limit. Counted in D1 (fixed windows). */
async function overLimit(d: Discord, channel: string, user: string): Promise<string | null> {
  const now = d.now();
  const m = Math.floor(now / 60_000);
  const h = Math.floor(now / 3_600_000);
  const checks: [string, number, string][] = [
    [`u:${user}:m:${m}`, RATE.userPerMin, "You're sending too fast: wait a minute."],
    [`u:${user}:h:${h}`, RATE.userPerHour, "You've reached this hour's limit for /atteo here."],
    [`c:${channel}:m:${m}`, RATE.channelPerMin, "This channel is sending too fast: wait a minute."],
    [`c:${channel}:h:${h}`, RATE.channelPerHour, "This channel has reached this hour's limit for /atteo."],
  ];
  for (const [key, max, why] of checks) {
    const r = await d.db.prepare(`INSERT INTO discord_rate (key, n, at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n`).bind(key, now).first<{ n: number }>();
    if ((r?.n ?? 0) > max) return why;
  }
  return null;
}

/** What one /atteo command does; its reply's text. Exported for tests. */
export async function runCommand(d: Discord, p: Interaction): Promise<string> {
  const { sub, o } = optionsOf(p);
  const channel = channelOf(p);
  const who = whoOf(p);
  if (sub === "link") return linkCommand(d, p, o.code ?? "");
  const link = await linkOfChannel(d, channel);
  if (!link || link.guild_id !== p.guild_id) return "This channel doesn't follow an Atteo board. A board owner gets a code on Atteo, then runs /atteo link <code> here.";
  if (sub === "unlink") {
    if (!canManage(p)) return "Only someone who can manage this channel can unlink it.";
    await dropLinks(d, { board: link.board_id });
    return "This channel no longer follows its Atteo board.";
  }
  if (!(await linkerOk(d, link.board_id, link.created_by))) return "This channel's link to Atteo isn't active (whoever linked it no longer owns the board, or the board is archived).";
  const title = (await d.db.prepare(`SELECT title FROM boards WHERE id = ?`).bind(link.board_id).first<{ title: string }>())?.title ?? "the board";
  // A busy server can't spend the linker's budget: per Discord user and per channel, per minute and per hour.
  const limited = await overLimit(d, channel, who.id ?? "?");
  if (limited) return limited;
  const members = await d.board.members(link.board_id);
  const data = { discord: { author: who.name } }; // the Discord user id stays server-side (discord_links.linked_by only)
  if (sub === "post") {
    const words = (o.text ?? "").trim();
    if (!words) return "Post what? /atteo post <text>";
    const text = postNote(who.name, words);
    const mentions = mayMention(text) ? parseMentions(text, members).mentions : [];
    const seq = await d.board.post(link.board_id, link.created_by, { type: "note", text, mentions, data });
    return `${who.name} posted on ${neutral(title)} (#${seq}): ${neutral(clip(words, 1500))}\n<${entryUrl(d, link.board_id, seq)}>`;
  }
  // ask
  const q = (o.question ?? "").trim();
  const t = askTarget(o.agent ?? "");
  if (!t) return "Whose agent? /atteo ask jxn <question>, or jxn/muse for one of their sessions.";
  if (!q) return "Ask what? /atteo ask <agent> <question>";
  if (!members.some((m) => m.user === t.user)) return `${t.user} isn't on ${neutral(title)}.`;
  const at = t.session ? `@${t.user}/${t.session}` : `@${t.user}'s agent`;
  const head = `${who.name} on Discord asks ${at}:`;
  const text = `${head}\n\n${clip(q, 2900 - head.length)}`;
  const mentions = parseMentions(text, members).mentions;
  if (!mentions.some((m) => m.user === t.user && m.agent)) return `Couldn't reach ${t.user}'s agent on ${neutral(title)}.`;
  const seq = await d.board.post(link.board_id, link.created_by, { type: "question", text, mentions, data });
  const key = askKey(link.board_id, seq, t.user);
  await firstSeen(d, key);
  const label = t.session ? `${t.user}/${t.session}` : `${t.user}'s agent`;
  let a = await d.board.answer(link.board_id, link.created_by, t.user, seq, ASK_WAIT_MS);
  if (!a) {
    // No answer in time: later answers go to the channel as ordinary posts. One last look, in case it just came.
    await d.db.prepare(`DELETE FROM discord_seen WHERE key = ?`).bind(key).run();
    a = await d.board.answer(link.board_id, link.created_by, t.user, seq, 0);
  }
  const asked = `${who.name} asked ${label} on ${neutral(title)} (#${seq}): ${neutral(clip(q, 300))}`;
  if (!a) return `${asked}\nNo answer yet; it will show in this channel when it comes.\n<${entryUrl(d, link.board_id, seq)}>`;
  const tail = `\n<${entryUrl(d, link.board_id, a.seq)}>`;
  return clip(`${asked}\n\n**${label}:** ${neutral(a.text)}`, 2000 - tail.length) + tail;
}

/** The server's name for the board's notice (the interaction doesn't carry it); its id when Discord won't say. */
async function guildName(d: Discord, guild: string): Promise<string> {
  const res = await api(d, "GET", `/guilds/${encodeURIComponent(guild)}`).catch(() => null);
  const j = res?.ok ? ((await res.json().catch(() => null)) as { name?: unknown } | null) : null;
  return typeof j?.name === "string" && j.name.trim() ? nameLabel(j.name) : `server ${guild}`;
}

async function linkCommand(d: Discord, p: Interaction, code: string): Promise<string> {
  if (!canManage(p)) return "Only someone who can manage this channel can link it to Atteo.";
  if (p.channel?.type !== undefined && p.channel.type !== 0 && p.channel.type !== 5) return "Link a text channel.";
  const c = code.trim().toUpperCase();
  if (!/^[A-Z0-9-]{6,40}$/.test(c)) return "That isn't a link code. Get one on Atteo: the board's owner opens Connect Discord.";
  const row = await d.db.prepare(`DELETE FROM discord_codes WHERE code_hash = ? RETURNING board_id, user, expires_at`).bind(await codeHash(d, c)).first<{ board_id: string; user: string; expires_at: number }>();
  if (!row || row.expires_at < d.now()) return "That code is wrong, used or expired. Get a new one on Atteo.";
  // Checked again now: they may have stopped owning the board, or it was encrypted or archived, since the code was made.
  const b = await linkable(d, row.board_id, row.user);
  if (!("id" in b)) return b.error;
  const channel = channelOf(p);
  const taken = await linkOfChannel(d, channel);
  if (taken && taken.board_id !== b.id) return "This channel already follows another Atteo board. /atteo unlink first.";
  const old = await linkOf(d, b.id);
  const who = whoOf(p);
  const now = d.now();
  try {
    // Only this board's row is replaced: a channel another board took meanwhile fails the unique index instead.
    await d.db
      .prepare(
        `INSERT INTO discord_links (board_id, created_by, guild_id, channel_id, linked_by, linked_by_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(board_id) DO UPDATE SET created_by = excluded.created_by, guild_id = excluded.guild_id, channel_id = excluded.channel_id, linked_by = excluded.linked_by, linked_by_name = excluded.linked_by_name, updated_at = excluded.updated_at`,
      )
      .bind(b.id, row.user, p.guild_id!, channel, who.id, who.name, now, now)
      .run();
  } catch {
    return "This channel already follows another Atteo board. /atteo unlink first.";
  }
  await d.board.setDiscord(b.id, true);
  if (old && old.guild_id !== p.guild_id) await leaveIfUnused(d, old.guild_id);
  const server = await guildName(d, p.guild_id!);
  const chan = p.channel?.name ? nameLabel(p.channel.name) : channel;
  await d.board.notice(b.id, row.user, `Discord: now followed by #${chan} in ${server}, linked by ${who.name}.`).catch((e) => console.error("discord notice failed", e));
  return `This channel now follows ${neutral(b.title)} on Atteo (linked for ${row.user}). Board posts show here; /atteo post and /atteo ask reach the board, labelled as from Discord.`;
}

// ---- the people's routes ----

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });

function msgPage(viewer: Viewer | null, title: string, text: string, status = 200, extra = ""): Response {
  return page(`${title} · Atteo`, `<div class="card pad" style="max-width:520px;margin:24px auto 0"><h1 style="font-size:20px">${html(title)}</h1><p class="muted" style="margin-top:8px">${html(text)}</p>${extra}</div>`, { viewer, narrow: true, status });
}

interface BoardLite {
  id: string;
  title: string;
  encrypted: number;
  kind: string | null;
  archived_at: number | null;
  deleted_at: number | null;
}

async function roleOf(d: Discord, board: string, user: string): Promise<string | null> {
  const r = await d.db.prepare(`SELECT role, expires_at FROM members WHERE board_id = ? AND user = ?`).bind(board, user).first<{ role: string; expires_at: number | null }>();
  return r && (r.expires_at == null || r.expires_at > d.now()) ? r.role : null;
}

/** Can this person link this board to Discord? The board row, or why not. */
export async function linkable(d: Discord, board: string, user: string): Promise<BoardLite | { status: number; error: string }> {
  const row = /^b_[a-z0-9]{8,32}$/.test(board) ? await d.db.prepare(`SELECT id, title, encrypted, kind, archived_at, deleted_at FROM boards WHERE id = ?`).bind(board).first<BoardLite>() : null;
  const role = row && !row.deleted_at ? await roleOf(d, board, user) : null;
  if (!row || row.deleted_at || !role) return { status: 404, error: "No such board." };
  if (role !== "owner") return { status: 403, error: "Only the board's owner can connect it to Discord." };
  if (row.encrypted) return { status: 409, error: "This board is end-to-end encrypted: the server can't read its posts, so they can't go to Discord." };
  if (row.kind === "agent") return { status: 409, error: "\"Your agent\" stays between you and your agents: it can't be connected to Discord." };
  if (row.kind === "direct") return { status: 409, error: "A conversation between two people can't be connected to Discord." };
  if (row.archived_at) return { status: 409, error: "This board is archived." };
  return row;
}

type Who = { ok: true; viewer: Viewer } | { ok: false; res: Response };

function person(d: Discord, viewer: Viewer | null, url: URL, asPage: boolean): Who {
  if (!discordOn(d.env)) return { ok: false, res: asPage ? msgPage(viewer, NOT_SET_UP, "Discord isn't set up on this server yet.", 503) : json({ error: NOT_SET_UP }, 503) };
  if (!viewer) return { ok: false, res: asPage ? redirect(`/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`) : json({ error: "sign in required" }, 401) };
  if (viewer.via === "agent") return { ok: false, res: json({ error: "Connecting Discord is for people, signed in on Atteo. An agent's token can't." }, 403) };
  return { ok: true, viewer };
}

const sameSite = (request: Request) => {
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
};

/** Codes are kept hashed, keyed with a secret (the bot token) so a leaked table can't be checked against guesses. */
const codeHash = (d: Discord, code: string) => hmacHex(`discord-code:${d.env.DISCORD_BOT_TOKEN ?? ""}`, code);

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

export const installUrl = (d: Discord) => `${DISCORD_AUTHORIZE}?${new URLSearchParams({ client_id: d.env.DISCORD_APPLICATION_ID ?? "", scope: "bot applications.commands", permissions: BOT_PERMISSIONS })}`;

/** A fresh code for this owner and board (their earlier codes for it stop working). */
async function mint(d: Discord, board: string, user: string): Promise<{ code: string; expires_at: number }> {
  const code = newCode();
  const now = d.now();
  await d.db.batch([
    d.db.prepare(`DELETE FROM discord_codes WHERE (board_id = ? AND user = ?) OR expires_at < ?`).bind(board, user, now),
    d.db.prepare(`INSERT INTO discord_codes (code_hash, board_id, user, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`).bind(await codeHash(d, code), board, user, now + CODE_MS, now),
  ]);
  return { code, expires_at: now + CODE_MS };
}

/** The code, and what to do with it. */
function codePage(d: Discord, viewer: Viewer, row: BoardLite, code: string): Response {
  const steps = `<ol style="margin:14px 0 0 18px;line-height:1.7">
<li><a href="${html(installUrl(d))}" target="_blank" rel="noopener">Add Atteo's bot to your Discord server</a> (skip if it's there already).</li>
<li>In the channel that should follow ${html(row.title)}, run <code>/atteo link ${html(code)}</code></li></ol>
<p class="small muted" style="margin-top:12px">The code works once, for 10 minutes. Board posts then show in that channel; anyone there can use /atteo post and /atteo ask, which reach the board under your link, labelled as from Discord.</p>`;
  return msgPage(viewer, `Connect ${row.title} to Discord`, "Two steps:", 200, steps);
}

/** GET /api/integrations/discord/start?board=: what connecting does, and a button that makes the code (a same-site POST). */
export async function start(d: Discord, viewer: Viewer | null, url: URL): Promise<Response> {
  const who = person(d, viewer, url, true);
  if (!who.ok) return who.res;
  const row = await linkable(d, url.searchParams.get("board") ?? "", who.viewer.name);
  if (!("id" in row)) return msgPage(who.viewer, "Can't connect Discord", row.error, row.status);
  const form = `<form method="post" action="/api/integrations/discord/code" style="margin-top:14px"><input type="hidden" name="board" value="${html(row.id)}">
<p class="small muted">You'll get a one-time code to run as /atteo link in the Discord channel. Board posts then show there, and anyone in it can post to the board under your link with /atteo post and /atteo ask.</p>
<div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn primary">Get a link code</button></div></form>`;
  return msgPage(who.viewer, `Connect ${row.title} to Discord`, "A Discord channel can follow this board.", 200, form);
}

/** POST /api/integrations/discord/code {board}: a fresh code; JSON, or the start page's form (then the code page). */
export async function code(d: Discord, viewer: Viewer | null, request: Request, url: URL): Promise<Response> {
  const who = person(d, viewer, url, false);
  if (!who.ok) return who.res;
  if (!sameSite(request)) return json({ error: "Use Atteo's own pages." }, 403);
  if (Number(request.headers.get("content-length") ?? 0) > 4096) return json({ error: "Payload too large" }, 413);
  const isForm = (request.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
  const raw = await request.text();
  if (raw.length > 4096) return json({ error: "Payload too large" }, 413);
  let body: { board?: unknown } = {};
  try {
    body = isForm ? Object.fromEntries(new URLSearchParams(raw)) : (JSON.parse(raw || "{}") as { board?: unknown });
  } catch {
    return json({ error: "Send JSON: {board}" }, 400);
  }
  const row = await linkable(d, typeof body.board === "string" ? body.board : "", who.viewer.name);
  if (!("id" in row)) return isForm ? msgPage(who.viewer, "Can't connect Discord", row.error, row.status) : json({ error: row.error }, row.status);
  const m = await mint(d, row.id, who.viewer.name);
  if (isForm) return codePage(d, who.viewer, row, m.code);
  return json({ ok: true, code: m.code, expires_at: m.expires_at, command: `/atteo link ${m.code}`, install_url: installUrl(d) });
}

/** GET /api/integrations/discord?board=: whether and where the board is linked (any member; agents too, read only). */
export async function status(d: Discord, viewer: Viewer | null, url: URL): Promise<Response> {
  if (!discordOn(d.env)) return json({ error: NOT_SET_UP }, 503);
  if (!viewer) return json({ error: "sign in required" }, 401);
  const board = url.searchParams.get("board") ?? "";
  if (!/^b_[a-z0-9]{8,32}$/.test(board) || !(await roleOf(d, board, viewer.name))) return json({ error: "No such board." }, 404);
  const link = await linkOf(d, board);
  if (!link) return json({ linked: false });
  return json({ linked: true, active: await linkerOk(d, board, link.created_by), guild_id: link.guild_id, channel_id: link.channel_id, created_by: link.created_by, linked_by_name: link.linked_by_name, created_at: link.created_at });
}

/** DELETE /api/integrations/discord?board=: unlink (who linked it, or a board owner). */
export async function unlink(d: Discord, viewer: Viewer | null, request: Request, url: URL): Promise<Response> {
  const who = person(d, viewer, url, false);
  if (!who.ok) return who.res;
  if (!sameSite(request)) return json({ error: "Use Atteo's own pages." }, 403);
  const board = url.searchParams.get("board") ?? "";
  const role = /^b_[a-z0-9]{8,32}$/.test(board) ? await roleOf(d, board, who.viewer.name) : null;
  if (!role) return json({ error: "No such board." }, 404);
  const link = await linkOf(d, board);
  if (!link) return json({ ok: true, linked: false });
  if (link.created_by !== who.viewer.name && role !== "owner") return json({ error: `Only ${link.created_by} (who connected it) or a board owner can disconnect Discord.` }, 403);
  await dropLinks(d, { board });
  return json({ ok: true, linked: false });
}
