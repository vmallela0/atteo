// Agent-to-agent direct messages. Friends' agents (and agents that already made contact) talk on the pair's private
// direct board right away. First contact from anyone else waits for the other person's OK, once: their inbox asks
// "let them talk?", and on yes the waiting message is delivered. People decide first contact; agents can't.

import type { Board } from "./board";
import type { Mention } from "./mentions";
import * as registry from "./registry";
import { withRetry } from "./retry";
import * as social from "./social";
import type { Env } from "./types";

export class DmError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const pair = (x: string, y: string) => (x < y ? [x, y] : [y, x]);

export type Reach = { ok: true; why: "friend" | "contact" | "rule" } | { ok: false; why: "pending" | "declined" | "unknown" | "blocked" | "self" };

/** Whether `me`'s agent may DM `other`'s agent now. */
export async function reach(env: Env, me: string, other: string): Promise<Reach> {
  if (me === other) return { ok: false, why: "self" };
  const { rel } = await social.relationOf(env, me, other);
  if (rel === "blocked" || rel === "blocked_you") return { ok: false, why: "blocked" };
  if (rel === "friend") return { ok: true, why: "friend" };
  const [a, b] = pair(me, other);
  const c = await env.DB.prepare(`SELECT status FROM agent_contacts WHERE a = ? AND b = ?`).bind(a, b).first<{ status: string }>();
  if (c?.status === "accepted") return { ok: true, why: "contact" };
  if (c?.status === "declined") return { ok: false, why: "declined" };
  if (c?.status === "pending") return { ok: false, why: "pending" };
  // The owner's standing rule: agents of people they share a board with may write without asking.
  if ((await social.rulesOf(env, other)).auto_accept_agents === "coworkers" && (await coworkers(env, me, other))) return { ok: true, why: "rule" };
  return { ok: false, why: "unknown" };
}

async function coworkers(env: Env, x: string, y: string): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT 1 AS k FROM members m1 JOIN members m2 ON m1.board_id = m2.board_id WHERE m1.user = ? AND m2.user = ? LIMIT 1`).bind(x, y).first());
}

/** Someone you could ask: shares a board with you, or listed their agent in the directory. */
async function askable(env: Env, me: string, other: string): Promise<boolean> {
  if (await coworkers(env, me, other)) return true;
  return !!(await env.DB.prepare(`SELECT 1 AS k FROM agent_profiles WHERE user = ? AND listed = 1`).bind(other).first());
}

/** Asks `other` to let the agents talk, holding `text` until they decide. Repeated asks while pending just update it. */
export async function requestContact(env: Env, me: string, other: string, text: string): Promise<void> {
  if (!(await env.DB.prepare(`SELECT 1 AS k FROM users WHERE name = ?`).bind(other).first())) throw new DmError(`No one is called ${other}.`, 404);
  if (!(await askable(env, me, other))) throw new DmError(`You can't reach ${other}'s agent: you don't share a board, you aren't friends, and their agent isn't listed. Ask them to add you as a friend.`, 403);
  const recent = await env.DB.prepare(`SELECT COUNT(*) AS n FROM agent_contacts WHERE requested_by = ? AND created_at > ?`).bind(me, Date.now() - 86_400_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= 20) throw new DmError("That's 20 first-contact requests today; try again tomorrow.", 429);
  const [a, b] = pair(me, other);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO agent_contacts (a, b, status, requested_by, first_text, created_at) VALUES (?, ?, 'pending', ?, ?, ?)
     ON CONFLICT(a, b) DO UPDATE SET first_text = excluded.first_text WHERE agent_contacts.status = 'pending' AND agent_contacts.requested_by = excluded.requested_by`,
  )
    .bind(a, b, me, text.slice(0, 4000), now)
    .run();
  await social.notify(env, other, me, "contact_request", text.slice(0, 160));
}

/** The person `me` decides on `other`'s request; returns the waiting message (to deliver) on accept. */
export async function decide(env: Env, me: string, other: string, accept: boolean): Promise<{ requester: string; text: string | null } | null> {
  const [a, b] = pair(me, other);
  const c = await env.DB.prepare(`SELECT status, requested_by, first_text FROM agent_contacts WHERE a = ? AND b = ?`).bind(a, b).first<{ status: string; requested_by: string; first_text: string | null }>();
  if (!c || c.status !== "pending" || c.requested_by === me) throw new DmError(`There's no request from ${other}'s agent waiting for you.`, 404);
  await env.DB.prepare(`UPDATE agent_contacts SET status = ?, decided_at = ?, first_text = NULL WHERE a = ? AND b = ?`).bind(accept ? "accepted" : "declined", Date.now(), a, b).run();
  await env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE user = ? AND kind = 'contact_request' AND actor = ? AND read_at IS NULL`).bind(Date.now(), me, other).run();
  if (!accept) return null;
  await social.notify(env, other, me, "contact_accept", "Your agents can talk now.");
  return { requester: c.requested_by, text: c.first_text };
}

/** Requests waiting on you, and yours waiting on others. */
export async function pending(env: Env, me: string) {
  const rows = (
    await env.DB.prepare(`SELECT a, b, requested_by, first_text, created_at FROM agent_contacts WHERE status = 'pending' AND (a = ?1 OR b = ?1) ORDER BY created_at DESC LIMIT 100`).bind(me).all<{
      a: string;
      b: string;
      requested_by: string;
      first_text: string | null;
      created_at: number;
    }>()
  ).results;
  const other = (r: { a: string; b: string }) => (r.a === me ? r.b : r.a);
  return {
    incoming: rows.filter((r) => r.requested_by !== me).map((r) => ({ from: other(r), text: r.first_text, created_at: r.created_at })),
    outgoing: rows.filter((r) => r.requested_by === me).map((r) => ({ to: other(r), created_at: r.created_at })),
  };
}

/** Posts `text` from `from` to `to`'s agent on their direct board (created the first time). Callers check reach first. */
export async function deliver(
  env: Env,
  stub: (id: string) => DurableObjectStub<Board>,
  from: string,
  to: string,
  text: string,
  via: "agent" | "person",
  opts: { session?: string | null; toSession?: string | null; idem?: string } = {},
): Promise<{ board: string; seq: number }> {
  const d = await social.openDirect(env, from, to, (bid, title, creator) => stub(bid).init(bid, title, creator));
  const mentions: Mention[] = opts.toSession && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(opts.toSession) ? [{ user: to, agent: true, session: opts.toSession }] : [];
  const entry = await withRetry(async () => await stub(d.id).post(from, { type: "note", text, to, mentions, via, client: via === "agent" ? "dm" : null, session: opts.session ?? null, idem: opts.idem ?? crypto.randomUUID() }));
  await registry.bumpBoard(env, d.id, entry.seq).catch(() => {});
  return { board: d.id, seq: entry.seq };
}

/** Your direct boards (DMs, and "Your agent": your own chat with your agents) with activity in the last 30 days,
 *  newest first: every agent session of yours hears them without joining. */
export async function directBoardsOf(env: Env, user: string): Promise<{ id: string; title: string; kind: string }[]> {
  return (
    await env.DB.prepare(
      `SELECT b.id, b.title, b.kind FROM boards b JOIN members m ON m.board_id = b.id WHERE m.user = ? AND b.kind IN ('direct', 'agent') AND b.last_activity > ? ORDER BY b.last_activity DESC LIMIT 20`,
    )
      .bind(user, Date.now() - 30 * 86_400_000)
      .all<{ id: string; title: string; kind: string }>()
  ).results;
}
