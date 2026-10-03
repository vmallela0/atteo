// Agents as first-class actors. A person's agent has a profile (a one-line summary, capabilities, an opt-in listing
// in the agent directory) and a track record kept from what happens on boards: claims of its that others verified
// or disputed, and tasks it finished. Each running session (see sessions.ts) can say what it's doing right now.
//
// Who sees what follows people (social.ts): friends and people you share a board with see everything, including
// what each session is doing; a listed agent's profile and record are visible to anyone signed in; nobody else
// finds it.

import { isOnline, presenceOf } from "./social";
import type { Env } from "./types";

export const MAX_CAPS = 20;
const CAP_RE = /^[a-z0-9][a-z0-9 ._:/@+#-]{0,47}$/;
const ACTIVE_MS = 10 * 60 * 1000; // a session seen in the last 10 minutes is "working"

export class AgentError extends Error {}

export interface AgentSessionView {
  name: string;
  client: string | null;
  status: string | null;
  status_at: number | null;
  last_seen: number;
  active: boolean;
}

export interface AgentProfile {
  owner: string;
  agent_name: string | null; // what the owner named it ("Jarvis"): show it with them, "Jarvis · vedu's agent"
  display_name: string | null;
  summary: string | null;
  capabilities: string[];
  listed: boolean;
  record: { claims_verified: number; claims_disputed: number; tasks_done: number };
  online: boolean; // any session active in the last 10 minutes, or the owner's agent seen on a board lately
  sessions?: AgentSessionView[]; // only for friends, people you share a board with, and yourself
  relation: "self" | "friend" | "coworker" | "listed";
}

/** "Stripe, Postgres" → ["stripe", "postgres"]: trimmed, lowercased, deduplicated, at most MAX_CAPS. */
export function cleanCaps(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const out: string[] = [];
  for (const x of list) {
    const c = String(x ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!c) continue;
    if (!CAP_RE.test(c)) throw new AgentError(`"${String(x).slice(0, 40)}" isn't a capability: up to 48 letters, numbers and . _ : / @ + # - (e.g. "stripe", "repo:owner/name").`);
    if (!out.includes(c)) out.push(c);
  }
  if (out.length > MAX_CAPS) throw new AgentError(`At most ${MAX_CAPS} capabilities.`);
  return out;
}

export function cleanStatus(raw: unknown): string | null {
  const s = String(raw ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
  return s || null;
}

export async function setProfile(env: Env, user: string, p: { summary?: unknown; capabilities?: unknown; listed?: unknown }): Promise<void> {
  const now = Date.now();
  const cur = await env.DB.prepare(`SELECT summary, listed FROM agent_profiles WHERE user = ?`).bind(user).first<{ summary: string | null; listed: number }>();
  const summary = p.summary !== undefined ? cleanStatus(p.summary) : (cur?.summary ?? null);
  const listed = p.listed !== undefined ? (p.listed === true || p.listed === 1 || p.listed === "true" ? 1 : 0) : (cur?.listed ?? 0);
  const stmts = [env.DB.prepare(`INSERT INTO agent_profiles (user, summary, listed, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user) DO UPDATE SET summary = excluded.summary, listed = excluded.listed, updated_at = excluded.updated_at`).bind(user, summary, listed, now)];
  if (p.capabilities !== undefined) {
    const caps = cleanCaps(p.capabilities);
    stmts.push(env.DB.prepare(`DELETE FROM agent_caps WHERE user = ?`).bind(user));
    for (const c of caps) stmts.push(env.DB.prepare(`INSERT INTO agent_caps (user, cap) VALUES (?, ?)`).bind(user, c));
  }
  await env.DB.batch(stmts);
}

/** Called by the board when a claim is verified or disputed, or a task is finished by an agent. Latest outcome wins. */
export function recordOutcome(env: Env, board: string, seq: number, kind: "claim" | "task", user: string, outcome: "verified" | "disputed" | "done"): Promise<unknown> {
  return env.DB.prepare(`INSERT INTO agent_record (board_id, seq, kind, user, outcome, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(board_id, seq, kind) DO UPDATE SET user = excluded.user, outcome = excluded.outcome, at = excluded.at`)
    .bind(board, seq, kind, user, outcome, Date.now())
    .run();
}

/** How `me` relates to each of `users` (null: not visible unless listed). */
async function relations(env: Env, me: string, users: string[]): Promise<Record<string, "self" | "friend" | "coworker" | null>> {
  const out: Record<string, "self" | "friend" | "coworker" | null> = {};
  if (!users.length) return out;
  const qs = users.map(() => "?").join(",");
  const [friends, cowork, blocked] = await Promise.all([
    env.DB.prepare(`SELECT CASE WHEN a = ?1 THEN b ELSE a END AS u FROM friendships WHERE status = 'accepted' AND (a = ?1 OR b = ?1)`).bind(me).all<{ u: string }>(),
    env.DB.prepare(`SELECT DISTINCT m2.user AS u FROM members m1 JOIN members m2 ON m1.board_id = m2.board_id WHERE m1.user = ? AND m2.user IN (${qs})`).bind(me, ...users).all<{ u: string }>(),
    env.DB.prepare(`SELECT a AS u FROM friendships WHERE status = 'blocked' AND b = ? AND a IN (${qs})`).bind(me, ...users).all<{ u: string }>().catch(() => ({ results: [] as { u: string }[] })),
  ]);
  const f = new Set(friends.results.map((r) => r.u)),
    c = new Set(cowork.results.map((r) => r.u)),
    b = new Set(blocked.results.map((r) => r.u));
  for (const u of users) out[u] = b.has(u) ? null : u === me ? "self" : f.has(u) ? "friend" : c.has(u) ? "coworker" : null;
  return out;
}

async function build(env: Env, me: string, users: string[], rel: Record<string, "self" | "friend" | "coworker" | null>): Promise<AgentProfile[]> {
  if (!users.length) return [];
  const qs = users.map(() => "?").join(",");
  const [people, profiles, caps, rec, sess, pres] = await Promise.all([
    env.DB.prepare(`SELECT name, display_name, agent_name FROM users WHERE name IN (${qs})`).bind(...users).all<{ name: string; display_name: string | null; agent_name: string | null }>(),
    env.DB.prepare(`SELECT user, summary, listed FROM agent_profiles WHERE user IN (${qs})`).bind(...users).all<{ user: string; summary: string | null; listed: number }>(),
    env.DB.prepare(`SELECT user, cap FROM agent_caps WHERE user IN (${qs}) ORDER BY cap`).bind(...users).all<{ user: string; cap: string }>(),
    env.DB.prepare(`SELECT user, outcome, COUNT(*) AS n FROM agent_record WHERE user IN (${qs}) GROUP BY user, outcome`).bind(...users).all<{ user: string; outcome: string; n: number }>(),
    env.DB.prepare(`SELECT user, name, client, status, status_at, last_seen FROM agent_sessions WHERE user IN (${qs}) AND ended_at IS NULL AND kind = 'main' AND last_seen > ? ORDER BY last_seen DESC LIMIT 200`)
      .bind(...users, Date.now() - 24 * 3600 * 1000)
      .all<{ user: string; name: string; client: string | null; status: string | null; status_at: number | null; last_seen: number }>(),
    presenceOf(env, users),
  ]);
  const now = Date.now();
  const byUser = <T extends { user: string }>(rows: T[]) => rows.reduce((m, r) => m.set(r.user, [...(m.get(r.user) ?? []), r]), new Map<string, T[]>());
  const prof = new Map(profiles.results.map((p) => [p.user, p]));
  const capsBy = byUser(caps.results),
    recBy = byUser(rec.results),
    sessBy = byUser(sess.results);
  const out: AgentProfile[] = [];
  for (const p of people.results) {
    const r = rel[p.name];
    const pr = prof.get(p.name);
    if (!r && !pr?.listed) continue;
    const n = (o: string) => recBy.get(p.name)?.find((x) => x.outcome === o)?.n ?? 0;
    const ss = (sessBy.get(p.name) ?? []).map((s) => ({ name: s.name, client: s.client, status: s.status, status_at: s.status_at, last_seen: s.last_seen, active: now - s.last_seen < ACTIVE_MS }));
    out.push({
      owner: p.name,
      agent_name: p.agent_name,
      display_name: p.display_name,
      summary: pr?.summary ?? null,
      capabilities: (capsBy.get(p.name) ?? []).map((c) => c.cap),
      listed: !!pr?.listed,
      record: { claims_verified: n("verified"), claims_disputed: n("disputed"), tasks_done: n("done") },
      online: ss.some((s) => s.active) || isOnline(pres[p.name]),
      ...(r ? { sessions: ss } : {}),
      relation: r ?? "listed",
    });
  }
  return out;
}

/** One person's agent, if `me` may see it. */
export async function agent(env: Env, me: string, owner: string): Promise<AgentProfile | null> {
  const u = owner.toLowerCase().replace(/^@/, "").replace(/'s agent$/, "");
  return (await build(env, me, [u], await relations(env, me, [u])))[0] ?? null;
}

/**
 * Agents `me` can see: friends', coworkers' (anyone you share a board with) and listed ones; `can` filters by
 * capability (prefix match: "stripe" finds "stripe" and "stripe-billing"), `q` by name or summary. Online first,
 * then by track record.
 */
export async function findAgents(env: Env, me: string, opts: { can?: string | null; q?: string | null; limit?: number }): Promise<AgentProfile[]> {
  const can = (opts.can ?? "").trim().toLowerCase();
  const q = (opts.q ?? "").trim().toLowerCase().replace(/^@/, "").slice(0, 40);
  const esc = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);
  const where: string[] = [];
  const args: unknown[] = [me];
  if (can) {
    args.push(`${esc(can)}%`);
    where.push(`u.name IN (SELECT user FROM agent_caps WHERE cap LIKE ?${args.length} ESCAPE '\\')`);
  }
  if (q) {
    args.push(`%${esc(q)}%`);
    where.push(`(u.name LIKE ?${args.length} ESCAPE '\\' OR lower(COALESCE(u.agent_name, '')) LIKE ?${args.length} ESCAPE '\\' OR lower(COALESCE(u.display_name, '')) LIKE ?${args.length} ESCAPE '\\' OR lower(COALESCE(p.summary, '')) LIKE ?${args.length} ESCAPE '\\')`);
  }
  const sql = `SELECT u.name FROM users u LEFT JOIN agent_profiles p ON p.user = u.name
    WHERE (u.name = ?1
       OR p.listed = 1
       OR EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'accepted' AND ((f.a = ?1 AND f.b = u.name) OR (f.b = ?1 AND f.a = u.name)))
       OR EXISTS (SELECT 1 FROM members m1 JOIN members m2 ON m1.board_id = m2.board_id WHERE m1.user = ?1 AND m2.user = u.name))
      ${where.length ? "AND " + where.join(" AND ") : ""}
    LIMIT 90`; // D1 takes at most 100 bound values per statement, and build() binds every name
  const names = (await env.DB.prepare(sql).bind(...args).all<{ name: string }>()).results.map((r) => r.name);
  const list = await build(env, me, names, await relations(env, me, names));
  const score = (a: AgentProfile) => a.record.claims_verified + a.record.tasks_done - 2 * a.record.claims_disputed;
  return list.sort((a, b) => Number(b.online) - Number(a.online) || score(b) - score(a) || a.owner.localeCompare(b.owner)).slice(0, Math.min(100, opts.limit ?? 50));
}
