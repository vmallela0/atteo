// The Microsoft Teams integration (vedu #6508, plan item 4). One Teams channel follows one Atteo board, like Discord
// (src/discord.ts): the board's posts show in the channel, and "@Atteo post" and "@Atteo ask" in the channel reach the
// board. docs/TEAMS.md has the Azure setup and docs/teams-manifest.json the app manifest.
//
// - Link: a board owner, signed in on Atteo (never an agent token), opens GET /api/integrations/teams/start?board=<id>
//   and presses Get a link code, a same-site POST /api/integrations/teams/code {board} (JSON works too). That mints a
//   one-time code (10 minutes, single use, only its hash kept, keyed with the bot's client secret, bound to them and the
//   board). In the channel, a team owner (checked with the Bot Framework members API: userRole "owner"; fail closed)
//   posts "@Atteo link <code>": the channel is where it ran, so there's no picker, and no token is stored (the bot's
//   credentials are the TEAMS_APP_ID / TEAMS_APP_PASSWORD secrets). Never an encrypted board, a DM or "Your agent". One
//   channel per board and one board per channel. The board gets a notice naming the channel, team and who linked it.
// - The link lasts while its maker owns the board: removing or demoting them, deleting the board or their account drops
//   it (dropLinks). Teams has no API for a bot to leave a team, so the rows just go. "@Atteo unlink" (team owners),
//   DELETE /api/integrations/teams (the linker or a board owner), and the bot being removed from the team or the channel
//   being deleted drop it too.
// - Teams → board: POST /api/integrations/teams/messages, the bot's messaging endpoint. Every request is checked: at most
//   128 KB (refused before reading), a Bot Framework JWT (RS256 against the OpenID metadata's keys, cached; issuer
//   https://api.botframework.com, audience TEAMS_APP_ID, exp/nbf with 5 minutes' skew, a key endorsed for "msteams"
//   when it lists endorsements), its serviceurl claim equal to the activity's serviceUrl, that serviceUrl on the
//   allowlist (serviceUrlOk), the tenant when TEAMS_TENANT_ID is set, and each activity once. Answered 200 at once; the
//   work runs in waitUntil and replies in the message's thread. "post <text>" is a note on the board; "ask <agent>
//   <question>" a question to that member's agent, whose public answer (if it comes within ~20s) is the reply. Both are
//   the linker's agent's post, client "Microsoft Teams", origin "teams" (server-set), with the Teams name as a label in
//   the text: agents read it as "Teams message by <name> (via <linker>'s Teams link)". Only the Teams display name goes
//   on the board, never a Teams user, tenant or AAD id. Rate limited per Teams user and per channel (RATE). An ask's
//   answer must be public on the board (Discord's answerFor: no Just mine or people-only reply, nothing flagged).
// - Board → Teams: every public post on a linked board (Discord's skip rules: not people-only or just-mine, not a
//   notice, an approval, a flagged post, an unsend, or a post from Teams) is a bot message in the channel, plain text
//   (textFormat "plain": no markdown, HTML or <at> mentions; @team/@channel/@everyone/@here defused), author shown,
//   length-capped. Sent in the board object's waitUntil, in order per board, to the stored serviceUrl only if it's
//   still on the allowlist. Only while the linker still owns the board and it isn't deleted, archived or encrypted.
//
// Off until TEAMS_APP_ID and TEAMS_APP_PASSWORD are set: the routes answer 503 "Microsoft Teams isn't set up yet".
// TEAMS_TENANT_ID is optional: set, the bot is single-tenant (tokens from that tenant, activities only from it).
// Never log a token: errors log a status only.

import type { Board } from "./board";
import { answerFor, askTarget, clip, nameLabel, publicAnswer } from "./discord";
import { hmacHex, sha256 } from "./linear";
import { mayMention, parseMentions, type Mention, type MemberRef } from "./mentions";
import * as registry from "./registry";
import { flagOf } from "./slackCore";
import { authorLabel } from "./state";
import type { Entry, Env } from "./types";
import { page, type Viewer } from "./ui";
import { esc as html } from "./util";

export { answerFor };

export const OPENID_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
export const BF_ISSUER = "https://api.botframework.com";
export const BF_SCOPE = "https://api.botframework.com/.default";
export const tokenUrl = (tenant?: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenant?.trim() || "botframework.com")}/oauth2/v2.0/token`;
export const CODE_MS = 10 * 60_000;
export const SKEW_MS = 5 * 60_000;
export const SEEN_MS = 24 * 3600_000;
export const ASK_WAIT_MS = 20_000;
export const MAX_ACTIVITY_BYTES = 128_000;
export const MAX_TEXT = 3500; // Teams takes ~28 KB; a chat line should be short
export const KEYS_TTL_MS = 24 * 3600_000;
export const KEYS_REFETCH_MS = 5 * 60_000; // an unknown key id refetches at most this often
export const NOT_SET_UP = "Microsoft Teams isn't set up yet";
const CHANNEL_ID = "msteams";

export type TeamsEnv = {
  TEAMS_APP_ID?: string;
  TEAMS_APP_PASSWORD?: string;
  TEAMS_TENANT_ID?: string;
  PUBLIC_URL?: string;
};

/** Whether the integration exists here at all. */
export const teamsOn = (env: TeamsEnv): boolean => !!(env.TEAMS_APP_ID && env.TEAMS_APP_PASSWORD);

// ---- pure parts ----

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function jsonPart(s: string): Record<string, unknown> | null {
  const b = b64url(s);
  if (!b) return null;
  try {
    const v = JSON.parse(dec.decode(b)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Where Atteo may send the bot's token: https on smba.trafficmanager.net (its regions are paths: /amer/, /emea/, …) or a
 * *.botframework.com host, no port or credentials. Returns the base URL ending in "/", or null. Never any other host,
 * whatever an activity says: a wildcard *.trafficmanager.net would let any Azure customer's profile receive the token.
 */
export function serviceUrlOk(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 300) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash) return null;
  const h = u.hostname.toLowerCase();
  if (h !== "smba.trafficmanager.net" && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.botframework\.com$/.test(h)) return null;
  return `https://${h}${u.pathname.replace(/\/*$/, "/")}`;
}

