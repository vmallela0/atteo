// Social: find people, become friends, see who's around (on the web, or with an agent online), and talk directly
// on a private board for two friends. Being friends never grants access to other boards (consent doesn't cascade).

import { addMember, recordBoard } from "./registry";
import { EMOJI_RE, newBoardId, offBoardSeq } from "./util";
import { AgentNameError, cleanAgentName, handleLookalikes, skeleton } from "./agentName";
import type { Env } from "./types";

export const FRIEND_REQUESTS_PER_DAY = 20;
const ONLINE_MS = 3 * 60 * 1000; // a browser or agent active this recently counts as online
const WATCH_MS = 3 * 60 * 1000;

export type Relation = "self" | "friend" | "pending_out" | "pending_in" | "blocked" | "blocked_you" | "none";

export interface Presence {
  web: number | null; // last seen on the web
  agent: { client: string; seen: number } | null; // the most recent live agent session
  watcher: { seen: number; respond: boolean } | null; // atteo watch running for them
}

export interface Person {
  name: string;
  display_name: string | null;
  agent_name: string | null; // what they named their agent ("Jarvis"); it's theirs: show it with them as its owner
  bio: string | null;
  relation: Relation;
  presence: Presence;
  shared_boards: number;
}

const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x]);

export class SocialError extends Error {}

/** Presence for several people at once. */
export async function presenceOf(env: Env, users: string[]): Promise<Record<string, Presence>> {
  const out: Record<string, Presence> = {};
  if (!users.length) return out;
  const q = users.map(() => "?").join(",");
  const now = Date.now();
  const [u, s] = await Promise.all([
    env.DB.prepare(`SELECT name, web_seen, watch_seen, watch_respond FROM users WHERE name IN (${q})`).bind(...users).all<{ name: string; web_seen: number | null; watch_seen: number | null; watch_respond: number }>(),
    env.DB.prepare(`SELECT user, client, MAX(last_seen) AS seen FROM mcp_sessions WHERE user IN (${q}) AND last_seen > ? GROUP BY user`)
      .bind(...users, now - ONLINE_MS)
      .all<{ user: string; client: string | null; seen: number }>(),
  ]);
  for (const name of users) out[name] = { web: null, agent: null, watcher: null };
  for (const r of u.results) {
    out[r.name] = {
      web: r.web_seen && now - r.web_seen < ONLINE_MS ? r.web_seen : null,
      agent: null,
      watcher: r.watch_seen && now - r.watch_seen < WATCH_MS ? { seen: r.watch_seen, respond: !!r.watch_respond } : null,
    };
  }
  for (const r of s.results) if (out[r.user]) out[r.user].agent = { client: r.client || "an agent", seen: r.seen };
  return out;
}

/** A tool name worth showing ("Claude Code", "Cursor"), not a placeholder ("agent", "an agent", "unknown"). */
export function clientName(c: string | null | undefined): string | null {
  return c && !/^(an? )?agent$|^unknown$/i.test(c.trim()) ? c.trim() : null;
}

/** One line a person reads: "Online · agent in Claude Code", "Online", "Agent active", "Agent answers in the background", "Offline". */
export function presenceLabel(p: { web?: unknown; agent?: { client?: string | null } | null; watcher?: { respond?: boolean } | null } | undefined): string {
  if (!p) return "Offline";
  const tool = p.agent ? clientName(p.agent.client) : null;
  const agent = p.agent ? (tool ? `agent in ${tool}` : "agent active") : p.watcher?.respond ? "agent answers in the background" : null;
  if (p.web) return agent ? `Online · ${agent}` : "Online";
  return agent ? agent[0].toUpperCase() + agent.slice(1) : "Offline";
}

export function isOnline(p: Presence | undefined): boolean {
  return !!(p && (p.agent || p.web || p.watcher?.respond));
}

export async function relationOf(env: Env, me: string, other: string): Promise<{ rel: Relation; row: { status: string; requested_by: string; note: string | null } | null }> {
  if (me === other) return { rel: "self", row: null };
  const [a, b] = pair(me, other);
  const row = await env.DB.prepare(`SELECT status, requested_by, note FROM friendships WHERE a = ? AND b = ?`).bind(a, b).first<{ status: string; requested_by: string; note: string | null }>();
  if (!row) return { rel: "none", row };
  if (row.status === "accepted") return { rel: "friend", row };
  if (row.status === "blocked") return { rel: row.requested_by === me ? "blocked" : "blocked_you", row };
  return { rel: row.requested_by === me ? "pending_out" : "pending_in", row };
}

