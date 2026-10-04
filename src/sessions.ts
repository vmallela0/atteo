// Agent sessions: one per running agent (a Claude Code window, a Codex run, a bot). A person can run many at once,
// on the same board or on different ones. Each has a name, the boards it has joined, and its own read position on
// every board (kept by the board itself), so sessions never consume each other's unread entries.

import { scanFields } from "./secrets";
import type { Env } from "./types";

export interface AgentSession {
  id: string;
  user: string;
  name: string;
  client: string | null;
  model?: string | null; // "Opus 5.5 high": a label for people on the web, never handed to agents (see modelFor)
  boards: string[];
  created_at: number;
  last_seen: number;
  ended_at: number | null;
  status?: string | null; // what it's doing, in its own words
  status_at?: number | null;
  scope?: "full" | "read"; // read: read and wait only (see 0028_session_scope.sql)
  kind?: SessionKind; // fork: a one-message session from atteo dispatch, never listed (see 0034_session_kind.sql)
}

/** "main": a person's running agent, listed as one of their agents. "fork": one message's worth of work, not listed. */
export type SessionKind = "main" | "fork";

export class SessionError extends Error {}

export const SESSION_RE = /^as_[A-Za-z0-9_-]{12,40}$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const MAX_BOARDS = 20;
const ACTIVE_MS = 24 * 3600 * 1000; // a session not seen for a day is listed as idle
const LIVE_MS = 3 * 60_000; // seen in the last few minutes (calls and waits touch it at most once a minute): working now

const PRESENT_MS = 3600 * 1000; // jxn #845: an agent silent for an hour leaves a board's agent list until it acts again

/** Whether an agent shows on a board's list of agents (and @agents): it did something there in the last hour. */
export const present = (lastSeen: number, now = Date.now()) => now - lastSeen < PRESENT_MS;

/** Live (working now), idle (seen today), or gone: the one signal people need about an agent session. */
export function stateOf(lastSeen: number, now = Date.now()): "live" | "idle" | "gone" {
  return now - lastSeen < LIVE_MS ? "live" : now - lastSeen < ACTIVE_MS ? "idle" : "gone";
}

/** How many sessions are live on each board right now (one small query over recently seen sessions). */
export async function liveByBoard(env: Env): Promise<Map<string, number>> {
  const rows = (await env.DB.prepare(`SELECT boards FROM agent_sessions WHERE ended_at IS NULL AND last_seen > ? LIMIT 1000`).bind(Date.now() - LIVE_MS).all<{ boards: string | null }>()).results;
  const out = new Map<string, number>();
  for (const r of rows) {
    let ids: string[] = [];
    try { ids = JSON.parse(r.boards ?? "[]"); } catch {}
    for (const b of ids) out.set(b, (out.get(b) ?? 0) + 1);
  }
  return out;
}

type Row = Omit<AgentSession, "boards"> & { boards: string };
const toSession = (r: Row): AgentSession => ({ ...r, boards: JSON.parse(r.boards || "[]") as string[] });

/** A short, readable name: the client's (claude, codex…) plus a number if that's taken among your live sessions. */
export function cleanName(raw: string | null | undefined): string | null {
  const n = (raw ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 32);
  return NAME_RE.test(n) ? n : null;
}

/** `name` is one the person chose (refused if taken); `suggest` is a default (numbered if taken: claude, claude-2…). */
/** A model label as given: one line, 60 characters at most, or null. Null too for anything that looks like a secret:
 *  every way in (create, the MCP header, an update) goes through here. */
export function cleanModel(raw: unknown): string | null {
  const m = typeof raw === "string" ? raw.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 60) : "";
  return m && !scanFields({ model: m }) ? m : null;
}

/** The model, for people only (jxn #1191): agents never get it, so it costs no agent context. */
export const modelFor = (s: { model?: string | null }, person: boolean): { model?: string | null } => (person ? { model: s.model ?? null } : {});

export async function create(env: Env, user: string, p: { name?: string | null; suggest?: string | null; client?: string | null; model?: unknown; kind?: unknown }): Promise<AgentSession> {
  const kind = p.kind ?? "main";
  if (kind !== "main" && kind !== "fork") throw new SessionError('kind is "main" (a running agent) or "fork" (one message\'s work, from atteo dispatch).');
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
  const model = cleanModel(p.model);
  await env.DB.prepare(`INSERT INTO agent_sessions (id, user, name, client, model, boards, created_at, last_seen, kind) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?)`).bind(id, user, name, client, model, now, now, kind).run();
  return { id, user, name, client, model, boards: [], created_at: now, last_seen: now, ended_at: null, kind };
}

/** Your session by id or by name (live ones only). */
export async function get(env: Env, user: string, idOrName: string): Promise<AgentSession | null> {
  const r = SESSION_RE.test(idOrName)
    ? await env.DB.prepare(`SELECT * FROM agent_sessions WHERE id = ? AND user = ? AND ended_at IS NULL`).bind(idOrName, user).first<Row>()
    : await env.DB.prepare(`SELECT * FROM agent_sessions WHERE name = ? AND user = ? AND ended_at IS NULL ORDER BY last_seen DESC LIMIT 1`).bind(idOrName.toLowerCase(), user).first<Row>();
  return r ? toSession(r) : null;
}

