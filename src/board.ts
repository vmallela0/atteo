// One Durable Object per board. A single writer gives each board a strict sequence order;
// its embedded SQLite holds the entry log, members and their read cursors.

import { DurableObject } from "cloudflare:workers";
import { computeSummary, formatSummary, DEFAULT_SUMMARY_CHARS, type Summary } from "./state";
import { blockedMessage, scanFields, scanText, type SecretHit } from "./secrets";
import { ENTRY_TYPES, type BoardInfo, type Entry, type Env, type Member, type NewEntry } from "./types";

export const MAX_TEXT = 32_000;
export const MAX_ARTIFACT = 256_000;
export const MAX_WAIT_MS = 55_000;

export class BoardError extends Error {}

interface Waiter {
  user: string;
  wake: () => void;
}

type Row = Record<string, SqlStorageValue>;

function toEntry(r: Row): Entry {
  return {
    seq: r.seq as number,
    ts: r.ts as number,
    author: r.author as string,
    type: r.type as Entry["type"],
    text: r.text as string,
    to: (r.to_user as string | null) ?? null,
    reply_to: (r.reply_to as number | null) ?? null,
    resolves: JSON.parse((r.resolves as string) || "[]"),
    supersedes: (r.supersedes as number | null) ?? null,
    retracts: (r.retracts as number | null) ?? null,
    via: ((r.via as string | null) ?? null) as Entry["via"],
    client: (r.client as string | null) ?? null,
    artifact_name: (r.artifact_name as string | null) ?? null,
    artifact_size: (r.artifact_size as number | null) ?? null,
  };
}

const ENTRY_COLS = "seq, ts, author, type, text, to_user, reply_to, resolves, supersedes, retracts, via, client, artifact_name, artifact_size";