/**
 * Who you can find: anyone by their exact handle, plus friends and people you share a board with by partial name.
 * Someone who blocked you doesn't show up.
 */
export async function findPeople(env: Env, me: string, query: string): Promise<Person[]> {
  const q = query.trim().toLowerCase().replace(/^@/, "").slice(0, 40);
  if (!q) return [];
  const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  const rows = (
    await env.DB.prepare(
      `SELECT u.name, u.display_name, u.bio, u.agent_name FROM users u
       WHERE u.name = ?1
          OR ((u.name LIKE ?2 ESCAPE '\\' OR lower(u.display_name) LIKE ?2 ESCAPE '\\') AND (
                EXISTS (SELECT 1 FROM members m1 JOIN members m2 ON m1.board_id = m2.board_id WHERE m1.user = ?3 AND m2.user = u.name)
             OR EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'accepted' AND ((f.a = ?3 AND f.b = u.name) OR (f.b = ?3 AND f.a = u.name)))
             OR u.listed = 1))
       ORDER BY (u.name = ?1) DESC, u.name LIMIT 20`,
    )
      .bind(q, like, me)
      .all<{ name: string; display_name: string | null; bio: string | null; agent_name: string | null }>()
  ).results;
  return describe(env, me, rows);
}

async function describe(env: Env, me: string, rows: { name: string; display_name: string | null; bio: string | null; agent_name?: string | null }[]): Promise<Person[]> {
  const names = rows.map((r) => r.name);
  const [pres, shared] = await Promise.all([
    presenceOf(env, names),
    names.length
      ? env.DB.prepare(
          `SELECT m2.user AS name, COUNT(*) AS n FROM members m1 JOIN members m2 ON m1.board_id = m2.board_id JOIN boards b ON b.id = m1.board_id
           WHERE m1.user = ? AND b.kind IS NULL AND m2.user IN (${names.map(() => "?").join(",")}) GROUP BY m2.user`,
        )
          .bind(me, ...names)
          .all<{ name: string; n: number }>()
      : Promise.resolve({ results: [] as { name: string; n: number }[] }),
  ]);
  const sharedBy = Object.fromEntries(shared.results.map((r) => [r.name, r.n]));
  const out: Person[] = [];
  for (const r of rows) {
    const { rel } = await relationOf(env, me, r.name);
    if (rel === "blocked_you") continue;
    out.push({ name: r.name, display_name: r.display_name, agent_name: r.agent_name ?? null, bio: rel === "friend" || sharedBy[r.name] || rel === "self" ? r.bio : null, relation: rel, presence: rel === "blocked" ? { web: null, agent: null, watcher: null } : pres[r.name], shared_boards: sharedBy[r.name] ?? 0 });
  }
  return out;
}

export async function person(env: Env, me: string, name: string): Promise<Person | null> {
  const r = await env.DB.prepare(`SELECT name, display_name, bio, agent_name FROM users WHERE name = ?`).bind(name.toLowerCase().replace(/^@/, "")).first<{ name: string; display_name: string | null; bio: string | null; agent_name: string | null }>();
  if (!r) return null;
  return (await describe(env, me, [r]))[0] ?? null;
}

/** Boards (not DMs) you and they are both in: where you know each other from. */
export async function sharedBoards(env: Env, me: string, other: string, limit = 8): Promise<{ id: string; title: string }[]> {
  const r = await env.DB.prepare(
    `SELECT b.id, b.title FROM members m1 JOIN members m2 ON m1.board_id = m2.board_id JOIN boards b ON b.id = m1.board_id
     WHERE m1.user = ? AND m2.user = ? AND b.kind IS NULL ORDER BY b.created_at DESC LIMIT ?`,
  ).bind(me, other, limit).all<{ id: string; title: string }>();
  return r.results;
}

export async function notify(env: Env, user: string, actor: string, kind: "friend_request" | "friend_accept" | "contact_request" | "contact_accept", text: string) {
  // Inbox items that aren't about a board use board_id '' and a unique negative seq (see offBoardSeq).
  await env.DB.prepare(`INSERT OR IGNORE INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at) VALUES (?, '', ?, ?, ?, 'person', 'friend', ?, ?)`)
    .bind(user, offBoardSeq(), kind, actor, text.slice(0, 160), Date.now())
    .run();
}

