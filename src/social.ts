// Social: find people, become friends, see who's around (on the web, or with an agent online), and talk directly
// on a private board for two friends. Being friends never grants access to other boards (consent doesn't cascade).

import { addMember, recordBoard } from "./registry";
import { newBoardId } from "./util";
import type { Env } from "./types";

export const FRIEND_REQUESTS_PER_DAY = 20;
const ONLINE_MS = 3 * 60 * 1000; // a browser or agent active this recently counts as online
const WATCH_MS = 3 * 60 * 1000;

export type Relation = "self" | "friend" | "pending_out" | "pending_in" | "blocked" | "blocked_you" | "none";

export interface Presence {
  web: number | null; // last seen on the web
  agent: { client: string; seen: number } | null; // the most recent live agent session
  watcher: { seen: number; respond: boolean } | null; // agent-soup watch running for them
}

export interface Person {
  name: string;
  display_name: string | null;
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

/** One line a person reads: "online in Claude Code", "answers in the background", "on the web", "offline". */
export function presenceLabel(p: Presence | undefined): string {
  if (!p) return "offline";
  const bits: string[] = [];
  if (p.agent) bits.push(p.agent.client && p.agent.client !== "agent" ? `agent online in ${p.agent.client}` : "agent online");
  else if (p.watcher?.respond) bits.push("agent answers in the background");
  if (p.web) bits.push("on the web");
  return bits.length ? bits.join(" · ") : "offline";
}

export function isOnline(p: Presence | undefined): boolean {
  return !!(p && (p.agent || p.web || p.watcher?.respond));
}

async function relationOf(env: Env, me: string, other: string): Promise<{ rel: Relation; row: { status: string; requested_by: string; note: string | null } | null }> {
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
      `SELECT u.name, u.display_name, u.bio FROM users u
       WHERE u.name = ?1
          OR ((u.name LIKE ?2 ESCAPE '\\' OR lower(u.display_name) LIKE ?2 ESCAPE '\\') AND (
                EXISTS (SELECT 1 FROM members m1 JOIN members m2 ON m1.board_id = m2.board_id WHERE m1.user = ?3 AND m2.user = u.name)
             OR EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'accepted' AND ((f.a = ?3 AND f.b = u.name) OR (f.b = ?3 AND f.a = u.name)))))
       ORDER BY (u.name = ?1) DESC, u.name LIMIT 20`,
    )
      .bind(q, like, me)
      .all<{ name: string; display_name: string | null; bio: string | null }>()
  ).results;
  return describe(env, me, rows);
}

async function describe(env: Env, me: string, rows: { name: string; display_name: string | null; bio: string | null }[]): Promise<Person[]> {
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
    out.push({ name: r.name, display_name: r.display_name, bio: rel === "friend" || sharedBy[r.name] || rel === "self" ? r.bio : null, relation: rel, presence: rel === "blocked" ? { web: null, agent: null, watcher: null } : pres[r.name], shared_boards: sharedBy[r.name] ?? 0 });
  }
  return out;
}

export async function person(env: Env, me: string, name: string): Promise<Person | null> {
  const r = await env.DB.prepare(`SELECT name, display_name, bio FROM users WHERE name = ?`).bind(name.toLowerCase().replace(/^@/, "")).first<{ name: string; display_name: string | null; bio: string | null }>();
  if (!r) return null;
  return (await describe(env, me, [r]))[0] ?? null;
}

async function notify(env: Env, user: string, actor: string, kind: "friend_request" | "friend_accept", text: string) {
  // Inbox items that aren't about a board use board_id '' and a unique negative seq.
  await env.DB.prepare(`INSERT OR IGNORE INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at) VALUES (?, '', ?, ?, ?, 'person', 'friend', ?, ?)`)
    .bind(user, -Date.now() - Math.floor(Math.random() * 1000), kind, actor, text.slice(0, 160), Date.now())
    .run();
}

/** Ask to be friends (or accept, if they already asked you). Returns the new relation. */
export async function requestFriend(env: Env, me: string, other: string, note: string): Promise<Relation> {
  const who = other.toLowerCase().replace(/^@/, "");
  if (who === me) throw new SocialError("That's you.");
  const exists = await env.DB.prepare(`SELECT 1 AS x FROM users WHERE name = ?`).bind(who).first();
  if (!exists) throw new SocialError(`There's nobody called ${who} on Agent Soup. Check the spelling (handles are exact).`);
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
    ? (await env.DB.prepare(`SELECT name, display_name, bio FROM users WHERE name IN (${names.map(() => "?").join(",")})`).bind(...names).all<{ name: string; display_name: string | null; bio: string | null }>()).results
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
    throw new SocialError(rel === "pending_out" ? `${who} hasn't accepted your friend request yet.` : `You and ${who} aren't friends yet. Send a request first: agent-soup add ${who}`);
  }
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
