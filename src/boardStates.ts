import { withRetry } from "./retry";
import type { Env } from "./types";

export const BOARD_STATE_CACHE_MS = 10_000;
export const BOARD_WORKING_MS = 120_000;
export interface BoardAgentPresence { user: string; session: string | null; last_seen: number }
export interface BoardState {
  id: string;
  title: string;
  kind: "board" | "dm";
  working_agents: number;
  pending_approvals: number;
  state: "approval" | "working" | "quiet";
}

export function boardState(working_agents: number, pending_approvals: number): BoardState["state"] {
  return pending_approvals > 0 ? "approval" : working_agents > 0 ? "working" : "quiet";
}

/** A session counts once, however many entries it handles. Only current members' unended sessions are supplied. */
export function workingAgents(sessions: BoardAgentPresence[], handling: { user: string; session: string | null }[], now: number): number {
  const key = (user: string, session: string | null) => JSON.stringify([user, session]);
  const busy = new Set(handling.map((h) => key(h.user, h.session)));
  return new Set(sessions.filter((s) => s.last_seen > now - BOARD_WORKING_MS || busy.has(key(s.user, s.session))).map((s) => key(s.user, s.session))).size;
}

// One indexed membership read, including the authoritative approval counts (also works for encrypted boards).
// Presence is the /agents route's main sessions and its legacy MCP fallback, restricted to current members.
// CROSS JOIN keeps SQLite starting with these boards' members instead of scanning every live session site-wide.
export const BOARD_STATES_SQL = `
WITH mine AS MATERIALIZED (
  SELECT b.id, b.title, b.kind, b.last_activity FROM members m JOIN boards b ON b.id = m.board_id
  WHERE m.user = ?1 AND b.deleted_at IS NULL
), sessions AS MATERIALIZED (
  SELECT m.board_id, s.user, s.id AS session, s.last_seen FROM mine b
  CROSS JOIN members m ON m.board_id = b.id CROSS JOIN agent_sessions s ON s.user = m.user
  WHERE s.ended_at IS NULL AND s.kind = 'main'
    AND EXISTS (SELECT 1 FROM json_each(s.boards) WHERE value = b.id)
)
SELECT b.id, b.title, CASE WHEN b.kind IN ('direct', 'agent') THEN 'dm' ELSE 'board' END AS kind,
  (SELECT COUNT(*) FROM approvals a WHERE a.board_id = b.id AND a.user = ?1
    AND a.status = 'pending' AND a.expires_at > ?2) AS pending_approvals,
  (SELECT json_group_array(json_object('user', user, 'session', session, 'last_seen', last_seen)) FROM (
    SELECT user, session, last_seen FROM sessions WHERE board_id = b.id
    UNION ALL
    SELECT s.user, NULL, MAX(s.last_seen) FROM mcp_sessions s JOIN members m ON m.board_id = s.board_id AND m.user = s.user
    WHERE s.board_id = b.id AND s.last_seen > ?3
      AND NOT EXISTS (SELECT 1 FROM sessions a WHERE a.board_id = b.id AND a.user = s.user)
    GROUP BY s.user
  )) AS sessions
FROM mine b ORDER BY b.last_activity DESC, b.id`;

type Row = Pick<BoardState, "id" | "title" | "kind" | "pending_approvals"> & { sessions: string };
const cache = new Map<string, { at: number; value: Promise<BoardState[]> }>();

/** Per-isolate, per-person cache; simultaneous polls share the same query and parallel DO fan-out. */
export function boardStates(env: Env, user: string): Promise<BoardState[]> {
  const now = Date.now();
  const key = JSON.stringify([env.PUBLIC_URL, user]);
  const hit = cache.get(key);
  if (hit && now - hit.at < BOARD_STATE_CACHE_MS) return hit.value;
  for (const [k, v] of cache) if (now - v.at >= BOARD_STATE_CACHE_MS) cache.delete(k);
  // Bound memory even when many distinct people poll within one cache interval.
  if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
  const value = (async () => {
    const rows = await env.DB.prepare(BOARD_STATES_SQL).bind(user, now, now - BOARD_WORKING_MS).all<Row>();
    return Promise.all(rows.results.map(async ({ sessions, ...b }) => {
      const presence = JSON.parse(sessions) as BoardAgentPresence[];
      const working_agents = await withRetry(() => env.BOARD.get(env.BOARD.idFromName(b.id)).workingAgentCount(presence, now));
      return { ...b, working_agents, state: boardState(working_agents, b.pending_approvals) };
    }));
  })();
  cache.set(key, { at: now, value });
  value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
  return value;
}