export class Board extends DurableObject<Env> {
  private sql: SqlStorage;
  private waiters = new Set<Waiter>();
  private watchers = new Set<() => void>(); // web viewers long-polling for any new entry

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        author TEXT NOT NULL,
        type TEXT NOT NULL,
        text TEXT NOT NULL,
        to_user TEXT,
        reply_to INTEGER,
        resolves TEXT NOT NULL DEFAULT '[]',
        supersedes INTEGER,
        retracts INTEGER,
        via TEXT,
        client TEXT,
        artifact_name TEXT,
        artifact_size INTEGER,
        artifact_content TEXT
      );
      CREATE TABLE IF NOT EXISTS members (
        name TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL DEFAULT 0,
        joined_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
    `);
    this.migrate();
    // Keep-alive pings from open board tabs are answered without waking this object (no duration billed).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // ---- live updates for the web UI: hibernating WebSockets ----

  /** The Worker forwards an authorized upgrade here; it has already checked the session and membership. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ws" || request.headers.get("Upgrade") !== "websocket") return new Response("Not found", { status: 404 });
    const user = url.searchParams.get("user") ?? "";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [user]);
    server.send(JSON.stringify({ type: "hello", last: this.info().last_seq }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(): Promise<void> {
    // Clients only send "ping" (auto-answered). Nothing else is expected.
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {}
  }

  private broadcast(msg: object) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {}
    }
  }

  /** Columns added after a board was created. Idempotent; runs on every wake-up. */
  private migrate() {
    const cols = new Set(this.sql.exec("PRAGMA table_info(entries)").toArray().map((r) => r.name as string));
    if (!cols.has("retracts")) this.sql.exec("ALTER TABLE entries ADD COLUMN retracts INTEGER");
    if (!cols.has("via")) this.sql.exec("ALTER TABLE entries ADD COLUMN via TEXT");
    if (!cols.has("client")) this.sql.exec("ALTER TABLE entries ADD COLUMN client TEXT");
  }

  // ---- metadata ----

  private meta(key: string): string | null {
    const rows = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows.length ? (rows[0].value as string) : null;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value);
  }

  /** Idempotent: sets id/title/creator the first time only. */
  async init(id: string, title: string, createdBy: string): Promise<BoardInfo> {
    const hit = scanText(title, "board title");
    if (hit) throw new BoardError(blockedMessage(hit));
    if (!this.meta("id")) {
      this.setMeta("id", id);
      this.setMeta("title", title);
      this.setMeta("created_by", createdBy);
      this.setMeta("created_at", String(Date.now()));
      this.touch(createdBy);
    }
    return this.info();
  }

  async exists(): Promise<boolean> {
    return this.meta("id") != null;
  }

  info(): BoardInfo {
    const id = this.meta("id");
    if (!id) throw new BoardError("Board not found.");
    const stats = this.sql.exec("SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS last FROM entries").one();
    return {
      id,
      title: this.meta("title") ?? id,
      created_by: this.meta("created_by") ?? "",
      created_at: Number(this.meta("created_at") ?? 0),
      entry_count: stats.n as number,
      last_seq: stats.last as number,
      archived: this.meta("archived") === "1",
    };
  }

  members(): Member[] {
    return this.sql
      .exec("SELECT name, cursor, joined_at, last_seen FROM members ORDER BY joined_at")
      .toArray() as unknown as Member[];
  }

  /** Registers the user as a member (first time) and updates last_seen. Returns their cursor. */
  private touch(user: string): number {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO members (name, cursor, joined_at, last_seen) VALUES (?, 0, ?, ?)
       ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen`,
      user,
      now,
      now,
    );
    return this.sql.exec("SELECT cursor FROM members WHERE name = ?", user).one().cursor as number;
  }

  private setCursor(user: string, seq: number) {
    this.sql.exec("UPDATE members SET cursor = MAX(cursor, ?) WHERE name = ?", seq, user);
  }

  async join(user: string): Promise<BoardInfo> {
    this.info();
    this.touch(user);
    return this.info();
  }

  // ---- writes ----

  /**
   * Agent posts go through here: stale-read rejection. If other members posted since this agent last read,
   * nothing is posted; the agent gets what it missed (now marked read) and decides whether to post again.
   * The object handles one request at a time, so two simultaneous posts are ordered and the second is bounced.
   */
  async postFresh(user: string, input: NewEntry): Promise<{ entry: Entry } | { missed: Entry[]; remaining: number }> {
    this.info();
    const cursor = this.touch(user);
    const unread = this.countAfter(cursor, user);
    if (unread > 0) {
      const missed = this.entriesAfter(cursor, user, 20);
      this.setCursor(user, missed[missed.length - 1].seq);
      return { missed, remaining: unread - missed.length };
    }
    return { entry: await this.post(user, input) };
  }

  async post(user: string, input: NewEntry): Promise<Entry> {
    const info = this.info();
    if (info.archived) throw new BoardError(`"${info.title}" is archived, so it's read-only. Its creator can restore it.`);
    this.touch(user);

    if (!ENTRY_TYPES.includes(input.type)) {
      throw new BoardError(`type must be one of: ${ENTRY_TYPES.join(", ")}`);
    }
    const text = (input.text ?? "").trim();
    if (!text) throw new BoardError("text is required.");
    if (text.length > MAX_TEXT) throw new BoardError(`text is too long (max ${MAX_TEXT} characters); post the long part as an artifact.`);

    // Egress filter: nothing that looks like a credential is ever stored.
    const hit = scanFields({ text, artifact_name: input.artifact_name, artifact_content: input.artifact_content });
    if (hit) throw new BoardError(blockedMessage(hit));

    const refs = [input.reply_to, input.supersedes, input.retracts, ...(input.resolves ?? [])].filter((n): n is number => n != null);
    for (const n of refs) {
      if (!Number.isInteger(n) || n < 1 || n > info.last_seq) throw new BoardError(`Entry #${n} does not exist on this board.`);
    }
    if (input.retracts != null) {
      // Only the entry's author, or the board's creator, may withdraw it; once is enough.
      const target = this.sql.exec("SELECT author, retracts FROM entries WHERE seq = ?", input.retracts).one();
      if (target.author !== user && info.created_by !== user) {
        throw new BoardError(`Only ${target.author} (who posted #${input.retracts}) or the board's creator can retract it.`);
      }
      if (target.retracts != null) throw new BoardError(`#${input.retracts} is itself a retraction; it can't be retracted.`);
      if (this.sql.exec("SELECT 1 AS x FROM entries WHERE retracts = ?", input.retracts).toArray().length) {
        throw new BoardError(`#${input.retracts} is already retracted.`);
      }
    }

    let artifactName: string | null = null;
    let artifactContent: string | null = null;
    if (input.type === "artifact") {
      artifactName = (input.artifact_name ?? "").trim() || null;
      artifactContent = input.artifact_content ?? null;
      if (!artifactName || artifactContent == null) {
        throw new BoardError("artifact entries need artifact_name and artifact_content.");
      }
      if (artifactContent.length > MAX_ARTIFACT) throw new BoardError(`artifact_content is too large (max ${MAX_ARTIFACT} characters).`);
    }

    const row = this.sql
      .exec(
        `INSERT INTO entries (ts, author, type, text, to_user, reply_to, resolves, supersedes, retracts, via, client, artifact_name, artifact_size, artifact_content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${ENTRY_COLS}`,
        Date.now(),
        user,
        input.type,
        text,
        input.to ?? null,
        input.reply_to ?? null,
        JSON.stringify([...new Set(input.resolves ?? [])]),
        input.supersedes ?? null,
        input.retracts ?? null,
        input.via ?? null,
        input.via === "agent" ? (input.client ?? "agent").slice(0, 40) : null,
        artifactName,
        artifactContent == null ? null : new TextEncoder().encode(artifactContent).length,
        artifactContent,
      )
      .one();
    const entry = toEntry(row);

    // Your own post counts as read.
    this.setCursor(user, entry.seq);

    for (const w of this.waiters) if (w.user !== user) w.wake();
    for (const wake of this.watchers) wake();
    // Who posted what to whom (no text): enough for tabs to refresh and for a member's CLI to decide whether to wake its agent.
    this.broadcast({ type: "entry", seq: entry.seq, retracts: entry.retracts, author: entry.author, kind: entry.type, to: entry.to, reply_to: entry.reply_to, board: info.id, title: info.title });
    return entry;
  }

  // ---- reads ----

  private entriesAfter(seq: number, excludeAuthor: string | null, limit: number): Entry[] {
    const rows = excludeAuthor
      ? this.sql.exec(`SELECT ${ENTRY_COLS} FROM entries WHERE seq > ? AND author != ? ORDER BY seq LIMIT ?`, seq, excludeAuthor, limit)
      : this.sql.exec(`SELECT ${ENTRY_COLS} FROM entries WHERE seq > ? ORDER BY seq LIMIT ?`, seq, limit);
    return rows.toArray().map(toEntry);
  }

  private countAfter(seq: number, excludeAuthor: string): number {
    return this.sql.exec("SELECT COUNT(*) AS n FROM entries WHERE seq > ? AND author != ?", seq, excludeAuthor).one().n as number;
  }

  allEntries(): Entry[] {
    return this.sql.exec(`SELECT ${ENTRY_COLS} FROM entries ORDER BY seq`).toArray().map(toEntry);
  }

  summary(): Summary {
    return computeSummary(this.allEntries());
  }

  /**
   * Returns the summary plus entries from other members that this user has not read yet (oldest first),
   * and advances the user's cursor past what was returned.
   */
  async read(user: string, opts: { limit?: number; since?: number } = {}) {
    const info = this.info();
    const cursor = this.touch(user);
    const from = opts.since != null ? Math.max(0, opts.since) : cursor;
    const limit = clamp(opts.limit ?? 50, 1, 200);
    const fresh = this.entriesAfter(from, opts.since != null ? null : user, limit);
    const remaining = opts.since != null ? 0 : Math.max(0, this.countAfter(from, user) - fresh.length);
    if (fresh.length) this.setCursor(user, fresh[fresh.length - 1].seq);
    else if (opts.since == null) this.setCursor(user, info.last_seq);
    const members = this.members();
    return {
      info,
      members,
      summaryText: formatSummary(info, members, this.summary(), user, DEFAULT_SUMMARY_CHARS),
      entries: fresh,
      remaining,
    };
  }

  /**
   * Long-poll: resolves as soon as another member posts something this user has not read,
   * or after `timeoutMs` with no entries. Advances the cursor past what it returns.
   */
  async wait(user: string, timeoutMs: number) {
    this.info();
    const timeout = clamp(timeoutMs, 0, MAX_WAIT_MS);
    const cursor = this.touch(user);
    if (this.countAfter(cursor, user) === 0 && timeout > 0) {
      await new Promise<void>((resolve) => {
        const w: Waiter = {
          user,
          wake: () => {
            clearTimeout(timer);
            this.waiters.delete(w);
            resolve();
          },
        };
        const timer = setTimeout(w.wake, timeout);
        this.waiters.add(w);
      });
    }
    // Removed from the board while waiting: return nothing, and don't re-add them.
    const row = this.sql.exec("SELECT cursor FROM members WHERE name = ?", user).toArray();
    if (!row.length) return { info: this.info(), entries: [] as Entry[], timedOut: true };
    const fresh = this.entriesAfter(row[0].cursor as number, user, 50);
    if (fresh.length) this.setCursor(user, fresh[fresh.length - 1].seq);
    this.touch(user);
    return { info: this.info(), entries: fresh, timedOut: fresh.length === 0 };
  }

  /** Drops a member's cursor and ends any wait they have in progress. Access itself is enforced by the Worker. */
  async removeMember(user: string): Promise<void> {
    this.sql.exec("DELETE FROM members WHERE name = ?", user);
    for (const w of this.waiters) if (w.user === user) w.wake();
    // Say so explicitly before closing: a close frame alone isn't reliably delivered to the page.
    for (const ws of this.ctx.getWebSockets(user)) {
      try {
        ws.send(JSON.stringify({ type: "removed" }));
        ws.close(4003, "removed from board");
      } catch {}
    }
  }

  async get(seq: number): Promise<{ entry: Entry; artifact_content: string | null; replies: Entry[] }> {
    this.info();
    const rows = this.sql.exec(`SELECT ${ENTRY_COLS}, artifact_content FROM entries WHERE seq = ?`, seq).toArray();
    if (!rows.length) throw new BoardError(`Entry #${seq} does not exist on this board.`);
    const replies = this.sql
      .exec(`SELECT ${ENTRY_COLS} FROM entries WHERE reply_to = ? OR supersedes = ? OR retracts = ? OR resolves LIKE ? ORDER BY seq`, seq, seq, seq, `%${seq}%`)
      .toArray()
      .map(toEntry)
      .filter((e) => e.reply_to === seq || e.supersedes === seq || e.retracts === seq || e.resolves.includes(seq));
    return { entry: toEntry(rows[0]), artifact_content: (rows[0].artifact_content as string | null) ?? null, replies };
  }

  /** Case-insensitive substring search over text and artifact names/content, with optional filters. */
  async search(query: string, opts: { author?: string; type?: string; limit?: number } = {}): Promise<Entry[]> {
    this.info();
    const q = `%${query.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    const clauses = ["(text LIKE ?1 ESCAPE '\\' OR artifact_name LIKE ?1 ESCAPE '\\' OR artifact_content LIKE ?1 ESCAPE '\\')"];
    const args: SqlStorageValue[] = [q];
    if (opts.author) {
      args.push(opts.author);
      clauses.push(`author = ?${args.length}`);
    }
    if (opts.type) {
      args.push(opts.type);
      clauses.push(`type = ?${args.length}`);
    }
    args.push(clamp(opts.limit ?? 20, 1, 100));
    return this.sql
      .exec(`SELECT ${ENTRY_COLS} FROM entries WHERE ${clauses.join(" AND ")} ORDER BY seq DESC LIMIT ?${args.length}`, ...args)
      .toArray()
      .map(toEntry);
  }

  /** Long-poll for the web UI: resolves when an entry newer than `afterSeq` exists, or after `timeoutMs`. */
  async waitForAny(afterSeq: number, timeoutMs: number): Promise<number> {
    if (this.info().last_seq > afterSeq) return this.info().last_seq;
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.watchers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, clamp(timeoutMs, 0, MAX_WAIT_MS));
      this.watchers.add(wake);
    });
    return this.info().last_seq;
  }

  /** For each seq, the top of its reply chain (so the web UI can nest a reply under its thread). */
  async rootsFor(seqs: number[]): Promise<Record<number, number>> {
    const out: Record<number, number> = {};
    for (const seq of seqs.slice(0, 1000)) {
      let cur = seq;
      for (let hops = 0; hops < 50; hops++) {
        const r = this.sql.exec("SELECT reply_to FROM entries WHERE seq = ?", cur).toArray();
        const parent = r.length ? (r[0].reply_to as number | null) : null;
        if (parent == null) break;
        cur = parent;
      }
      out[seq] = cur;
    }
    return out;
  }

  /** New title (checked for secrets); open tabs update live. Access is checked by the Worker. */
  async rename(title: string): Promise<BoardInfo> {
    const t = title.trim().slice(0, 120);
    if (!t) throw new BoardError("Give the board a name.");
    const hit = scanText(t, "board title");
    if (hit) throw new BoardError(blockedMessage(hit));
    this.setMeta("title", t);
    this.broadcast({ type: "renamed", title: t });
    return this.info();
  }

  /** Archive (read-only) or restore. Access is checked by the Worker. */
  async setArchived(on: boolean): Promise<BoardInfo> {
    this.setMeta("archived", on ? "1" : "0");
    for (const w of this.waiters) w.wake();
    this.broadcast({ type: "archived", archived: on });
    return this.info();
  }

  /** Permanently erases this board: tells open tabs, ends waits, and deletes all storage. Access is checked by the Worker. */
  async destroy(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ type: "deleted" }));
        ws.close(4004, "board deleted");
      } catch {}
    }
    for (const w of this.waiters) w.wake();
    for (const wake of this.watchers) wake();
    await this.ctx.storage.deleteAll();
  }

  /** Operator audit: entries that would be blocked by today's filter (seq and rule only, never the value). */
  async scanSecrets(): Promise<{ seq: number; hit: SecretHit }[]> {
    const out: { seq: number; hit: SecretHit }[] = [];
    for (const r of this.sql.exec("SELECT seq, text, artifact_name, artifact_content FROM entries ORDER BY seq").toArray()) {
      const hit = scanFields({ text: r.text as string, artifact_name: r.artifact_name as string | null, artifact_content: r.artifact_content as string | null });
      if (hit) out.push({ seq: r.seq as number, hit });
    }
    const t = scanText(this.meta("title") ?? "", "board title");
    if (t) out.push({ seq: 0, hit: t });
    return out;
  }

  /** Read-only view for the web UI; never moves anyone's cursor. */
  async snapshot(afterSeq = 0) {
    const info = this.info();
    return {
      info,
      members: this.members(),
      summary: this.summary(),
      entries: this.entriesAfter(afterSeq, null, 1000),
    };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(Number.isFinite(n) ? n : lo)));
}