const sameServiceUrl = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.trim().replace(/\/+$/, "").toLowerCase() === b.trim().replace(/\/+$/, "").toLowerCase();

/** Board text going to Teams, sent as plain text: no <at> mention tags, and @team/@channel/@everyone/@here defused. */
export function neutral(s: string): string {
  return s.replace(/<\/?at\b[^>]*>/gi, "").replace(/@(team|channel|everyone|here)\b/gi, "@​$1");
}

const KIND: Record<string, string> = { question: "❓ Question", decision: "✅ Decision", task: "📋 Task", change: "🔀 Change", handoff: "🚦 Ready to land", artifact: "📎 File", claim: "🙋 On it" };

/** A board entry as a Teams message's text: who, what kind, the words (capped), and the way back to the board. */
export function entryText(e: Entry, url: string): string {
  const head = [neutral(authorLabel(e)), KIND[e.type], e.title ? neutral(e.title) : null].filter(Boolean).join(" · ");
  const files = e.type === "artifact" || e.attachments?.length || e.media;
  const body = files ? `${e.artifact_name ?? e.attachments?.map((a) => a.name).join(", ") ?? "A file"} (open it in Atteo)${e.text ? `\n${e.text}` : ""}` : e.text;
  const tail = `\n\n${url}`;
  return clip(`${head}\n${neutral(body ?? "")}`.trim(), MAX_TEXT - tail.length) + tail;
}

/** The board note for "post": its Teams author as a label, then the words. */
export function postNote(author: string, text: string): string {
  const head = `${nameLabel(author)} on Teams:`;
  return `${head}\n\n${clip(text.trim(), 2900 - head.length)}`;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,6});/g, (_, n) => String.fromCodePoint(Math.min(0x10ffff, Number(n))))
    .replace(/&amp;/gi, "&");
}

/** The words after the bot's @mention, as plain text: its <at>…</at> tag removed, other markup stripped, entities decoded. */
export function commandText(a: Activity): string {
  let s = String(a.text ?? "");
  for (const m of a.entities ?? []) if (m?.type === "mention" && m.mentioned?.id && m.mentioned.id === a.recipient?.id && typeof m.text === "string" && m.text) s = s.split(m.text).join(" ");
  s = s.replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, " "); // any other mention left
  s = s.replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n").replace(/<[^>]*>/g, "");
  return decodeEntities(s).replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Whether the message @mentions this bot (in a channel, Teams sends the bot only messages that do). */
export const mentionsBot = (a: Activity): boolean => !!a.recipient?.id && (a.entities ?? []).some((m) => m?.type === "mention" && m.mentioned?.id === a.recipient!.id);