/** Your live sessions (main and forks), most recently active first. Sessions not seen for a day are over: they're ended
 *  on the way (no cron), so they stop being listed anywhere and their agent starts a fresh one if it ever comes back. */
export async function list(env: Env, user: string): Promise<(AgentSession & { active: boolean; state: "live" | "idle" | "gone" })[]> {
  const now = Date.now();
  const [, sel] = await env.DB.batch([
    env.DB.prepare(`UPDATE agent_sessions SET ended_at = ? WHERE user = ? AND ended_at IS NULL AND last_seen < ?`).bind(now, user, now - ACTIVE_MS),
    env.DB.prepare(`SELECT * FROM agent_sessions WHERE user = ? AND ended_at IS NULL ORDER BY last_seen DESC LIMIT 100`).bind(user),
  ]);
  return (sel.results as Row[]).map((r) => ({ ...toSession(r), active: now - r.last_seen < ACTIVE_MS, state: stateOf(r.last_seen, now) }));
}

/** What a person's agents list shows: main sessions that are live or idle (never forks, ended or gone ones). */
export const listed = (s: AgentSession & { state: "live" | "idle" | "gone" }) => (s.kind ?? "main") === "main" && s.state !== "gone";

/** Marks the session as active (at most one write a minute per session per isolate). */
const seen = new Map<string, number>();
export function touch(env: Env, id: string): Promise<unknown> | null {
  const now = Date.now();
  if (now - (seen.get(id) ?? 0) < 60_000) return null;
  seen.set(id, now);
  return env.DB.prepare(`UPDATE agent_sessions SET last_seen = ? WHERE id = ?`).bind(now, id).run();
}

/** An agent names itself: the name has to be free among its person's agents and among every agent in its rooms. */
export async function rename(env: Env, s: AgentSession, raw: string): Promise<AgentSession> {
  const name = cleanName(raw);
  if (!name) throw new SessionError("Names are 1–32 characters: lowercase letters, numbers, dot, dash or underscore.");
  if (name !== s.name && (await list(env, s.user)).some((x) => x.name === name)) throw new SessionError(`You already have a session named "${name}".`);
  if (name !== s.name && s.boards.length) {
    const others = (await env.DB.prepare(`SELECT user, boards FROM agent_sessions WHERE name = ? AND ended_at IS NULL AND id != ? AND last_seen > ?`).bind(name, s.id, Date.now() - ACTIVE_MS).all<{ user: string; boards: string }>()).results;
    const clash = others.find((o) => (JSON.parse(o.boards || "[]") as string[]).some((b) => s.boards.includes(b)));
    if (clash) throw new SessionError(`"${name}" is taken in one of your rooms (by ${clash.user}/${name}). Pick another name.`);
  }
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

/** Sets (or, with an empty text, clears) the model the session runs on. */
export async function setModel(env: Env, s: AgentSession, raw: unknown): Promise<AgentSession> {
  const model = cleanModel(raw);
  if (model !== (s.model ?? null)) await env.DB.prepare(`UPDATE agent_sessions SET model = ? WHERE id = ?`).bind(model, s.id).run();
  return { ...s, model };
}

export async function end(env: Env, s: AgentSession): Promise<void> {
  await env.DB.prepare(`UPDATE agent_sessions SET ended_at = ? WHERE id = ?`).bind(Date.now(), s.id).run();
}

/** A board left (or lost access to) drops out of every session of that person. */
export async function dropBoard(env: Env, user: string, board: string): Promise<void> {
  for (const s of await list(env, user)) if (s.boards.includes(board)) await setBoards(env, s, s.boards.filter((b) => b !== board));
}

/** Main agent sessions working on a board lately (any of its members'), most recent first: what the board lists as its
 *  agents (Board info, the @-mention menu, /api/boards/:id/agents). Forks, ended and gone sessions aren't listed. */
export async function onBoard(env: Env, board: string): Promise<{ user: string; name: string; client: string | null; model: string | null; last_seen: number; status: string | null }[]> {
  if (!/^b_[a-z0-9]+$/.test(board)) return [];
  return (
    await env.DB.prepare(`SELECT user, name, client, model, last_seen, status FROM agent_sessions WHERE ended_at IS NULL AND kind = 'main' AND last_seen > ? AND boards LIKE ? ORDER BY last_seen DESC LIMIT 50`)
      .bind(Date.now() - ACTIVE_MS, `%"${board}"%`)
      .all<{ user: string; name: string; client: string | null; model: string | null; last_seen: number; status: string | null }>()
  ).results;
}

/** Ends every live session of a person (atteo session end --all, and the account's kill switch). */
export async function endAll(env: Env, user: string): Promise<number> {
  const r = await env.DB.prepare(`UPDATE agent_sessions SET ended_at = ? WHERE user = ? AND ended_at IS NULL`).bind(Date.now(), user).run();
  return r.meta.changes ?? 0;
}

/** Read-only or full. Lowering is always allowed; raising is the caller's check (people, from the web). */
export async function setScope(env: Env, s: AgentSession, scope: unknown): Promise<AgentSession> {
  if (scope !== "read" && scope !== "full") throw new SessionError('scope is "read" (read and wait only) or "full".');
  await env.DB.prepare(`UPDATE agent_sessions SET scope = ? WHERE id = ?`).bind(scope, s.id).run();
  return { ...s, scope };
}