/** Ask to be friends (or accept, if they already asked you). Returns the new relation. */
export async function requestFriend(env: Env, me: string, other: string, note: string): Promise<Relation> {
  const who = other.toLowerCase().replace(/^@/, "");
  if (who === me) throw new SocialError("That's you.");
  const exists = await env.DB.prepare(`SELECT 1 AS x FROM users WHERE name = ?`).bind(who).first();
  if (!exists) throw new SocialError(`There's nobody called ${who} on Atteo. Check the spelling (handles are exact).`);
  const { rel } = await relationOf(env, me, who);
  if (rel === "friend") return rel;
  if (rel === "pending_out") return rel;
  if (rel === "blocked") throw new SocialError(`You blocked ${who}. Unblock them first.`);
  if (rel === "blocked_you") throw new SocialError(`You can't send ${who} a request.`);
  if (rel === "pending_in") return acceptFriend(env, me, who);
  const today = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM friendships WHERE requested_by = ? AND created_at > ?`).bind(me, Date.now() - 86_400_000).first<{ n: number }>())?.n ?? 0;
  if (today >= FRIEND_REQUESTS_PER_DAY) throw new SocialError(`That's ${FRIEND_REQUESTS_PER_DAY} friend requests today; try again tomorrow.`);
  const [a, b] = pair(me, who);
  await env.DB.prepare(`INSERT OR REPLACE INTO friendships (a, b, status, requested_by, note, created_at) VALUES (?, ?, 'pending', ?, ?, ?)`).bind(a, b, me, note.slice(0, 280) || null, Date.now()).run();
  // Their standing rule: accept requests from people they already share a board with.
  if ((await rulesOf(env, who)).auto_accept_friends === "coworkers") {
    const shared = await env.DB.prepare(`SELECT 1 AS x FROM members m1 JOIN members m2 ON m1.board_id = m2.board_id WHERE m1.user = ? AND m2.user = ? LIMIT 1`).bind(me, who).first();
    if (shared) {
      await env.DB.prepare(`UPDATE friendships SET status = 'accepted', decided_at = ? WHERE a = ? AND b = ?`).bind(Date.now(), a, b).run();
      await notify(env, who, me, "friend_accept", "is now your friend (accepted by your rule for people you share a board with)");
      return "friend";
    }
  }
  await notify(env, who, me, "friend_request", note ? `wants to be friends: ${note}` : "wants to be friends");
  return "pending_out";
}

export async function acceptFriend(env: Env, me: string, other: string): Promise<Relation> {
  const who = other.toLowerCase().replace(/^@/, "");
  const { rel } = await relationOf(env, me, who);
  if (rel === "friend") return rel;
  if (rel !== "pending_in") throw new SocialError(`${who} hasn't sent you a friend request.`);
  const [a, b] = pair(me, who);
  await env.DB.prepare(`UPDATE friendships SET status = 'accepted', decided_at = ? WHERE a = ? AND b = ?`).bind(Date.now(), a, b).run();
  await notify(env, who, me, "friend_accept", "accepted your friend request");
  return "friend";
}

/** Decline a request, cancel your own, or unfriend: all just remove the pair. */
export async function removeFriend(env: Env, me: string, other: string): Promise<void> {
  const who = other.toLowerCase().replace(/^@/, "");
  const { rel } = await relationOf(env, me, who);
  if (rel === "blocked_you") return; // nothing to remove from your side
  const [a, b] = pair(me, who);
  await env.DB.prepare(`DELETE FROM friendships WHERE a = ? AND b = ?`).bind(a, b).run();
}

export async function blockPerson(env: Env, me: string, other: string): Promise<void> {
  const who = other.toLowerCase().replace(/^@/, "");
  if (who === me) throw new SocialError("That's you.");
  const [a, b] = pair(me, who);
  await env.DB.prepare(`INSERT OR REPLACE INTO friendships (a, b, status, requested_by, created_at, decided_at) VALUES (?, ?, 'blocked', ?, ?, ?)`).bind(a, b, me, Date.now(), Date.now()).run();
}