/** "ask jxn why…", "ask jxn's agent why…", "ask jxn/muse why…" → the target's words and the question. */
export function splitAsk(rest: string): { agent: string; question: string } | null {
  const m = rest.trim().match(/^(\S+?(?:['’]s)?\s+agents?\b|\S+)\s+([\s\S]+)$/i);
  return m ? { agent: m[1], question: m[2].trim() } : null;
}

// ---- Bot Framework auth: inbound JWTs, outbound tokens ----

type Key = { key: CryptoKey; endorsements: string[] | null };
const caches: { keys: Map<string, Key> | null; keysAt: number; fetchedAt: number; token: { value: string; exp: number; for: string } | null } = { keys: null, keysAt: 0, fetchedAt: 0, token: null };

/** For tests: forget the cached keys and token. */
export function resetCaches(): void {
  caches.keys = null;
  caches.keysAt = 0;
  caches.fetchedAt = 0;
  caches.token = null;
}

async function fetchKeys(t: Teams): Promise<void> {
  caches.fetchedAt = t.now();
  const meta = await t.http(OPENID_URL, { signal: AbortSignal.timeout(10_000) });
  if (!meta.ok) throw new Error(`openid metadata: HTTP ${meta.status}`);
  const m = (await meta.json()) as { jwks_uri?: unknown };
  const jwks = typeof m.jwks_uri === "string" ? new URL(m.jwks_uri) : null;
  // The keys come from Microsoft's login host only, whatever the document says.
  if (!jwks || jwks.protocol !== "https:" || jwks.hostname !== "login.botframework.com") throw new Error("openid metadata: unexpected jwks_uri");
  const res = await t.http(jwks.href, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`jwks: HTTP ${res.status}`);
  const j = (await res.json()) as { keys?: { kty?: string; kid?: string; n?: string; e?: string; endorsements?: unknown }[] };
  const keys = new Map<string, Key>();
  for (const k of j.keys ?? []) {
    if (k?.kty !== "RSA" || typeof k.kid !== "string" || typeof k.n !== "string" || typeof k.e !== "string") continue;
    try {
      const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: k.n, e: k.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      keys.set(k.kid, { key, endorsements: Array.isArray(k.endorsements) ? k.endorsements.filter((x): x is string => typeof x === "string") : null });
    } catch {
      // a key we can't use is skipped
    }
  }
  if (!keys.size) throw new Error("jwks: no usable keys");
  caches.keys = keys;
  caches.keysAt = t.now();
}

/** The signing key for `kid`: cached for a day; an unknown id refetches (key rotation), at most every 5 minutes. */
async function keyFor(t: Teams, kid: string): Promise<Key | null> {
  const fresh = caches.keys && t.now() - caches.keysAt < KEYS_TTL_MS;
  if (!fresh || (!caches.keys!.has(kid) && t.now() - caches.fetchedAt >= KEYS_REFETCH_MS)) {
    await fetchKeys(t).catch((e) => console.error("teams keys fetch failed", String((e as Error)?.message ?? e).slice(0, 120)));
  }
  return caches.keys?.get(kid) ?? null;
}

export type Claims = { iss: string; aud: unknown; exp: number; nbf?: number; serviceurl?: string; serviceUrl?: string };
export type Verified = { ok: true; claims: Claims } | { ok: false; status: number; why: string };

/** Whether an Authorization header carries a Bot Framework token for this bot, sent for Teams. */
export async function verifyToken(t: Teams, header: string | null): Promise<Verified> {
  const no = (why: string): Verified => ({ ok: false, status: 401, why });
  const m = header?.match(/^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!m || header!.length > 8192) return no("unsigned");
  const head = jsonPart(m[1]);
  const body = jsonPart(m[2]);
  const sig = b64url(m[3]);
  if (!head || !body || !sig) return no("bad token");
  if (head.alg !== "RS256" || typeof head.kid !== "string" || !head.kid) return no("bad token");
  const key = await keyFor(t, head.kid);
  if (!key) return no("unknown key");
  // A key that lists endorsements must be endorsed for Teams.
  if (key.endorsements && !key.endorsements.includes(CHANNEL_ID)) return no("key not endorsed for Teams");
  let good = false;
  try {
    good = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key.key, sig, enc.encode(`${m[1]}.${m[2]}`));
  } catch {
    good = false;
  }
  if (!good) return no("bad signature");
  const c = body as unknown as Claims;
  if (c.iss !== BF_ISSUER) return no("wrong issuer");
  const app = t.env.TEAMS_APP_ID ?? "";
  if (!(c.aud === app || (Array.isArray(c.aud) && c.aud.length === 1 && c.aud[0] === app))) return no("wrong audience");
  const now = t.now();
  if (typeof c.exp !== "number" || now > c.exp * 1000 + SKEW_MS) return no("expired");
  if (c.nbf !== undefined && (typeof c.nbf !== "number" || now < c.nbf * 1000 - SKEW_MS)) return no("not yet valid");
  if (typeof (c.serviceurl ?? c.serviceUrl) !== "string") return no("no serviceurl claim");
  return { ok: true, claims: c };
}

/** The bot's own token for the Bot Connector (client credentials), cached until a few minutes before it expires. */
async function botToken(t: Teams, fresh = false): Promise<string | null> {
  const who = `${t.env.TEAMS_APP_ID}|${t.env.TEAMS_TENANT_ID ?? ""}`;
  if (!fresh && caches.token && caches.token.for === who && caches.token.exp > t.now()) return caches.token.value;
  const res = await t.http(tokenUrl(t.env.TEAMS_TENANT_ID), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: t.env.TEAMS_APP_ID ?? "", client_secret: t.env.TEAMS_APP_PASSWORD ?? "", scope: BF_SCOPE }).toString(),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) {
    console.error("teams token failed", res?.status ?? "network"); // never the body: it may echo the request
    return null;
  }
  const j = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (typeof j?.access_token !== "string" || !j.access_token) return null;
  const life = Math.max(60, (Number(j.expires_in) || 3600) - 300);
  caches.token = { value: j.access_token, exp: t.now() + life * 1000, for: who };
  return j.access_token;
}

/** One Bot Connector call to an allowlisted serviceUrl; a 401 gets a fresh token once, a 429 one retry (≤5s). */
async function connector(t: Teams, serviceUrl: string, method: string, path: string, body?: unknown): Promise<Response | null> {
  const base = serviceUrlOk(serviceUrl);
  if (!base) return null;
  let token = await botToken(t);
  if (!token) return null;
  const go = (tok: string) => t.http(base + path, { method, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
  let res = await go(token);
  if (res.status === 401) {
    token = await botToken(t, true);
    if (!token) return res;
    res = await go(token);
  }
  if (res.status === 429) {
    const wait = Math.min(5, Math.max(0, Number(res.headers.get("retry-after")) || 1));
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await go(token);
  }
  return res;
}

const seg = encodeURIComponent;

/** Whether this Teams user owns the team (Bot Framework members API: userRole "owner"). Anything else, or an error, is no. */
export async function isTeamOwner(t: Teams, serviceUrl: string, teamId: string, userId: string): Promise<boolean> {
  if (!teamId || !userId) return false;
  const res = await connector(t, serviceUrl, "GET", `v3/conversations/${seg(teamId)}/members/${seg(userId)}`).catch(() => null);
  if (!res?.ok) return false;
  const j = (await res.json().catch(() => null)) as { userRole?: unknown } | null;
  return j?.userRole === "owner";
}

// ---- what the integration needs (tests pass stand-ins) ----

export interface TeamsBoardOps {
  /** As the linker's agent (client "Microsoft Teams", origin "teams"). Returns the new entry's seq. */
  post(board: string, user: string, input: { type: "note" | "question"; text: string; mentions: Mention[]; data: { teams: { author: string } } }): Promise<number>;
  setTeams(board: string, on: boolean): Promise<void>;
  /** A board notice (client "Microsoft Teams", no origin): the board hears that a channel now follows it. */
  notice(board: string, user: string, text: string): Promise<void>;
  members(board: string): Promise<(MemberRef & object)[]>;
  /** The reply by `user`'s agent to question `seq` that may leave the board (answerFor), waiting up to waitMs; or null. */
  answer(board: string, me: string, user: string, seq: number, waitMs: number): Promise<{ seq: number; text: string } | null>;
}

export interface Teams {
  db: D1Database;
  env: TeamsEnv;
  origin: string;
  now(): number;
  http: typeof fetch;
  board: TeamsBoardOps;
}

const stubOf = (env: Env, id: string) => env.BOARD.get(env.BOARD.idFromName(id)) as DurableObjectStub<Board>;

export function teamsFor(env: Env, origin?: string): Teams {
  return {
    db: env.DB,
    env,
    origin: (origin ?? env.PUBLIC_URL ?? "https://atteo.dev").replace(/\/$/, ""),
    now: () => Date.now(),
    http: (input, init) => fetch(input, init),
    board: {
      async post(board, user, input) {
        const e = await stubOf(env, board).post(user, { type: input.type, text: input.text, via: "agent", client: "Microsoft Teams", mentions: input.mentions, data: input.data }, { origin: "teams" });
        await registry.bumpBoard(env, board, e.seq).catch(() => {});
        return e.seq;
      },
      setTeams: (board, on) => stubOf(env, board).setTeams(on),
      notice: async (board, user, text) => void (await stubOf(env, board).notice(user, "Microsoft Teams", text, { via: "agent", client: "Microsoft Teams", session: null })),
      members: async (board) => (await registry.boardMembers(env, board)).map((m) => ({ user: m.user, agent_name: m.agent_name })),
      // Discord's: only an answer that may leave the board (answerFor: public, not flagged, not unsent).
      answer: (board, me, user, seq, waitMs) => publicAnswer(env, board, me, user, seq, waitMs),
    },
  };
}

// ---- D1 rows ----

export interface LinkRow {
  board_id: string;
  created_by: string;
  tenant_id: string;
  team_id: string;
  channel_id: string;
  service_url: string;
  team_name: string | null;
  channel_name: string | null;
  linked_by: string | null;
  linked_by_name: string | null;
  created_at: number;
  updated_at: number;
}

const linkOf = (t: Teams, board: string) => t.db.prepare(`SELECT * FROM teams_links WHERE board_id = ?`).bind(board).first<LinkRow>();
const linkOfChannel = (t: Teams, channel: string) => t.db.prepare(`SELECT * FROM teams_links WHERE channel_id = ?`).bind(channel).first<LinkRow>();

async function firstSeen(t: Teams, key: string): Promise<boolean> {
  const r = await t.db.prepare(`INSERT OR IGNORE INTO teams_seen (key, at) VALUES (?, ?)`).bind(key.slice(0, 200), t.now()).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** The link's maker still stands behind it: an owner of the board, which isn't deleted, archived or encrypted. */
async function linkerOk(t: Teams, board: string, user: string): Promise<boolean> {
  const r = await t.db
    .prepare(`SELECT m.role, m.expires_at, b.deleted_at, b.archived_at, b.encrypted FROM members m JOIN boards b ON b.id = m.board_id WHERE m.board_id = ? AND m.user = ?`)
    .bind(board, user)
    .first<{ role: string; expires_at: number | null; deleted_at: number | null; archived_at: number | null; encrypted: number | null }>();
  return !!r && r.role === "owner" && (r.expires_at == null || r.expires_at > t.now()) && !r.deleted_at && !r.archived_at && !r.encrypted;
}

/**
 * Drop links (one board's, or every one a person made, or a person's on one board, or a team's or a channel's): the
 * board stops posting to its channel and the codes go. Best effort: never throws into what called it (removing a member,
 * deleting a board or an account).
 */
export async function dropLinks(t: Teams, where: { board?: string; by?: string; team?: string; channel?: string; tenant?: string }): Promise<number> {
  try {
    if (!where.board && !where.by && !where.team && !where.channel) return 0;
    const pairs: [string, string | undefined][] = [["board_id", where.board], ["created_by", where.by], ["team_id", where.team], ["channel_id", where.channel], ["tenant_id", where.tenant]];
    const used = pairs.filter((p): p is [string, string] => !!p[1]);
    const links = (await t.db.prepare(`SELECT * FROM teams_links WHERE ${used.map(([c]) => `${c} = ?`).join(" AND ")}`).bind(...used.map(([, v]) => v)).all<LinkRow>()).results ?? [];
    if (where.board || where.by) {
      const codeConds = [where.board ? "board_id = ?" : null, where.by ? "user = ?" : null].filter(Boolean).join(" AND ");
      await t.db.prepare(`DELETE FROM teams_codes WHERE ${codeConds}`).bind(...[where.board, where.by].filter((x): x is string => !!x)).run();
    }
    for (const link of links) {
      await t.db.prepare(`DELETE FROM teams_links WHERE board_id = ?`).bind(link.board_id).run();
      await t.board.setTeams(link.board_id, false).catch(() => {});
    }
    return links.length;
  } catch (e) {
    console.error("teams unlink failed", e);
    return 0;
  }
}

/** For registry and account deletion: drop the links matching `where` (see dropLinks). */
export const dropLinksFor = (env: Env, where: { board?: string; by?: string }): Promise<number> => dropLinks(teamsFor(env), where);

// ---- board → Teams ----

const entryUrl = (t: Teams, board: string, seq: number) => `${t.origin}/b/${board}#e${seq}`;
const askKey = (board: string, seq: number, user: string) => `ask:${board}:${seq}:${user}`;

/** What a linked board's new post does: one bot message in its channel, or nothing. Returns why, for tests and logs. */
export async function bridgeEntry(t: Teams, info: { id: string; title: string }, e: Entry): Promise<string> {
  if (e.origin === "teams") return "skip: from Teams"; // no echo
  if (e.retracts != null || e.audience || e.type === "approval") return "skip: not for the channel";
  if (flagOf(e)) return "skip: flagged"; // it looks like instructions to agents: not carried out of the board
  const link = await linkOf(t, info.id);
  if (!link) return "skip: not linked";
  if (!(await linkerOk(t, info.id, link.created_by))) return "skip: the link's maker no longer owns the board";
  // The answer to an ask goes back in that command's own reply: not twice.
  if (e.reply_to != null && (await t.db.prepare(`SELECT 1 AS x FROM teams_seen WHERE key = ?`).bind(askKey(info.id, e.reply_to, e.author)).first())) return "skip: answered in the ask's reply";
  if (!serviceUrlOk(link.service_url)) return "skip: serviceUrl not allowed";
  const res = await connector(t, link.service_url, "POST", `v3/conversations/${seg(link.channel_id)}/activities`, { type: "message", text: entryText(e, entryUrl(t, info.id, e.seq)), textFormat: "plain" });
  if (!res) return "failed: no token";
  if (!res.ok) {
    console.error("teams post failed", res.status);
    return `failed: HTTP ${res.status}`;
  }
  return "sent";
}

/** From the board object, for each new post on a board linked to Teams. */
export async function onEntry(env: Env, info: { id: string; title: string }, e: Entry): Promise<void> {
  if (!teamsOn(env)) return;
  await bridgeEntry(teamsFor(env), info, e);
}

// ---- Teams → board ----

export interface Activity {
  type?: string;
  id?: string;
  serviceUrl?: string;
  channelId?: string;
  action?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  conversation?: { id?: string; conversationType?: string; tenantId?: string };
  text?: string;
  entities?: { type?: string; text?: string; mentioned?: { id?: string; name?: string } }[];
  membersRemoved?: { id?: string }[];
  channelData?: { team?: { id?: string; name?: string }; channel?: { id?: string; name?: string }; tenant?: { id?: string }; eventType?: string };
}

type Later = { waitUntil(p: Promise<unknown>): void };

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/** The body, or null once it passes `max` bytes (stops reading there). */
async function readCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) all.set(p, (o += p.byteLength) - p.byteLength);
  return dec.decode(all);
}

const tenantOf = (a: Activity) => a.channelData?.tenant?.id ?? a.conversation?.tenantId ?? "";

/** A reply in the command's own thread (plain text). */
async function reply(t: Teams, base: string, a: Activity, text: string): Promise<void> {
  if (!a.conversation?.id || !a.id) return;
  const res = await connector(t, base, "POST", `v3/conversations/${seg(a.conversation.id)}/activities/${seg(a.id)}`, { type: "message", text: clip(neutral(text), MAX_TEXT), textFormat: "plain", replyToId: a.id });
  if (res && !res.ok) console.error("teams reply failed", res.status);
}

/** POST /api/integrations/teams/messages: checked, deduped, answered at once, done later. */
export async function messages(t: Teams, request: Request, later: Later): Promise<Response> {
  if (!teamsOn(t.env)) return json({ error: NOT_SET_UP }, 503);
  if (Number(request.headers.get("content-length") ?? 0) > MAX_ACTIVITY_BYTES) return json({ error: "Payload too large" }, 413);
  // The token first: nobody unauthenticated gets the body read.
  const v = await verifyToken(t, request.headers.get("authorization"));
  if (!v.ok) return json({ error: v.why }, v.status);
  const raw = await readCapped(request, MAX_ACTIVITY_BYTES);
  if (raw == null) return json({ error: "Payload too large" }, 413);
  let a: Activity;
  try {
    a = JSON.parse(raw) as Activity;
  } catch {
    return json({ error: "not JSON" }, 400);
  }
  if (!a || typeof a !== "object") return json({ error: "not an activity" }, 400);
  // The token was issued for this serviceUrl: an activity can't point the bot (and its token) anywhere else.
  if (!sameServiceUrl(v.claims.serviceurl ?? v.claims.serviceUrl, a.serviceUrl)) return json({ error: "serviceUrl doesn't match the token" }, 401);
  const base = serviceUrlOk(a.serviceUrl);
  if (!base) return json({ error: "serviceUrl not allowed" }, 403);
  if (a.channelId !== CHANNEL_ID) return json({ error: "Teams only" }, 400);
  const tenant = tenantOf(a);
  if (t.env.TEAMS_TENANT_ID && tenant !== t.env.TEAMS_TENANT_ID) return json({ error: "another tenant" }, 403);
  if (typeof a.id !== "string" || !a.id) return new Response(null, { status: 200 });
  if (!(await firstSeen(t, `a:${await sha256(`${a.conversation?.id ?? ""}|${a.id}|${a.type ?? ""}`)}`))) return new Response(null, { status: 200 });
  later.waitUntil(
    (async () => {
      await t.db.prepare(`DELETE FROM teams_seen WHERE at < ?`).bind(t.now() - SEEN_MS).run().catch(() => {});
      await t.db.prepare(`DELETE FROM teams_rate WHERE at < ?`).bind(t.now() - 2 * 3_600_000).run().catch(() => {});
      try {
        if (a.type === "message") await onMessage(t, a, base, tenant);
        else if (a.type === "conversationUpdate" || a.type === "installationUpdate") await onUpdate(t, a, tenant);
      } catch (e) {
        console.error("teams activity failed", e);
        if (a.type === "message" && mentionsBot(a)) await reply(t, base, a, "Something went wrong on Atteo's side. Try again in a moment.").catch(() => {});
      }
    })(),
  );
  return new Response(null, { status: 200 });
}

/** The bot removed from a team, the team or the channel deleted: those links go. */
async function onUpdate(t: Teams, a: Activity, tenant: string): Promise<void> {
  const team = a.channelData?.team?.id;
  if (!team || !tenant) return;
  const ev = a.channelData?.eventType;
  const botGone = (a.membersRemoved ?? []).some((m) => m?.id && m.id === a.recipient?.id);
  if (ev === "teamDeleted" || botGone || (a.type === "installationUpdate" && a.action === "remove")) await dropLinks(t, { team, tenant });
  else if (ev === "channelDeleted" && a.channelData?.channel?.id) await dropLinks(t, { team, channel: a.channelData.channel.id, tenant });
}

const USAGE = "Atteo knows: @Atteo post <text> · @Atteo ask <agent> <question> · @Atteo link <code> · @Atteo unlink";

async function onMessage(t: Teams, a: Activity, base: string, tenant: string): Promise<void> {
  if (a.conversation?.conversationType !== "channel" || !a.channelData?.team?.id || !a.channelData.channel?.id) {
    // A chat with the bot or a group chat: never linked, only pointed to a channel.
    if (a.conversation?.conversationType === "personal" || mentionsBot(a)) await reply(t, base, a, "Atteo works in a team channel: there, @mention Atteo with post, ask, link or unlink.");
    return;
  }
  if (!mentionsBot(a)) return; // only what's said to the bot
  // Teams says the serviceUrl may change: the link keeps the latest verified one (allowlisted).
  await t.db.prepare(`UPDATE teams_links SET service_url = ? WHERE channel_id = ? AND team_id = ? AND tenant_id = ? AND service_url <> ?`).bind(base, a.channelData.channel.id, a.channelData.team.id, tenant, base).run().catch(() => {});
  const words = commandText(a);
  const m = words.match(/^(\S+)\s*([\s\S]*)$/);
  const sub = (m?.[1] ?? "").toLowerCase();
  const rest = m?.[2] ?? "";
  let out: string;
  try {
    out = await runCommand(t, a, base, tenant, sub, rest);
  } catch (e) {
    console.error("teams command failed", e);
    out = "Something went wrong on Atteo's side. Try again in a moment.";
  }
  await reply(t, base, a, out);
}

export const RATE = { userPerMin: 5, userPerHour: 40, channelPerMin: 20, channelPerHour: 200 };

/** One more post or ask from this person in this channel; why not, when over a limit. Counted in D1 (fixed windows). */
async function overLimit(t: Teams, channel: string, user: string): Promise<string | null> {
  const now = t.now();
  const m = Math.floor(now / 60_000);
  const h = Math.floor(now / 3_600_000);
  const checks: [string, number, string][] = [
    [`u:${user}:m:${m}`, RATE.userPerMin, "You're sending too fast: wait a minute."],
    [`u:${user}:h:${h}`, RATE.userPerHour, "You've reached this hour's limit for Atteo here."],
    [`c:${channel}:m:${m}`, RATE.channelPerMin, "This channel is sending too fast: wait a minute."],
    [`c:${channel}:h:${h}`, RATE.channelPerHour, "This channel has reached this hour's limit for Atteo."],
  ];
  for (const [key, max, why] of checks) {
    const r = await t.db.prepare(`INSERT INTO teams_rate (key, n, at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n`).bind(key.slice(0, 200), now).first<{ n: number }>();
    if ((r?.n ?? 0) > max) return why;
  }
  return null;
}

/** What one command does; its reply's text. Exported for tests. */
export async function runCommand(t: Teams, a: Activity, base: string, tenant: string, sub: string, rest: string): Promise<string> {
  if (!["post", "ask", "link", "unlink"].includes(sub)) return USAGE;
  const team = a.channelData?.team?.id ?? "";
  const channel = a.channelData?.channel?.id ?? "";
  const who = { id: a.from?.id ?? "", name: nameLabel(a.from?.name) };
  if (sub === "link") return linkCommand(t, a, base, tenant, rest);
  const link = await linkOfChannel(t, channel);
  if (!link || link.team_id !== team || link.tenant_id !== tenant) return "This channel doesn't follow an Atteo board. A board owner gets a code on Atteo, then a team owner posts @Atteo link <code> here.";
  if (sub === "unlink") {
    if (!(await isTeamOwner(t, base, team, who.id))) return "Only a team owner can unlink this channel.";
    await dropLinks(t, { board: link.board_id });
    return "This channel no longer follows its Atteo board.";
  }
  if (!(await linkerOk(t, link.board_id, link.created_by))) return "This channel's link to Atteo isn't active (whoever linked it no longer owns the board, or the board is archived).";
  const title = (await t.db.prepare(`SELECT title FROM boards WHERE id = ?`).bind(link.board_id).first<{ title: string }>())?.title ?? "the board";
  // A busy team can't spend the linker's budget: per Teams user and per channel, per minute and per hour.
  const limited = await overLimit(t, channel, who.id || "?");
  if (limited) return limited;
  const members = await t.board.members(link.board_id);
  const data = { teams: { author: who.name } }; // no Teams user, tenant or AAD id on the board
  if (sub === "post") {
    const words = rest.trim();
    if (!words) return "Post what? @Atteo post <text>";
    const text = postNote(who.name, words);
    const mentions = mayMention(text) ? parseMentions(text, members).mentions : [];
    const seq = await t.board.post(link.board_id, link.created_by, { type: "note", text, mentions, data });
    return `${who.name} posted on ${title} (#${seq}): ${clip(words, 1500)}\n${entryUrl(t, link.board_id, seq)}`;
  }
  // ask
  const parts = splitAsk(rest);
  if (!parts) return "Ask whom what? @Atteo ask jxn <question>, or jxn/muse for one of their sessions.";
  const tg = askTarget(parts.agent);
  if (!tg) return "Whose agent? @Atteo ask jxn <question>, or jxn/muse for one of their sessions.";
  const q = parts.question;
  if (!members.some((m) => m.user === tg.user)) return `${tg.user} isn't on ${title}.`;
  const at = tg.session ? `@${tg.user}/${tg.session}` : `@${tg.user}'s agent`;
  const head = `${who.name} on Teams asks ${at}:`;
  const text = `${head}\n\n${clip(q, 2900 - head.length)}`;
  const mentions = parseMentions(text, members).mentions;
  if (!mentions.some((m) => m.user === tg.user && m.agent)) return `Couldn't reach ${tg.user}'s agent on ${title}.`;
  const seq = await t.board.post(link.board_id, link.created_by, { type: "question", text, mentions, data });
  const key = askKey(link.board_id, seq, tg.user);
  await firstSeen(t, key);
  const label = tg.session ? `${tg.user}/${tg.session}` : `${tg.user}'s agent`;
  let ans = await t.board.answer(link.board_id, link.created_by, tg.user, seq, ASK_WAIT_MS);
  if (!ans) {
    // No answer in time: later answers go to the channel as ordinary posts. One last look, in case it just came.
    await t.db.prepare(`DELETE FROM teams_seen WHERE key = ?`).bind(key).run();
    ans = await t.board.answer(link.board_id, link.created_by, tg.user, seq, 0);
  }
  const asked = `${who.name} asked ${label} on ${title} (#${seq}): ${clip(q, 300)}`;
  if (!ans) return `${asked}\nNo answer yet; it will show in this channel when it comes.\n${entryUrl(t, link.board_id, seq)}`;
  const tail = `\n${entryUrl(t, link.board_id, ans.seq)}`;
  return clip(`${asked}\n\n${label}: ${ans.text}`, MAX_TEXT - tail.length) + tail;
}

/** The team's and channel's names for the notice (Teams calls the General channel's name null); generic words when unknown. */
async function namesOf(t: Teams, base: string, a: Activity): Promise<{ team: string; channel: string }> {
  const teamId = a.channelData?.team?.id ?? "";
  const channelId = a.channelData?.channel?.id ?? "";
  let team = typeof a.channelData?.team?.name === "string" ? a.channelData.team.name : "";
  let channel = typeof a.channelData?.channel?.name === "string" ? a.channelData.channel.name : "";
  if (!team) {
    const res = await connector(t, base, "GET", `v3/teams/${seg(teamId)}`).catch(() => null);
    const j = res?.ok ? ((await res.json().catch(() => null)) as { name?: unknown } | null) : null;
    if (typeof j?.name === "string") team = j.name;
  }
  if (!channel) {
    if (channelId === teamId) channel = "General";
    else {
      const res = await connector(t, base, "GET", `v3/teams/${seg(teamId)}/conversations`).catch(() => null);
      const j = res?.ok ? ((await res.json().catch(() => null)) as { conversations?: { id?: unknown; name?: unknown }[] } | null) : null;
      const hit = j?.conversations?.find((c) => c?.id === channelId);
      if (hit) channel = typeof hit.name === "string" && hit.name ? hit.name : "General";
    }
  }
  return { team: team.trim() ? nameLabel(team) : "a team", channel: channel.trim() ? nameLabel(channel) : "a channel" };
}

async function linkCommand(t: Teams, a: Activity, base: string, tenant: string, code: string): Promise<string> {
  const team = a.channelData?.team?.id ?? "";
  const channel = a.channelData?.channel?.id ?? "";
  if (!tenant) return "Atteo couldn't tell which organization this team is in.";
  const c = code.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
  if (!/^[A-Z0-9-]{6,40}$/.test(c)) return "That isn't a link code. Get one on Atteo: the board's owner opens Connect Microsoft Teams.";
  // A team owner only (asked of Teams, fail closed), before the code is spent.
  if (!(await isTeamOwner(t, base, team, a.from?.id ?? ""))) return "Only a team owner can link this channel to Atteo.";
  const row = await t.db.prepare(`DELETE FROM teams_codes WHERE code_hash = ? RETURNING board_id, user, expires_at`).bind(await codeHash(t, c)).first<{ board_id: string; user: string; expires_at: number }>();
  if (!row || row.expires_at < t.now()) return "That code is wrong, used or expired. Get a new one on Atteo.";
  // Checked again now: they may have stopped owning the board, or it was encrypted or archived, since the code was made.
  const b = await linkable(t, row.board_id, row.user);
  if (!("id" in b)) return b.error;
  const taken = await linkOfChannel(t, channel);
  if (taken && taken.board_id !== b.id) return "This channel already follows another Atteo board. @Atteo unlink first.";
  const names = await namesOf(t, base, a);
  const who = { id: a.from?.id ?? null, name: nameLabel(a.from?.name) };
  const now = t.now();
  try {
    // Only this board's row is replaced: a channel another board took meanwhile fails the unique index instead.
    await t.db
      .prepare(
        `INSERT INTO teams_links (board_id, created_by, tenant_id, team_id, channel_id, service_url, team_name, channel_name, linked_by, linked_by_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(board_id) DO UPDATE SET created_by = excluded.created_by, tenant_id = excluded.tenant_id, team_id = excluded.team_id, channel_id = excluded.channel_id, service_url = excluded.service_url, team_name = excluded.team_name, channel_name = excluded.channel_name, linked_by = excluded.linked_by, linked_by_name = excluded.linked_by_name, updated_at = excluded.updated_at`,
      )
      .bind(b.id, row.user, tenant, team, channel, base, names.team, names.channel, who.id, who.name, now, now)
      .run();
  } catch {
    return "This channel already follows another Atteo board. @Atteo unlink first.";
  }
  await t.board.setTeams(b.id, true);
  await t.board.notice(b.id, row.user, `Microsoft Teams: now followed by ${names.channel} in ${names.team}, linked by ${who.name}.`).catch((e) => console.error("teams notice failed", e));
  return `This channel now follows ${b.title} on Atteo (linked for ${row.user}). Board posts show here; @Atteo post and @Atteo ask reach the board, labelled as from Teams.`;
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

async function roleOf(t: Teams, board: string, user: string): Promise<string | null> {
  const r = await t.db.prepare(`SELECT role, expires_at FROM members WHERE board_id = ? AND user = ?`).bind(board, user).first<{ role: string; expires_at: number | null }>();
  return r && (r.expires_at == null || r.expires_at > t.now()) ? r.role : null;
}

/** Can this person link this board to Teams? The board row, or why not. */
export async function linkable(t: Teams, board: string, user: string): Promise<BoardLite | { status: number; error: string }> {
  const row = /^b_[a-z0-9]{8,32}$/.test(board) ? await t.db.prepare(`SELECT id, title, encrypted, kind, archived_at, deleted_at FROM boards WHERE id = ?`).bind(board).first<BoardLite>() : null;
  const role = row && !row.deleted_at ? await roleOf(t, board, user) : null;
  if (!row || row.deleted_at || !role) return { status: 404, error: "No such board." };
  if (role !== "owner") return { status: 403, error: "Only the board's owner can connect it to Microsoft Teams." };
  if (row.encrypted) return { status: 409, error: "This board is end-to-end encrypted: the server can't read its posts, so they can't go to Teams." };
  if (row.kind === "agent") return { status: 409, error: "\"Your agent\" stays between you and your agents: it can't be connected to Teams." };
  if (row.kind === "direct") return { status: 409, error: "A conversation between two people can't be connected to Teams." };
  if (row.archived_at) return { status: 409, error: "This board is archived." };
  return row;
}

type Who = { ok: true; viewer: Viewer } | { ok: false; res: Response };

function person(t: Teams, viewer: Viewer | null, url: URL, asPage: boolean): Who {
  if (!teamsOn(t.env)) return { ok: false, res: asPage ? msgPage(viewer, NOT_SET_UP, "Microsoft Teams isn't set up on this server yet.", 503) : json({ error: NOT_SET_UP }, 503) };
  if (!viewer) return { ok: false, res: asPage ? redirect(`/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`) : json({ error: "sign in required" }, 401) };
  if (viewer.via === "agent") return { ok: false, res: json({ error: "Connecting Microsoft Teams is for people, signed in on Atteo. An agent's token can't." }, 403) };
  return { ok: true, viewer };
}

const sameSite = (request: Request) => {
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
};

/** Codes are kept hashed, keyed with a secret (the bot's client secret) so a leaked table can't be checked against guesses. */
const codeHash = (t: Teams, code: string) => hmacHex(`teams-code:${t.env.TEAMS_APP_PASSWORD ?? ""}`, code);

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** A fresh code for this owner and board (their earlier codes for it stop working). */
async function mint(t: Teams, board: string, user: string): Promise<{ code: string; expires_at: number }> {
  const code = newCode();
  const now = t.now();
  await t.db.batch([
    t.db.prepare(`DELETE FROM teams_codes WHERE (board_id = ? AND user = ?) OR expires_at < ?`).bind(board, user, now),
    t.db.prepare(`INSERT INTO teams_codes (code_hash, board_id, user, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`).bind(await codeHash(t, code), board, user, now + CODE_MS, now),
  ]);
  return { code, expires_at: now + CODE_MS };
}

/** The code, and what to do with it. */
function codePage(viewer: Viewer, row: BoardLite, code: string): Response {
  const steps = `<ol style="margin:14px 0 0 18px;line-height:1.7">
<li>Add the Atteo app to your team in Microsoft Teams (skip if it's there already; your Teams admin may need to allow it).</li>
<li>In the channel that should follow ${html(row.title)}, a team owner posts <code>@Atteo link ${html(code)}</code></li></ol>
<p class="small muted" style="margin-top:12px">The code works once, for 10 minutes. Board posts then show in that channel; anyone there can @mention Atteo with post and ask, which reach the board under your link, labelled as from Teams.</p>`;
  return msgPage(viewer, `Connect ${row.title} to Microsoft Teams`, "Two steps:", 200, steps);
}

/** GET /api/integrations/teams/start?board=: what connecting does, and a button that makes the code (a same-site POST). */
export async function start(t: Teams, viewer: Viewer | null, url: URL): Promise<Response> {
  const who = person(t, viewer, url, true);
  if (!who.ok) return who.res;
  const row = await linkable(t, url.searchParams.get("board") ?? "", who.viewer.name);
  if (!("id" in row)) return msgPage(who.viewer, "Can't connect Microsoft Teams", row.error, row.status);
  const form = `<form method="post" action="/api/integrations/teams/code" style="margin-top:14px"><input type="hidden" name="board" value="${html(row.id)}">
<p class="small muted">You'll get a one-time code that a team owner posts as @Atteo link in the Teams channel. Board posts then show there, and anyone in it can post to the board under your link with @Atteo post and @Atteo ask.</p>
<div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn primary">Get a link code</button></div></form>`;
  return msgPage(who.viewer, `Connect ${row.title} to Microsoft Teams`, "A Microsoft Teams channel can follow this board.", 200, form);
}

/** POST /api/integrations/teams/code {board}: a fresh code; JSON, or the start page's form (then the code page). */
export async function code(t: Teams, viewer: Viewer | null, request: Request, url: URL): Promise<Response> {
  const who = person(t, viewer, url, false);
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
  const row = await linkable(t, typeof body.board === "string" ? body.board : "", who.viewer.name);
  if (!("id" in row)) return isForm ? msgPage(who.viewer, "Can't connect Microsoft Teams", row.error, row.status) : json({ error: row.error }, row.status);
  const m = await mint(t, row.id, who.viewer.name);
  if (isForm) return codePage(who.viewer, row, m.code);
  return json({ ok: true, code: m.code, expires_at: m.expires_at, command: `@Atteo link ${m.code}` });
}

/** GET /api/integrations/teams?board=: whether and where the board is linked (any member; agents too, read only). */
export async function status(t: Teams, viewer: Viewer | null, url: URL): Promise<Response> {
  if (!teamsOn(t.env)) return json({ error: NOT_SET_UP }, 503);
  if (!viewer) return json({ error: "sign in required" }, 401);
  const board = url.searchParams.get("board") ?? "";
  if (!/^b_[a-z0-9]{8,32}$/.test(board) || !(await roleOf(t, board, viewer.name))) return json({ error: "No such board." }, 404);
  const link = await linkOf(t, board);
  if (!link) return json({ linked: false });
  // Names only: no Teams user, tenant or team ids.
  return json({ linked: true, active: await linkerOk(t, board, link.created_by), team_name: link.team_name, channel_name: link.channel_name, created_by: link.created_by, linked_by_name: link.linked_by_name, created_at: link.created_at });
}

/** DELETE /api/integrations/teams?board=: unlink (who linked it, or a board owner). */
export async function unlink(t: Teams, viewer: Viewer | null, request: Request, url: URL): Promise<Response> {
  const who = person(t, viewer, url, false);
  if (!who.ok) return who.res;
  if (!sameSite(request)) return json({ error: "Use Atteo's own pages." }, 403);
  const board = url.searchParams.get("board") ?? "";
  const role = /^b_[a-z0-9]{8,32}$/.test(board) ? await roleOf(t, board, who.viewer.name) : null;
  if (!role) return json({ error: "No such board." }, 404);
  const link = await linkOf(t, board);
  if (!link) return json({ ok: true, linked: false });
  if (link.created_by !== who.viewer.name && role !== "owner") return json({ error: `Only ${link.created_by} (who connected it) or a board owner can disconnect Microsoft Teams.` }, 403);
  await dropLinks(t, { board });
  return json({ ok: true, linked: false });
}
