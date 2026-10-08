// D1 read replicas (vedu #6581): the hot board reads are served by a D1 read replica near the Worker instead of the
// primary, through the D1 Sessions API. Off unless D1_REPLICAS=1 (staging first; docs in docs/STAGING.md), and only
// useful once read replication is enabled on the database itself (dashboard, or the REST API's read_replication).
//
// Which requests: GET /b/<board> (the board page), GET /api/boards/<board>/updates (every open tab, per message) and
// GET /api/boards/<board>/entries[/<seq>] (agents, SDKs, "load earlier"). Everything else, among it every write, /mcp,
// sign-in, tokens, OAuth, invites, joins and access changes, keeps plain env.DB, which D1 always serves from the
// primary: "otherwise all queries will continue to be executed only by the primary database" (D1 docs).
//
// How one of those requests reads: a single Session that starts "first-primary". Its first query goes to the primary
// and gives the Session a bookmark B (the primary's state at that moment); every later read in the request may be
// served by a replica, but only one that has caught up to at least B (sequential consistency). Whichever query comes
// first goes to the primary; in these requests that is the sign-in lookup (sessions for a cookie, tokens for a bearer
// token, or the token's user when the token is in the isolate's short cache, as before). Queries sent before the first
// answer arrives carry no bookmark yet, so they too go to the primary.
//
// Why that's safe for access (the review's question): the request's first query starts after the request arrived, so
// B covers every write committed before the request began, by anyone: a member removed or demoted, a token revoked, a
// board deleted. The access check (boardAccess) and every other read here see at least B, so a removal that finished
// before this request was sent is always seen, exactly as on the primary. The one difference: a removal committed in
// the few milliseconds between this request's first query and its access read is caught on the primary but may not be
// on a replica; that request then behaves as if it had arrived a moment earlier (it was in flight when the removal
// happened, so either order is a correct answer). No write reads a replica: writes always go to the primary.
//
// Read-your-writes: a write finished before your next request starts, so the next request's B covers it. This holds
// for every client, with or without a bookmark, which is why the session never starts from the client's bookmark: a
// client's last bookmark is always older than "first-primary" (it would let the sign-in lookup itself read a replica
// that hasn't seen a revocation). The response still carries the Session's bookmark (x-d1-bookmark) for observability.
//
// Writes inside these GETs (last-seen and last-used stamps, mostly in waitUntil) go to plain env.DB, not the Session:
// a write through a Session moves its bookmark past the write, and every later read in it would then wait for a replica
// to catch up to that write. The Board Durable Objects keep their own env.DB (the primary); they never use a Session.
import type { Env } from "./types";

export const BOOKMARK_HEADER = "x-d1-bookmark";

/** The paths whose GETs read through a replica Session. Board ids as BOARD_RE. */
const HOT_GET = /^\/(?:b\/b_[a-z0-9]{8,32}|api\/boards\/b_[a-z0-9]{8,32}\/(?:updates|entries(?:\/\d+)?))\/?$/;

export const isHotRead = (method: string, path: string) => (method === "GET" || method === "HEAD") && HOT_GET.test(path);

/** Reads (SELECT, or a WITH that ends in one) may read a replica; anything else is a write and goes to the primary. */
const isRead = (sql: string) => /^\s*(SELECT|WITH)\b/i.test(sql);

type Target = Pick<D1Database, "prepare" | "batch">;

/** Which instance served the Session's reads, from D1's result meta (all/run/batch report it; first() doesn't). */
export interface Served {
  primary: number;
  replica: number;
  where?: string; // the region (and colo) that served the last of them, e.g. "WNAM/SJC"
}
const count = (served: Served, r: { meta?: { served_by_primary?: boolean; served_by_region?: string; served_by_colo?: string } } | null | undefined) => {
  const m = r?.meta;
  if (m?.served_by_primary === true) served.primary++;
  else if (m?.served_by_primary === false) served.replica++;
  if (m?.served_by_region) served.where = [m.served_by_region, m.served_by_colo].filter(Boolean).join("/");
};

/** A statement that picks where it runs when it runs: reads in the Session, writes on the primary. */
class Stmt {
  constructor(
    private readonly to: (read: boolean) => Target,
    private readonly served: Served,
    readonly sql: string,
    private readonly args: unknown[] = [],
  ) {}
  bind(...args: unknown[]): Stmt {
    return new Stmt(this.to, this.served, this.sql, args);
  }
  /** The real statement, prepared on `on` (the Session or the primary). */
  on(on: Target): D1PreparedStatement {
    const s = on.prepare(this.sql);
    return this.args.length ? s.bind(...this.args) : s;
  }
  private read() {
    return isRead(this.sql);
  }
  private real(): D1PreparedStatement {
    return this.on(this.to(this.read()));
  }
  first(col?: string) {
    return col === undefined ? this.real().first() : this.real().first(col);
  }
  async all() {
    const r = await this.real().all();
    if (this.read()) count(this.served, r);
    return r;
  }
  async run() {
    const r = await this.real().run();
    if (this.read()) count(this.served, r);
    return r;
  }
  raw(options?: { columnNames?: boolean }) {
    return (this.real().raw as (o?: { columnNames?: boolean }) => Promise<unknown[]>)(options);
  }
}

export interface ReadSession {
  /** env.DB for this request: reads through the Session, writes to the primary. */
  db: D1Database;
  /** The Session's bookmark: the newest database version this request has read (null before its first read). */
  bookmark(): string | null;
  served: Served;
}

/** A first-primary Session over `primary`, its reads and writes split as above. */
export function readSession(primary: D1Database): ReadSession {
  const session = primary.withSession("first-primary");
  const served: Served = { primary: 0, replica: 0 };
  const to = (read: boolean): Target => (read ? session : primary);
  const db = {
    prepare: (sql: string) => new Stmt(to, served, sql),
    // One round trip, all in one place: in the Session only when every statement in it is a read.
    batch: async (stmts: Stmt[]) => {
      const reads = stmts.every((s) => isRead(s.sql)), on = to(reads);
      const r = await on.batch(stmts.map((s) => s.on(on)));
      if (reads) count(served, r[0]);
      return r;
    },
    exec: (sql: string) => primary.exec(sql),
    withSession: (c?: string) => primary.withSession(c),
    dump: () => primary.dump(),
  };
  return { db: db as unknown as D1Database, bookmark: () => session.getBookmark(), served };
}

/** This request's replica Session, or null: D1_REPLICAS is off, the request isn't a hot read, or the binding has no Sessions. */
export function begin(env: Env, request: Request): ReadSession | null {
  if (env.D1_REPLICAS !== "1" || typeof env.DB?.withSession !== "function") return null;
  if (!isHotRead(request.method, new URL(request.url).pathname)) return null;
  return readSession(env.DB);
}

/** The response with the Session's bookmark (when it read anything) and which instances served its reads
 *  (x-d1-served: primary=<n> replica=<n> last=<region/colo>, from D1's meta), so a run on staging can be checked. */
export function stamp(res: Response, rs: ReadSession): Response {
  const b = rs.bookmark();
  if (!b || res.status === 101 || res.webSocket) return res;
  const served = `primary=${rs.served.primary} replica=${rs.served.replica}${rs.served.where ? ` last=${rs.served.where}` : ""}`;
  try {
    res.headers.set(BOOKMARK_HEADER, b);
    res.headers.set("x-d1-served", served);
    return res;
  } catch {
    const out = new Response(res.body, res); // immutable headers (a fetched response): copy
    out.headers.set(BOOKMARK_HEADER, b);
    out.headers.set("x-d1-served", served);
    return out;
  }
}
