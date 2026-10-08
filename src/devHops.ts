// The hop meter (scripts/bench-messaging.mjs, vedu #6564/#6566): how many round trips one request makes to D1 and to
// the board Durable Objects before it answers, and (optionally) a fixed delay on each, so a laptop run has production's
// shape. Locally D1 is a file next to the Worker and answers in about a millisecond; at the edge each D1 query and each
// Durable Object call is a network hop of tens of milliseconds, so what a post costs there is mostly how many hops it
// waits for one after another. The delay makes those serial hops show up in a local timing.
//
// Only with DEV_HOPS=1 on a localhost request (the bench's own --env-file; never wrangler.jsonc or production). Then
// every response carries `x-dev-hops: d1=<n> do=<n>` (hops started while handling it, not ones in waitUntil after it).
//   DEV_D1_MS  added before each D1 query or batch (default 0)
//   DEV_DO_MS  added before each Durable Object call (default 0)
//   DEV_HOPS_LOG=1  also logs each hop (the SQL, or the Durable Object method) to the server log
import type { Env } from "./types";
import { isLocalHost } from "./util";

export interface Hops {
  d1: number;
  do: number;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** D1 with each query (and each batch, one round trip) counted and delayed. */
export function meterD1(db: D1Database, hops: Hops, delay: number, log?: (what: string) => void): D1Database {
  const raw = new WeakMap<object, D1PreparedStatement>(); // proxy → the real statement (batch() wants real ones)
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const p = new Proxy(stmt, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== "function") return v;
        if (prop === "bind") return (...a: unknown[]) => wrap(v.apply(target, a), sql);
        if (prop === "first" || prop === "all" || prop === "raw" || prop === "run")
          return async (...a: unknown[]) => {
            hops.d1++;
            log?.(`d1 ${sql.replace(/\s+/g, " ").slice(0, 140)}`);
            await sleep(delay);
            return v.apply(target, a);
          };
        return v.bind(target);
      },
    });
    raw.set(p, stmt);
    return p;
  };
  return new Proxy(db, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop === "prepare") return (sql: string) => wrap(v.call(target, sql), sql);
      if (prop === "batch")
        return async (stmts: D1PreparedStatement[]) => {
          hops.d1++;
          log?.(`d1 batch of ${stmts.length}`);
          await sleep(delay);
          return v.call(target, stmts.map((x) => raw.get(x) ?? x));
        };
      if (prop === "exec")
        return async (sql: string) => {
          hops.d1++;
          await sleep(delay);
          return v.call(target, sql);
        };
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** A Durable Object namespace whose stubs count (and delay) each call. */
export function meterDO<T extends DurableObjectNamespace<any>>(ns: T, hops: Hops, delay: number, log?: (what: string) => void): T {
  const stub = (s: object) =>
    new Proxy(s, {
      get(target, prop) {
        const v = Reflect.get(target, prop);
        if (typeof v !== "function" || typeof prop !== "string" || prop === "then") return v;
        // Called as target[prop](...): an RPC method is itself a stub, so v.apply would be a remote property "apply".
        return async (...a: unknown[]) => {
          hops.do++;
          log?.(`do ${prop}`);
          await sleep(delay);
          return (target as Record<string, (...x: unknown[]) => unknown>)[prop](...a);
        };
      },
    });
  return new Proxy(ns, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop === "get" || prop === "getByName") return (...a: unknown[]) => stub(Reflect.apply(v as (...x: unknown[]) => object, target, a));
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** The metered env and its counters, or null when the meter is off (always, outside a local DEV_HOPS=1 run). */
export function meter(env: Env, request: Request): { env: Env; hops: Hops } | null {
  if (env.DEV_HOPS !== "1" || !isLocalHost(new URL(request.url).hostname)) return null;
  const hops: Hops = { d1: 0, do: 0 };
  const ms = (v: string | undefined) => Math.max(0, Math.min(1000, Number(v) || 0));
  const url = new URL(request.url);
  const t0 = Date.now(); // +ms since the request began: hops logged at the same offset ran side by side
  const log = env.DEV_HOPS_LOG === "1" ? (what: string) => console.log(`[hops] ${request.method} ${url.pathname} +${Date.now() - t0}ms ${what}`) : undefined;
  return { env: { ...env, DB: meterD1(env.DB, hops, ms(env.DEV_D1_MS), log), BOARD: meterDO(env.BOARD, hops, ms(env.DEV_DO_MS), log) }, hops };
}

/** The response with its hop counts in a header (a WebSocket upgrade is passed through as is). */
export function stamp(res: Response, hops: Hops): Response {
  if (res.status === 101 || res.webSocket) return res;
  const v = `d1=${hops.d1} do=${hops.do}`;
  try {
    res.headers.set("x-dev-hops", v);
    return res;
  } catch {
    const out = new Response(res.body, res); // immutable headers (a fetched response): copy
    out.headers.set("x-dev-hops", v);
    return out;
  }
}

/** Inside a board Durable Object (its own env, which the Worker's meter can't see): its D1 queries are logged and delayed
 *  the same way under DEV_HOPS=1 (there is no request here to check for localhost; production never sets DEV_HOPS). */
export function meterBoardEnv(env: Env): Env {
  if (env.DEV_HOPS !== "1") return env;
  const ms = Math.max(0, Math.min(1000, Number(env.DEV_D1_MS) || 0));
  const log = env.DEV_HOPS_LOG === "1" ? (what: string) => console.log(`[hops] (board object) ${what}`) : undefined;
  return { ...env, DB: meterD1(env.DB, { d1: 0, do: 0 }, ms, log) };
}
