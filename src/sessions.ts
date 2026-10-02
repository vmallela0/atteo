// Agent sessions: one per running agent (a Claude Code window, a Codex run, a bot). A person can run many at once,
// on the same board or on different ones. Each has a name, the boards it has joined, and its own read position on
// every board (kept by the board itself), so sessions never consume each other's unread entries.

import type { Env } from "./types";

export interface AgentSession {
  id: string;
  user: string;
  name: string;
  client: string | null;
  boards: string[];
  created_at: number;
  last_seen: number;
  ended_at: number | null;
  status?: string | null; // what it's doing, in its own words
  status_at?: number | null;
}

export class SessionError extends Error {}

export const SESSION_RE = /^as_[A-Za-z0-9_-]{12,40}$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const MAX_BOARDS = 20;
const ACTIVE_MS = 24 * 3600 * 1000; // a session not seen for a day is listed as idle

type Row = Omit<AgentSession, "boards"> & { boards: string };
const toSession = (r: Row): AgentSession => ({ ...r, boards: JSON.parse(r.boards || "[]") as string[] });

/** A short, readable name: the client's (claude, codex…) plus a number if that's taken among your live sessions. */
export function cleanName(raw: string | null | undefined): string | null {
  const n = (raw ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 32);
  return NAME_RE.test(n) ? n : null;
}

/** `name` is one the person chose (refused if taken); `suggest` is a default (numbered if taken: claude, claude-2…). */
export async function create(env: Env, user: string, p: { name?: string | null; suggest?: string | null; client?: string | null }): Promise<AgentSession> {
  const live = await list(env, user);
  const taken = new Set(live.map((s) => s.name));
  let name = cleanName(p.name) ?? cleanName(p.suggest) ?? cleanName(p.client) ?? "agent";
  if (taken.has(name)) {
    if (p.name && cleanName(p.name) === name) throw new SessionError(`You already have a session named "${name}". Pick another name, or end that one first.`);
    let i = 2;
    while (taken.has(`${name}-${i}`)) i++;
    name = `${name}-${i}`;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  const id = "as_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const now = Date.now();
  const client = (p.client ?? "").trim().slice(0, 60) || null;
  await env.DB.prepare(`INSERT INTO agent_sessions (id, user, name, client, boards, created_at, last_seen) VALUES (?, ?, ?, ?, '[]', ?, ?)`).bind(id, user, name, client, now, now).run();
  return { id, user, name, client, boards: [], created_at: now, last_seen: now, ended_at: null };
}

/** Your session by id or by name (live ones only). */
export async function get(env: Env, user: string, idOrName: string): Promise<AgentSession | null> {
  const r = SESSION_RE.test(idOrName)
    ? await env.DB.prepare(`SELECT * FROM agent_sessions WHERE id = ? AND user = ? AND ended_at IS NULL`).bind(idOrName, user).first<Row>()
    : await env.DB.prepare(`SELECT * FROM agent_sessions WHERE name = ? AND user = ? AND ended_at IS NULL ORDER BY last_seen DESC LIMIT 1`).bind(idOrName.toLowerCase(), user).first<Row>();
  return r ? toSession(r) : null;
}

/** Your live sessions, most recently active first. */
export async function list(env: Env, user: string): Promise<(AgentSession & { active: boolean })[]> {
  const rows = (await env.DB.prepare(`SELECT * FROM agent_sessions WHERE user = ? AND ended_at IS NULL ORDER BY last_seen DESC LIMIT 100`).bind(user).all<Row>()).results;
  const now = Date.now();
  return rows.map((r) => ({ ...toSession(r), active: now - r.last_seen < ACTIVE_MS }));
}

/** Marks the session as active (at most one write a minute per session per isolate). */
const seen = new Map<string, number>();
export function touch(env: Env, id: string): Promise<unknown> | null {
  const now = Date.now();
  if (now - (seen.get(id) ?? 0) < 60_000) return null;
  seen.set(id, now);
  return env.DB.prepare(`UPDATE agent_sessions SET last_seen = ? WHERE id = ?`).bind(now, id).run();
}

export async function rename(env: Env, s: AgentSession, raw: string): Promise<AgentSession> {
  const name = cleanName(raw);
  if (!name) throw new SessionError("Names are 1–32 characters: lowercase letters, numbers, dot, dash or underscore.");
  if (name !== s.name && (await list(env, s.user)).some((x) => x.name === name)) throw new SessionError(`You already have a session named "${name}".`);
  await env.DB.prepare(`UPDATE agent_sessions SET name = ? WHERE id = ?`).bind(name, s.id).run();
  return { ...s, name };
}

export async function setBoards(env: Env, s: AgentSession, boards: string[]): Promise<AgentSession> {
  const uniq = [...new Set(boards)];
  if (uniq.length > MAX_BOARDS) throw new SessionError(`A session can be on at most ${MAX_BOARDS} boards. Leave one first.`);
  await env.DB.prepare(`UPDATE agent_sessions SET boards = ?, last_seen = ? WHERE id = ?`).bind(JSON.stringify(uniq), Date.now(), s.id).run();
  return { ...s, boards: uniq };
}

/** Sets (or, with an empty text, clears) what the session says it's doing. One line, 120 characters at most. */
export async function setStatus(env: Env, s: AgentSession, raw: string | null): Promise<AgentSession> {
  const status = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
  const now = Date.now();
  await env.DB.prepare(`UPDATE agent_sessions SET status = ?, status_at = ?, last_seen = ? WHERE id = ?`).bind(status, status ? now : null, now, s.id).run();
  return { ...s, status, status_at: status ? now : null };
}

export async function end(env: Env, s: AgentSession): Promise<void> {
  await env.DB.prepare(`UPDATE agent_sessions SET ended_at = ? WHERE id = ?`).bind(Date.now(), s.id).run();
}

/** A board left (or lost access to) drops out of every session of that person. */
export async function dropBoard(env: Env, user: string, board: string): Promise<void> {
  for (const s of await list(env, user)) if (s.boards.includes(board)) await setBoards(env, s, s.boards.filter((b) => b !== board));
}

/** Agent sessions working on a board lately (any of its members'), most recent first. */
export async function onBoard(env: Env, board: string): Promise<{ user: string; name: string; client: string | null; last_seen: number; status: string | null }[]> {
  if (!/^b_[a-z0-9]+$/.test(board)) return [];
  return (
    await env.DB.prepare(`SELECT user, name, client, last_seen, status FROM agent_sessions WHERE ended_at IS NULL AND last_seen > ? AND boards LIKE ? ORDER BY last_seen DESC LIMIT 50`)
      .bind(Date.now() - ACTIVE_MS, `%"${board}"%`)
      .all<{ user: string; name: string; client: string | null; last_seen: number; status: string | null }>()
  ).results;
}
