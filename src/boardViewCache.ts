// Short-lived Worker-side cache for expensive read-only board views (snapshot / pin / soul / memory / schedules).
//
// Each board is one Durable Object and handles RPCs one at a time. Open tabs and agents polling the same board
// (CLOUDFLARE_HARDENING.md leftover: "cache read-only board views (summary, pins) for a few seconds in the Worker")
// otherwise wake it on every GET. This isolate keeps the last answer for BOARD_VIEW_CACHE_MS so a burst of polls
// shares one RPC. It is not a shared HTTP cache: private entries (just-mine / people-only) are keyed by principal.
//
// Invalidation:
// - Same isolate: a write through the wrapped stub (post, pin, react, …) bumps a per-board generation, so the next
//   GET misses at once. `registry.bumpBoard` does the same, covering MCP and REST writes that already notify D1.
// - Long-poll wake: the DO said something arrived; this isolate may not have seen the write (another colo handled it),
//   so the waiter bumps generation before it reads.
// - Other isolates / colos: the 3s TTL. A write is visible everywhere within BOARD_VIEW_CACHE_MS even if this isolate
//   never heard about it.
//
// Not cached: `read` / `ack` / `wait` / `editNotices` (they move cursors or hold a socket), single-entry `get`,
// search, and anything that writes.

import type { Viewer } from "./types";

/** How long a Worker isolate reuses a read-only board view. Tiny on purpose (2–5s range): a write handled in
 *  another colo is visible within this window even if this isolate never saw it. */
export const BOARD_VIEW_CACHE_MS = 3_000;
const MAX_KEYS = 2_000;

export function viewPrincipal(v: Viewer | null | undefined): string {
  if (!v?.user) return "anon";
  return `${v.user}:${v.person ? "person" : "agent"}`;
}

type Slot = { at: number; gen: number; value: Promise<unknown> };
const cache = new Map<string, Slot>();
const generation = new Map<string, number>();

/** Drops every cached view of this board in this isolate. The next GET rebuilds. */
export function invalidateBoardViews(boardId: string): void {
  generation.set(boardId, (generation.get(boardId) ?? 0) + 1);
}

export function boardViewGeneration(boardId: string): number {
  return generation.get(boardId) ?? 0;
}

function prune(now: number): void {
  for (const [k, s] of cache) if (now - s.at >= BOARD_VIEW_CACHE_MS) cache.delete(k);
  while (cache.size >= MAX_KEYS) cache.delete(cache.keys().next().value!);
}

/**
 * Reuse `load`'s result for BOARD_VIEW_CACHE_MS in this isolate. Simultaneous callers of the same key share one
 * in-flight promise (the burst). A failed load is not kept. `parts.board` is required so a write can bump generation;
 * viewer-sensitive views must set `principal` (see `viewPrincipal`).
 */
export function cachedBoardView<T>(parts: { board: string; view: string; principal?: string; [k: string]: unknown }, load: () => T | Promise<T>, now = Date.now()): Promise<T> {
  const g = boardViewGeneration(parts.board);
  const key = JSON.stringify({ ...parts, g });
  const hit = cache.get(key);
  if (hit && hit.gen === g && now - hit.at < BOARD_VIEW_CACHE_MS) return hit.value as Promise<T>;
  prune(now);
  // Start `load` now (not on a later tick) so a burst of the same key shares one in-flight RPC.
  let value: Promise<T>;
  try {
    value = Promise.resolve(load());
  } catch (e) {
    value = Promise.reject(e);
  }
  cache.set(key, { at: now, gen: g, value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

/** Tests: forget every cached view and generation. */
export function resetBoardViewCache(): void {
  cache.clear();
  generation.clear();
}

// Snapshot / pin / soul / memory / schedules / info are the hot GETs. `read` is not here: it marks the summary as
// given and records pin-seen. `then` must pass through — Durable Object stubs are thenable.
const CACHED: Record<string, (board: string, args: unknown[]) => { board: string; view: string; principal?: string; [k: string]: unknown }> = {
  snapshot: (board, args) => {
    const after = typeof args[0] === "number" ? args[0] : 0;
    const opts = args[1] && typeof args[1] === "object" ? (args[1] as { latest?: number }) : {};
    return { board, view: "snapshot", principal: viewPrincipal(args[2] as Viewer | null | undefined), after, latest: opts.latest ?? 0 };
  },
  pinned: (board) => ({ board, view: "pinned" }),
  info: (board) => ({ board, view: "info" }),
  soul: (board) => ({ board, view: "soul" }),
  memory: (board) => ({ board, view: "memory" }),
  schedules: (board) => ({ board, view: "schedules" }),
  rootsFor: (board, args) => ({ board, view: "rootsFor", seqs: args[0] }),
  reactions: (board, args) => ({ board, view: "reactions", principal: viewPrincipal(args[0] as Viewer | null | undefined) }),
  reactionsFor: (board, args) => ({ board, view: "reactionsFor", principal: viewPrincipal(args[1] as Viewer | null | undefined), seqs: args[0] }),
};

const PASS = new Set([
  "then",
  "catch",
  "finally",
  "fetch",
  "wait",
  "ack",
  "read",
  "editNotices",
  "editHistory",
  "exists",
  "workingAgentCount",
  "handlingMap",
  "members",
  "allEntries",
  "summary",
  "page",
  "get",
  "reads",
  "humanDecisions",
  "recap",
  "forYou",
  "triggers",
  "grep",
  "grepLines",
  "search",
  "searchLines",
  "searchCards",
  "rankedSearch",
  "taskGet",
  "taskHistory",
  "taskRows",
  "tasks",
  "reviewRows",
  "reviewsBySeq",
  "reviewers",
  "handoffs",
  "claimStates",
  "claimStatesNow",
  "claims",
  "taskTags",
  "docs",
  "docRead",
  "docHistory",
  "docList",
  "image",
  "dumpTables",
  "backup",
  "scanSecrets",
  "sealedAfter",
  "sealedFor",
  "agentsTyping",
  // Frequent, not a new post: typing pings and read receipts must not drop the poll cache on a busy board.
  "typing",
  "seen",
  "join",
  "joinSession",
  "webSocketMessage",
  "webSocketClose",
  "webSocketError",
]);

/**
 * Wraps a board Durable Object stub: hot read-only RPCs are cached per isolate; anything else that isn't a known
 * side-effect-free read bumps generation when it settles, so a post is visible to the next GET on this isolate.
 */
export function cachedBoardStub<T extends object>(boardId: string, stub: T): T {
  return new Proxy(stub, {
    get(target, prop, recv) {
      const orig = Reflect.get(target, prop, recv) as unknown;
      if (typeof prop !== "string" || typeof orig !== "function") return orig;
      if (prop in CACHED) {
        const keyOf = CACHED[prop]!;
        return (...args: unknown[]) => cachedBoardView(keyOf(boardId, args), () => (orig as (...a: unknown[]) => unknown).apply(target, args));
      }
      if (PASS.has(prop)) return (orig as (...a: unknown[]) => unknown).bind(target);
      return (...args: unknown[]) => {
        const result = (orig as (...a: unknown[]) => unknown).apply(target, args);
        return Promise.resolve(result).finally(() => invalidateBoardViews(boardId));
      };
    },
  });
}