export async function friendsOf(env: Env, me: string): Promise<{ friends: Person[]; incoming: (Person & { note: string | null })[]; outgoing: Person[]; blocked: string[] }> {
  const rows = (
    await env.DB.prepare(`SELECT a, b, status, requested_by, note FROM friendships WHERE a = ?1 OR b = ?1`).bind(me).all<{ a: string; b: string; status: string; requested_by: string; note: string | null }>()
  ).results;
  const other = (r: { a: string; b: string }) => (r.a === me ? r.b : r.a);
  const names = rows.filter((r) => r.status !== "blocked").map(other);
  const users = names.length
    ? (await env.DB.prepare(`SELECT name, display_name, bio, agent_name FROM users WHERE name IN (${names.map(() => "?").join(",")})`).bind(...names).all<{ name: string; display_name: string | null; bio: string | null; agent_name: string | null }>()).results
    : [];
  const people = Object.fromEntries((await describe(env, me, users)).map((p) => [p.name, p]));
  const notes = Object.fromEntries(rows.map((r) => [other(r), r.note]));
  const byOnline = (x: Person, y: Person) => Number(isOnline(y.presence)) - Number(isOnline(x.presence)) || x.name.localeCompare(y.name);
  const pick = (rel: Relation) => Object.values(people).filter((p) => p.relation === rel).sort(byOnline);
  return {
    friends: pick("friend"),
    incoming: pick("pending_in").map((p) => ({ ...p, note: notes[p.name] ?? null })),
    outgoing: pick("pending_out"),
    blocked: rows.filter((r) => r.status === "blocked" && r.requested_by === me).map(other),
  };
}

/**
 * The private board for two friends (created the first time). Doesn't count toward plan limits. Returns its id.
 * The board is the "inbox" between your agents: post now, and their agent gets it now or when it's next online.
 */
export async function directBoard(env: Env, me: string, other: string, initBoard: (id: string, title: string, creator: string) => Promise<{ id: string; title: string; created_by: string; created_at: number }>): Promise<{ id: string; title: string; created: boolean }> {
  const who = other.toLowerCase().replace(/^@/, "");
  const { rel } = await relationOf(env, me, who);
  if (rel !== "friend") {
    throw new SocialError(rel === "pending_out" ? `${who} hasn't accepted your friend request yet.` : `You and ${who} aren't friends yet. Send a request first: atteo add ${who}`);
  }
  return openDirect(env, me, who, initBoard);
}

/** The private 2-person board of a pair, created the first time (callers check they may talk: friends or agent contacts). */
export async function openDirect(env: Env, me: string, who: string, initBoard: (id: string, title: string, creator: string) => Promise<{ id: string; title: string; created_by: string; created_at: number }>): Promise<{ id: string; title: string; created: boolean }> {
  const [a, b] = pair(me, who);
  const key = `${a}|${b}`;
  const existing = await env.DB.prepare(`SELECT id, title FROM boards WHERE direct_key = ?`).bind(key).first<{ id: string; title: string }>();
  if (existing) return { ...existing, created: false };
  const id = newBoardId();
  const info = await initBoard(id, `${a} ↔ ${b}`, me);
  await recordBoard(env, info);
  await env.DB.prepare(`UPDATE boards SET kind = 'direct', direct_key = ? WHERE id = ?`).bind(key, id).run();
  await addMember(env, id, a);
  await addMember(env, id, b);
  return { id, title: info.title, created: true };
}

/** "Your agent": a person's private board with their own agent (any of their sessions), made the first time it's
 *  opened. Its only member is the person; everything they write there is mail for their agent (src/mailbox.ts). Not
 *  end-to-end encrypted, like DMs: an encrypted board takes no plaintext, so agents without the CLI's keys (an MCP
 *  connection) couldn't read or answer it. Doesn't count toward plan limits. */
export async function openAgentChat(env: Env, me: string, initBoard: (id: string, title: string, creator: string) => Promise<{ id: string; title: string; created_by: string; created_at: number }>): Promise<{ id: string; title: string; created: boolean }> {
  const key = agentChatKey(me); // ":" is outside handles, so it never collides with a pair's "a|b"
  const existing = await env.DB.prepare(`SELECT id, title FROM boards WHERE direct_key = ?`).bind(key).first<{ id: string; title: string }>();
  if (existing) return { ...existing, created: false };
  const id = newBoardId();
  const info = await initBoard(id, AGENT_CHAT_TITLE, me);
  await recordBoard(env, info);
  // Two first opens at once: the unique direct_key keeps one; the other board row goes and its id isn't used.
  const won = await env.DB.prepare(`UPDATE boards SET kind = 'agent', direct_key = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM boards WHERE direct_key = ?)`).bind(key, id, key).run().catch(() => null);
  if (!won?.meta.changes) {
    await env.DB.prepare(`DELETE FROM boards WHERE id = ?`).bind(id).run();
    const r = await env.DB.prepare(`SELECT id, title FROM boards WHERE direct_key = ?`).bind(key).first<{ id: string; title: string }>();
    if (r) return { ...r, created: false };
    throw new SocialError("Couldn't open your agent's chat. Try again.");
  }
  await addMember(env, id, me, { role: "owner" });
  return { id, title: info.title, created: true };
}

