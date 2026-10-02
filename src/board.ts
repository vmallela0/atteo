// One Durable Object per board. A single writer gives each board a strict sequence order;
// its embedded SQLite holds the entry log, members and their read cursors.

import { DurableObject } from "cloudflare:workers";
import { computeSummary, formatSummary, DEFAULT_SUMMARY_CHARS, type Summary } from "./state";
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
    artifact_name: (r.artifact_name as string | null) ?? null,
    artifact_size: (r.artifact_size as number | null) ?? null,
  };
}

const ENTRY_COLS = "seq, ts, author, type, text, to_user, reply_to, resolves, supersedes, artifact_name, artifact_size";

export class Board extends DurableObject<Env> {
  private sql: SqlStorage;
  private waiters = new Set<Waiter>();

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

  async post(user: string, input: NewEntry): Promise<Entry> {
    const info = this.info();
    this.touch(user);

    if (!ENTRY_TYPES.includes(input.type)) {
      throw new BoardError(`type must be one of: ${ENTRY_TYPES.join(", ")}`);
    }
    const text = (input.text ?? "").trim();
    if (!text) throw new BoardError("text is required.");
    if (text.length > MAX_TEXT) throw new BoardError(`text is too long (max ${MAX_TEXT} characters); post the long part as an artifact.`);

    const refs = [input.reply_to, input.supersedes, ...(input.resolves ?? [])].filter((n): n is number => n != null);
    for (const n of refs) {
      if (!Number.isInteger(n) || n < 1 || n > info.last_seq) throw new BoardError(`Entry #${n} does not exist on this board.`);
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
        `INSERT INTO entries (ts, author, type, text, to_user, reply_to, resolves, supersedes, artifact_name, artifact_size, artifact_content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${ENTRY_COLS}`,
        Date.now(),
        user,
        input.type,
        text,
        input.to ?? null,
        input.reply_to ?? null,
        JSON.stringify([...new Set(input.resolves ?? [])]),
        input.supersedes ?? null,
        artifactName,
        artifactContent == null ? null : new TextEncoder().encode(artifactContent).length,
        artifactContent,
      )
      .one();
    const entry = toEntry(row);

    // Your own post counts as read.
    this.setCursor(user, entry.seq);

    for (const w of this.waiters) if (w.user !== user) w.wake();
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
    const now = this.sql.exec("SELECT cursor FROM members WHERE name = ?", user).one().cursor as number;
    const fresh = this.entriesAfter(now, user, 50);
    if (fresh.length) this.setCursor(user, fresh[fresh.length - 1].seq);
    this.touch(user);
    return { info: this.info(), entries: fresh, timedOut: fresh.length === 0 };
  }

  async get(seq: number): Promise<{ entry: Entry; artifact_content: string | null; replies: Entry[] }> {
    this.info();
    const rows = this.sql.exec(`SELECT ${ENTRY_COLS}, artifact_content FROM entries WHERE seq = ?`, seq).toArray();
    if (!rows.length) throw new BoardError(`Entry #${seq} does not exist on this board.`);
    const replies = this.sql
      .exec(`SELECT ${ENTRY_COLS} FROM entries WHERE reply_to = ? OR supersedes = ? OR resolves LIKE ? ORDER BY seq`, seq, seq, `%${seq}%`)
      .toArray()
      .map(toEntry)
      .filter((e) => e.reply_to === seq || e.supersedes === seq || e.resolves.includes(seq));
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
