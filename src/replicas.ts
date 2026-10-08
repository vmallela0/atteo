// D1 read replicas (vedu #6581): the presentational reads of the hot board GETs are served by a D1 read replica near the
// Worker instead of the primary, through the D1 Sessions API. Off unless D1_REPLICAS=1 (staging first), and only useful
// once read replication is enabled on the database itself (dashboard, or the REST API's read_replication).
//
// The rule (vedu/coordinator, after review): nothing that decides who may see what ever reads a replica. env.DB stays
// the primary in every request (D1 serves plain binding queries from the primary). For GET /b/<board>, GET
// /api/boards/<board>/updates and GET /api/boards/<board>/entries[/<seq>] only, the request also gets env.DB_REPLICA, a
// Session, and a call site opts in to it explicitly through presentational(env), for reads whose staleness can only
// change what's displayed: the sidebar's boards, pins, presence (agents, sessions, machines), the displayed member list
// and names, the board row's picture/kind/charter, approval rules shown on the page, linked Slack channels.
// On the primary, always, whatever the replica lag: the sign-in lookup (sessions, tokens, users), the access check
// (membership, role, deleted), the role that gates what the page offers (spend, retract), pending invites, mutes,
// every write, the /ws upgrade, the board Durable Objects, /mcp, OAuth and every other route. A new read is on the
// primary unless someone opts it in, so the safe side is the default. test/d1Replicas.test.ts pins the opt-in list.
//
// Read-your-writes for the replica reads: the Session starts first-primary with a one-row anchor query sent the
// moment the request arrives (alongside the sign-in lookup, so it adds no wait). It returns a bookmark B covering every
// write committed before the request began, and every later read in the Session waits for a replica at least at B.
// So a post, join or rename you made is in the very next page or /updates you load. The client's own bookmark is never
// used (it's always older than B); the response carries B (x-d1-bookmark) and which instances served (x-d1-served).
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
  const rs = readSession(env.DB);
  // The anchor: the Session's first query (so, the primary), sent now, so B covers everything before this request.
  rs.db.prepare(`SELECT 1 AS anchor`).all().catch(() => {});
  return rs;
}

/** A displayed member list (maybe from a replica) with the viewer's own row set to `role`, their role as the primary's
 *  access check read it: what the page offers the viewer never rests on a replica. Added if the list lacks them. */
export function withRole<M extends { user: string; role: unknown }>(list: M[], viewer: string, role: M["role"] | null): M[] {
  if (role == null) return list.filter((m) => m.user !== viewer);
  if (!list.some((m) => m.user === viewer)) return [...list, { user: viewer, role, joined_at: Date.now(), last_seen: 0, display_name: null, agent_name: null, expires_at: null } as unknown as M];
  return list.map((m) => (m.user === viewer ? { ...m, role } : m));
}

/** The env for a read that may come from a replica: only presentational reads in the hot GETs (see above). Anywhere
 *  else, or with the switch off, it's env itself (the primary). Never for a read that decides access or visibility. */
export function presentational(env: Env): Env {
  return env.DB_REPLICA ? { ...env, DB: env.DB_REPLICA } : env;
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