export const AGENT_CHAT_TITLE = "Your agent";
export const agentChatKey = (user: string) => `self:${user}`;

// ---- profile and standing rules ----

export interface Rules {
  auto_accept_invites?: "friends" | null; // board invites from friends join you right away
  auto_accept_friends?: "coworkers" | null; // friend requests from people you share a board with are accepted
  auto_accept_agents?: "coworkers" | null; // agents of people you share a board with may DM your agent without asking first
}

export async function rulesOf(env: Env, user: string): Promise<Rules> {
  const r = await env.DB.prepare(`SELECT rules FROM users WHERE name = ?`).bind(user).first<{ rules: string | null }>();
  try {
    return r?.rules ? (JSON.parse(r.rules) as Rules) : {};
  } catch {
    return {};
  }
}

export async function isFriend(env: Env, x: string, y: string): Promise<boolean> {
  const [a, b] = pair(x, y);
  return !!(await env.DB.prepare(`SELECT 1 AS k FROM friendships WHERE a = ? AND b = ? AND status = 'accepted'`).bind(a, b).first());
}

/** Display settings (Slack-like), saved per person so the web and the app both follow them. A client pref: private,
 * served by /api/app/prefs (and, as an alias for older clients, the person's own GET /api/me/profile). */
export interface Display {
  text: "s" | "m" | "l";
  density: "comfortable" | "compact";
  theme: "system" | "light" | "dark";
}
export const DISPLAY_DEFAULTS: Display = { text: "m", density: "comfortable", theme: "system" };
const DISPLAY_VALUES: Record<keyof Display, readonly string[]> = {
  text: ["s", "m", "l"],
  density: ["comfortable", "compact"],
  theme: ["system", "light", "dark"],
};
const isDisplayKey = (k: string): k is keyof Display => Object.prototype.hasOwnProperty.call(DISPLAY_VALUES, k);

/** The stored JSON as a full Display: a missing (or unrecognised) value is the default. */
function readDisplay(raw: string | null): Display {
  let v: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object") v = parsed as Record<string, unknown>;
  } catch {}
  const out: Record<string, string> = { ...DISPLAY_DEFAULTS };
  for (const k of Object.keys(DISPLAY_VALUES) as (keyof Display)[]) if (typeof v[k] === "string" && DISPLAY_VALUES[k].includes(v[k] as string)) out[k] = v[k] as string;
  return out as unknown as Display;
}

/** A partial update merged onto the current settings. A bad key or value throws (a 400; nothing is saved). */
export function mergeDisplay(cur: Display, patch: unknown): Display {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new SocialError('display must be an object, e.g. {"text":"l"}.');
  const out: Record<string, string> = { ...cur };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!isDisplayKey(k)) throw new SocialError(`Unknown display setting "${k}": use text, density or theme.`);
    if (typeof v !== "string" || !DISPLAY_VALUES[k].includes(v)) throw new SocialError(`display.${k} must be one of: ${DISPLAY_VALUES[k].join(", ")}.`);
    out[k] = v;
  }
  return out as unknown as Display;
}

/** The reaction picker's default (what the web shows today); a person's own list replaces it. */
export const DEFAULT_REACTIONS: readonly string[] = ["👍", "✅", "🤔", "🎉", "❤️", "🔥", "😂", "🙏"];
export const MAX_REACTION_PREFS = 8;

/** Up to 8 distinct emoji (one grapheme each, <=16 bytes, no :shortcodes:). null or [] clears back to the default. */
export function checkReactionPrefs(v: unknown): string[] | null {
  if (v === null || (Array.isArray(v) && v.length === 0)) return null;
  if (!Array.isArray(v)) throw new SocialError('reactions must be a list of emoji, e.g. ["👍","🎉"].');
  if (v.length > MAX_REACTION_PREFS) throw new SocialError(`reactions holds at most ${MAX_REACTION_PREFS} emoji.`);
  const seen = new Set<string>();
  for (const x of v) {
    const e = typeof x === "string" ? x.trim() : "";
    if (!e || e.startsWith(":") || !EMOJI_RE.test(e) || new TextEncoder().encode(e).length > 16) throw new SocialError(`"${typeof x === "string" ? x.slice(0, 20) : x}" isn't a single emoji.`);
    if (seen.has(e)) throw new SocialError(`reactions has ${e} twice.`);
    seen.add(e);
  }
  return [...seen];
}

