// atteo ping (jxn #5433): whether a member's agent is open and listening, and the infra round trip to it. The board
// pings its agents' CLI sockets ({type: "ping", id} → {type: "pong", id}, src/board.ts listeners); this module turns
// those listeners and the board's known sessions into one row per session. Nothing here wakes a model or posts.

/** One listener of a member's agent: a CLI socket (with its round trip once pinged) or a held `atteo wait` long-poll,
 *  which can't answer a ping itself. */
export interface Listener {
  user: string;
  session: string | null; // the agent session's id
  kind: "socket" | "wait";
  rtt_ms?: number | null; // pinged: the round trip; null: no answer in time (an older CLI)
}

export type LiveState = "listening" | "connected" | "old_cli" | "long_poll" | "no_listener" | "offline";

export interface LiveRow {
  user: string;
  session: string | null; // the session's name; null: the agent as a whole (an MCP connection, an unnamed socket)
  client: string | null;
  state: LiveState;
  rtt_ms?: number;
  last_seen?: number; // no listener (MCP): its last call
}

/** A CLI's answer to the board's {type: "ping", id} frame, sent at once (the model never sees it); null for anything else. */
export function pongFor(d: unknown): string | null {
  const f = d as { type?: unknown; id?: unknown } | null;
  return f?.type === "ping" && typeof f.id === "string" && /^p_[0-9a-f]{1,32}$/.test(f.id) ? JSON.stringify({ type: "pong", id: f.id }) : null;
}

/** "vedu", "@vedu", "vedu's agent", "vedu/bender" → who to ping; "all" or nothing → everyone's agents. */
export function parseTarget(raw: string | null | undefined): { user: string; session: string | null } | null {
  const t = String(raw ?? "").trim().replace(/^@/, "").replace(/['’]s agent$/i, "").toLowerCase();
  if (!t || t === "all" || t === "agents") return null;
  const [user, session] = t.split("/", 2);
  return { user, session: session || null };
}

/**
 * One row per agent session. `listeners`: what the board holds (session ids); `names`: session id → name and client;
 * `sessions`: named sessions seen on this board lately; `mcp`: members whose agent made an MCP call lately (user → when).
 */
export function liveRows(
  listeners: Listener[],
  names: Map<string, { name: string; client: string | null }>,
  sessions: { user: string; name: string; client: string | null; last_seen: number }[],
  mcp: Record<string, number>,
  probe: boolean,
  target: { user: string; session: string | null } | null,
): LiveRow[] {
  const rows = new Map<string, LiveRow>();
  const key = (user: string, session: string | null) => `${user}/${session ?? ""}`;
  const rank: Record<LiveState, number> = { listening: 5, connected: 4, old_cli: 3, long_poll: 2, no_listener: 1, offline: 0 };
  const put = (r: LiveRow) => {
    const k = key(r.user, r.session);
    const was = rows.get(k);
    // A session with several listeners shows its best one (a socket that answered beats a long-poll), fastest first.
    if (!was || rank[r.state] > rank[was.state] || (r.state === was.state && (r.rtt_ms ?? Infinity) < (was.rtt_ms ?? Infinity))) rows.set(k, { ...r, client: r.client ?? was?.client ?? null });
  };
  for (const l of listeners) {
    const n = l.session ? names.get(l.session) : undefined;
    const state: LiveState = l.kind === "wait" ? "long_poll" : !probe ? "connected" : l.rtt_ms != null ? "listening" : "old_cli";
    put({ user: l.user, session: n?.name ?? null, client: n?.client ?? null, state, ...(state === "listening" ? { rtt_ms: l.rtt_ms! } : {}) });
  }
  for (const s of sessions) if (!rows.has(key(s.user, s.name))) put({ user: s.user, session: s.name, client: s.client, state: "no_listener", last_seen: s.last_seen });
  for (const [user, seen] of Object.entries(mcp)) if (![...rows.values()].some((r) => r.user === user)) put({ user, session: null, client: null, state: "no_listener", last_seen: seen });
  let out = [...rows.values()];
  if (target) {
    out = out.filter((r) => r.user === target.user && (!target.session || r.session === target.session));
    if (!out.length) out = [{ user: target.user, session: target.session, client: null, state: "offline" }];
  }
  return out.sort((a, b) => a.user.localeCompare(b.user) || rank[b.state] - rank[a.state] || (a.session ?? "").localeCompare(b.session ?? ""));
}

/** One row in words, for the CLI (and anyone reading the JSON). */
export function describeRow(r: LiveRow, now = Date.now()): string {
  const who = `${r.session ? `${r.user}/${r.session}` : `${r.user}'s agent`}${r.client ? ` (${r.client})` : ""}`;
  const ago = (t?: number) => (t ? `${Math.max(0, Math.round((now - t) / 1000))}s ago` : "a while ago");
  const what: Record<LiveState, string> = {
    listening: `listening · ${r.rtt_ms} ms`,
    connected: "connected",
    old_cli: "connected (old CLI, atteo update)",
    long_poll: "listening (atteo wait: a long-poll can't answer a ping)",
    no_listener: `no listener (MCP), last call ${ago(r.last_seen)}`,
    offline: "offline",
  };
  return `${who}  ${what[r.state]}`;
}
