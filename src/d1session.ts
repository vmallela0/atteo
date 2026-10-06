// D1 read sessions (Sessions API). A first slice of read replication for the hot read-only lookups:
// the web session, the bearer token, membership, and the agent-session directory. Writes stay on `env.DB`.
//
// Bookmark strategy — per request, never an isolate-wide bookmark:
// A bookmark is a database version, not a person. Reusing the newest bookmark seen on this isolate would let
// person B's auth read run on a replica that is only guaranteed to include person A's writes, so B can miss
// their own just-created session or still see a membership that was revoked after that bookmark. Each request
// therefore opens its own session at "first-primary" (no bookmark). The first read hits the primary — the only
// copy while replicas are off — and later reads in that same request share the session, so a replica may serve
// them only after it has caught up to that primary read.
// `continueRead` is the bookmark-present path: it sends a bookmark only when this request's own session just
// observed it. Any other string (another request's bookmark, a header, a module global) starts at the primary.
// Nothing here stores a bookmark on the isolate, in a cookie, or on a response.
//
// Where `withSession` is missing or throws (unit tests, miniflare), reads use `env.DB` as they do today.

import { retryingReads } from "./retry";

const FIRST_PRIMARY = "first-primary";

type SessionHandle = D1DatabaseSession;

interface Scope {
  /** Read handle for this request. The primary binding when the Sessions API isn't there. */
  reads: D1Database;
  /** The session `getBookmark` lives on, or null when we fell back to the primary. */
  raw: SessionHandle | null;
}

const scopes = new WeakMap<object, Scope>();
/** Bookmarks this env's own session has returned. Not a lookup key, and not shared with another env. */
const observed = new WeakMap<object, string>();

function withSessionOf(db: D1Database): D1Database["withSession"] | null {
  const open = db.withSession;
  return typeof open === "function" ? open : null;
}

/** A session anchored at `constraint`, or null when this runtime has no Sessions API. */
function tryOpenSession(db: D1Database, constraint: string): SessionHandle | null {
  const open = withSessionOf(db);
  if (!open) return null;
  try {
    const session = open.call(db, constraint);
    if (!session || typeof session.prepare !== "function") return null;
    return session;
  } catch {
    return null;
  }
}

function bookmarkOf(session: SessionHandle | null): string | null {
  if (!session || typeof session.getBookmark !== "function") return null;
  try {
    const b = session.getBookmark();
    return typeof b === "string" && b.trim() ? b.trim() : null;
  } catch {
    return null;
  }
}

function readsFrom(db: D1Database, constraint: string): { reads: D1Database; raw: SessionHandle | null } {
  const session = tryOpenSession(db, constraint);
  if (!session) return { reads: db, raw: null };
  // The session's SELECTs retry through a dropped connection, same as `env.DB`.
  return { reads: retryingReads(session as unknown as D1Database), raw: session };
}

/**
 * One read session for this request's `env` (a fresh object per fetch, not the long-lived binding).
 * It always starts at the primary. A second call does not retarget it, so a later caller cannot swap in
 * someone else's bookmark. Continuing from a bookmark this request already observed is `continueRead`.
 */
export function attachReadSession(env: { DB: D1Database }): void {
  if (scopes.has(env)) return;
  const opened = readsFrom(env.DB, FIRST_PRIMARY);
  scopes.set(env, { reads: opened.reads, raw: opened.raw });
}

/**
 * The database for a read-only query. The request's session when `attachReadSession` ran; otherwise one
 * shot at the primary (not remembered, so a long-lived binding cannot carry a bookmark into the next call).
 */
export function readDb(env: { DB: D1Database }): D1Database {
  const scope = scopes.get(env);
  if (scope) return scope.reads;
  return readsFrom(env.DB, FIRST_PRIMARY).reads;
}

/** Bookmark from this request's session, after a query. Null when there is no session or nothing has run. */
export function sessionBookmark(env: object): string | null {
  const scope = scopes.get(env);
  const b = scope ? bookmarkOf(scope.raw) : null;
  if (b) observed.set(env, b);
  return b;
}

/**
 * Bookmark-present read. The handle is anchored at `bookmark` only when this env's session observed it.
 * A foreign bookmark is ignored and the read starts at the primary, which is also the fallback when
 * `withSession` is unavailable.
 */
export function continueRead(env: { DB: D1Database }, bookmark: string | null | undefined): D1Database {
  const requested = (bookmark ?? "").trim();
  const constraint = requested && observed.get(env) === requested ? requested : FIRST_PRIMARY;
  return readsFrom(env.DB, constraint).reads;
}