function readReactions(raw: string | null): string[] {
  try {
    const a: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(a) && a.length && a.every((x) => typeof x === "string")) return a as string[];
  } catch {}
  return [...DEFAULT_REACTIONS];
}

/** recent_reactions: a person's most-used emoji over the last 90 days, from per-day counters (D1 reaction_usage). */
export const RECENT_REACTIONS = 8;
export const RECENT_REACTION_DAYS = 90;
const reactionDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const firstReactionDay = (now: number) => reactionDay(now - (RECENT_REACTION_DAYS - 1) * 86400_000); // today and the 89 before

/** A person reacted (on) or took their reaction back (off): today's count for that emoji moves by one. Days that have
 *  left the window are dropped as new ones are written, so a person keeps at most 90 days of rows. */
export async function countReaction(db: D1Database, user: string, emoji: string, on: boolean, now = Date.now()) {
  const day = reactionDay(now);
  if (!on) {
    await db.prepare(`UPDATE reaction_usage SET n = n - 1 WHERE user = ? AND day = ? AND emoji = ? AND n > 0`).bind(user, day, emoji).run();
    return;
  }
  await db.batch([
    db.prepare(`INSERT INTO reaction_usage (user, day, emoji, n, last) VALUES (?, ?, ?, 1, ?) ON CONFLICT (user, day, emoji) DO UPDATE SET n = n + 1, last = excluded.last`).bind(user, day, emoji, now),
    db.prepare(`DELETE FROM reaction_usage WHERE user = ? AND day < ?`).bind(user, firstReactionDay(now)),
  ]);
}

/** Up to 8 emoji, most used first (ties: the most recently used). Empty until the person reacts. */
export async function recentReactions(db: D1Database, user: string, now = Date.now()): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT emoji FROM reaction_usage WHERE user = ? AND day >= ? GROUP BY emoji HAVING SUM(n) > 0 ORDER BY SUM(n) DESC, MAX(last) DESC LIMIT ?`)
    .bind(user, firstReactionDay(now), RECENT_REACTIONS)
    .all<{ emoji: string }>();
  return results.map((r) => r.emoji);
}

/** Your own profile. display, reactions and recent_reactions ride along as aliases of /api/app/prefs, for older web and app builds. */
export async function profile(env: Env, user: string) {
  const [r, recent] = await Promise.all([
    env.DB.prepare(`SELECT name, display_name, agent_name, bio, listed, rules, display, reactions, agents_headless FROM users WHERE name = ?`)
      .bind(user)
      .first<{ name: string; display_name: string | null; agent_name: string | null; bio: string | null; listed: number; rules: string | null; display: string | null; reactions: string | null; agents_headless: number | null }>(),
    recentReactions(env.DB, user).catch(() => [] as string[]),
  ]);
  return r
    ? { name: r.name, display_name: r.display_name, agent_name: r.agent_name, bio: r.bio, listed: !!r.listed, rules: (r.rules ? JSON.parse(r.rules) : {}) as Rules, display: readDisplay(r.display), reactions: readReactions(r.reactions), recent_reactions: recent, agents_headless: !!r.agents_headless }
    : null;
}

/** Client-only prefs (the web and the app follow them; agents never see them): GET/POST /api/app/prefs. */
export interface AppPrefs {
  display: Display;
  reactions: string[];
  recent_reactions: string[]; // read-only: counted as the person reacts
}

export async function appPrefs(env: Env, user: string): Promise<AppPrefs | null> {
  const [r, recent] = await Promise.all([
    env.DB.prepare(`SELECT display, reactions FROM users WHERE name = ?`).bind(user).first<{ display: string | null; reactions: string | null }>(),
    recentReactions(env.DB, user).catch(() => [] as string[]),
  ]);
  return r ? { display: readDisplay(r.display), reactions: readReactions(r.reactions), recent_reactions: recent } : null;
}

/** A partial update: display merges, reactions replaces (null or [] back to the default). Anything bad is a 400 and nothing is saved. */
export async function setAppPrefs(env: Env, user: string, p: Record<string, unknown>): Promise<AppPrefs> {
  const cur = await appPrefs(env, user);
  if (!cur) throw new SocialError("No such person.");
  if ("recent_reactions" in p) throw new SocialError("recent_reactions can't be set: it's counted as you react.");
  for (const k of Object.keys(p)) if (k !== "display" && k !== "reactions") throw new SocialError(`Unknown app setting "${k}": use display or reactions.`);
  const display = p.display === undefined ? undefined : mergeDisplay(cur.display, p.display);
  const favs = p.reactions === undefined ? undefined : checkReactionPrefs(p.reactions);
  await env.DB.prepare(`UPDATE users SET display = COALESCE(?, display), reactions = CASE WHEN ? THEN ? ELSE reactions END WHERE name = ?`)
    .bind(display ? JSON.stringify(display) : null, favs === undefined ? 0 : 1, favs ? JSON.stringify(favs) : null, user)
    .run();
  return { ...cur, display: display ?? cur.display, reactions: favs === undefined ? cur.reactions : favs ?? [...DEFAULT_REACTIONS] };
}

/**
 * A name for `user`'s agent, checked against people it could pass for: anyone's handle (look-alike letters too,
 * e.g. a Cyrillic "х" in "jхn"), and the display name of anyone who shares a board with them (or their own).
 */
async function checkAgentName(env: Env, user: string, raw: unknown): Promise<string | null> {
  let name: string | null;
  try {
    name = cleanAgentName(raw);
  } catch (e) {
    throw new SocialError(e instanceof AgentNameError ? e.message : String(e));
  }
  if (!name) return null;
  const handles = handleLookalikes(name);
  const taken = handles.length
    ? await env.DB.prepare(`SELECT name FROM users WHERE name IN (${handles.map(() => "?").join(",")}) LIMIT 1`).bind(...handles).first<{ name: string }>()
    : null;
  if (taken) throw new SocialError(`"${name}" looks like ${taken.name === user ? "your own handle" : `@${taken.name}`}: an agent's name can't pass for a person.`);
  const sk = skeleton(name);
  const people = await env.DB.prepare(
    `SELECT name, display_name FROM users WHERE display_name IS NOT NULL
       AND (name = ?1 OR name IN (SELECT m2.user FROM members m1 JOIN members m2 ON m1.board_id = m2.board_id WHERE m1.user = ?1))`,
  )
    .bind(user)
    .all<{ name: string; display_name: string }>();
  const like = people.results.find((r) => skeleton(r.display_name) === sk);
  if (like) throw new SocialError(`"${name}" looks like ${like.name === user ? "your own name" : `${like.display_name} (@${like.name})`}: an agent's name can't pass for a person.`);
  return name;
}

export async function setProfile(env: Env, user: string, p: { display_name?: unknown; agent_name?: unknown; bio?: unknown; listed?: unknown; rules?: unknown; display?: unknown; agents_headless?: unknown; reactions?: unknown }, onAgentRenamed?: (name: string | null) => void) {
  const cur = await profile(env, user);
  if (!cur) throw new SocialError("No such person.");
  // Checked first too: a refused name is a 400 and nothing else is saved.
  const agentName = p.agent_name === undefined ? cur.agent_name : await checkAgentName(env, user, p.agent_name);
  // Checked first: a bad display value is a 400 and nothing else in the request is saved either.
  const prefs = p.display === undefined ? cur.display : mergeDisplay(cur.display, p.display);
  const favs = p.reactions === undefined ? undefined : checkReactionPrefs(p.reactions);
  if (p.agents_headless !== undefined && typeof p.agents_headless !== "boolean") throw new SocialError("agents_headless must be true or false.");
  const headless = p.agents_headless === undefined ? cur.agents_headless : p.agents_headless;
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) || null : undefined);
  const display = p.display_name === undefined ? cur.display_name : text(p.display_name, 60) ?? null;
  const bio = p.bio === undefined ? cur.bio : text(p.bio, 280) ?? null;
  const listed = p.listed === undefined ? cur.listed : p.listed === true || p.listed === "true" || p.listed === "on" || p.listed === "yes";
  const r = (p.rules && typeof p.rules === "object" ? p.rules : {}) as Record<string, unknown>;
  const rules: Rules = {
    auto_accept_invites: "auto_accept_invites" in r ? (r.auto_accept_invites === "friends" ? "friends" : null) : cur.rules.auto_accept_invites ?? null,
    auto_accept_friends: "auto_accept_friends" in r ? (r.auto_accept_friends === "coworkers" ? "coworkers" : null) : cur.rules.auto_accept_friends ?? null,
    auto_accept_agents: "auto_accept_agents" in r ? (r.auto_accept_agents === "coworkers" ? "coworkers" : null) : cur.rules.auto_accept_agents ?? null,
  };
  await env.DB.prepare(`UPDATE users SET display_name = ?, agent_name = ?, bio = ?, listed = ?, rules = ?, display = COALESCE(?, display), reactions = COALESCE(?, reactions), agents_headless = ? WHERE name = ?`)
    .bind(display, agentName, bio, listed ? 1 : 0, JSON.stringify(rules), p.display === undefined ? null : JSON.stringify(prefs), favs ? JSON.stringify(favs) : null, headless ? 1 : 0, user)
    .run();
  if (favs === null) await env.DB.prepare(`UPDATE users SET reactions = NULL WHERE name = ?`).bind(user).run();
  headlessCache.set(user, { v: headless, at: Date.now() });
  if (agentName !== cur.agent_name) {
    boardNamesCache.clear(); // this isolate shows the new name right away; others within 30s
    onAgentRenamed?.(agentName);
  }
  return { ...cur, display_name: display, agent_name: agentName, bio, listed, rules, display: prefs, reactions: favs === undefined ? cur.reactions : favs ?? [...DEFAULT_REACTIONS], agents_headless: headless };
}

/** Mail from agents with what their people named them: `from_agent_name`, only when set ("Jarvis", with `from` the owner). */
export async function mailWithAgentNames<T extends { board: string | null; from: string; from_via: string | null }>(env: Env, mail: T[]): Promise<(T & { from_agent_name?: string })[]> {
  const boards = [...new Set(mail.filter((m) => m.from_via === "agent" && m.board).map((m) => m.board!))];
  if (!boards.length) return mail;
  const names = Object.fromEntries(await Promise.all(boards.map(async (b) => [b, await boardAgentNames(env, b)] as const)));
  return mail.map((m) => {
    const n = m.from_via === "agent" && m.board ? names[m.board]?.[m.from] : undefined;
    return n ? { ...m, from_agent_name: n } : m;
  });
}

/** What a board's members named their agents (owner → name; only those who did). Cached per isolate for 30s like
 * agentsHeadless: every agent read labels its entries' authors with them, and this saves a D1 read each time. */
const boardNamesCache = new Map<string, { v: Record<string, string>; at: number }>();
export async function boardAgentNames(env: Env, boardId: string): Promise<Record<string, string>> {
  const hit = boardNamesCache.get(boardId);
  if (hit && Date.now() - hit.at < 30_000) return hit.v;
  const r = await env.DB.prepare(`SELECT u.name, u.agent_name FROM members m JOIN users u ON u.name = m.user WHERE m.board_id = ? AND u.agent_name IS NOT NULL`)
    .bind(boardId)
    .all<{ name: string; agent_name: string }>()
    .catch(() => null);
  if (!r) return {}; // not cached: asked again next time
  const v = Object.fromEntries(r.results.map((x) => [x.name, x.agent_name]));
  if (boardNamesCache.size > 5000) boardNamesCache.clear();
  boardNamesCache.set(boardId, { v, at: Date.now() });
  return v;
}

/** Whether this person runs their agents headless (answers and approvals on the board, not the terminal). Cached
 * per isolate for 30s: agents' reads ask on every call, and this saves a D1 read each time. */
const headlessCache = new Map<string, { v: boolean; at: number }>();
export async function agentsHeadless(env: Env, user: string): Promise<boolean> {
  const hit = headlessCache.get(user);
  if (hit && Date.now() - hit.at < 30_000) return hit.v;
  const r = await env.DB.prepare(`SELECT agents_headless FROM users WHERE name = ?`).bind(user).first<{ agents_headless: number | null }>().catch(() => null);
  const v = !!r?.agents_headless;
  if (headlessCache.size > 5000) headlessCache.clear();
  headlessCache.set(user, { v, at: Date.now() });
  return v;
}

/** Throttled "last seen" for presence: at most one write a minute per person per isolate. */
const seenAt = new Map<string, number>();
export function markSeen(env: Env, user: string, what: "web" | "watch", respond = false): Promise<unknown> | null {
  const k = `${what}:${user}`;
  const now = Date.now();
  if (now - (seenAt.get(k) ?? 0) < 60_000) return null;
  seenAt.set(k, now);
  if (seenAt.size > 10_000) seenAt.clear();
  return what === "web"
    ? env.DB.prepare(`UPDATE users SET web_seen = ? WHERE name = ?`).bind(now, user).run()
    : env.DB.prepare(`UPDATE users SET watch_seen = ?, watch_respond = ? WHERE name = ?`).bind(now, respond ? 1 : 0, user).run();
}
