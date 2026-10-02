// One Durable Object per board. A single writer gives each board a strict sequence order;
// its embedded SQLite holds the entry log, members and their read cursors.

import { DurableObject } from "cloudflare:workers";
import { computeSummary, formatSummary, DEFAULT_SUMMARY_CHARS, type Summary } from "./state";
import { blockedMessage, scanFields, scanText, type SecretHit } from "./secrets";
import { keep, MAX_MENTIONS, mentionsOwnAgent, type Mention } from "./mentions";
import { ENTRY_TYPES, type BoardInfo, type Entry, type Env, type Member, type NewEntry } from "./types";
import { EMOJI_RE, ftsQuery, USER_RE } from "./util";
import { cardText, parseCard, type ChangeCard } from "./card";

export const MAX_TEXT = 32_000;
export const MAX_ARTIFACT = 256_000;
export const MAX_WAIT_MS = 55_000;

export class BoardError extends Error {}

export const POSTS_PER_MINUTE = 60;
export const REVIEW_VERDICTS = ["approve", "request_changes", "comment"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const TASK_STATUSES = ["todo", "doing", "blocked", "done", "stopped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export interface TaskView {
  seq: number;
  text: string;
  author: string;
  via: string | null;
  status: TaskStatus;
  assignee: string | null;
  assignee_agent: boolean;
  due: number | null;
  lease_holder: string | null;
  lease_agent: boolean;
  lease_until: number | null;
  stop_reason: string | null;
  reply_to: number | null;
  updated_at: number;
}
export interface TaskChange {
  status?: TaskStatus;
  assignee?: string | null;
  assignee_agent?: boolean;
  due?: number | null;
  note?: string | null;
}
export interface TaskActOpts {
  via?: "agent" | "person" | null;
  client?: string | null;
}
const iso = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace("T", " ") + "Z";

export interface DocMeta {
  name: string;
  version: number;
  updated_by: string;
  updated_at: number;
  via: string | null;
  client: string | null;
  size: number;
}
export interface Doc {
  name: string;
  version: number;
  latest: number;
  content: string;
  updated_by: string;
  updated_at: number;
  via: string | null;
  client: string | null;
}
export interface DocVersion {
  version: number;
  author: string;
  ts: number;
  via: string | null;
  client: string | null;
  summary: string | null;
  size: number;
}
export interface DocEditOpts {
  via?: "agent" | "person" | null;
  client?: string | null;
  summary?: string | null;
}
export type DocResult = { conflict: false; version: number; note: number } | { conflict: true; current: number; content: string };

export const MAX_REACTIONS_PER_PERSON = 12; // distinct emoji one person can leave on one entry
export type Reactions = { emoji: string; users: string[] }[];

export const DOC_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._\-/]{0,79}$/;
/** Any artifact name becomes a valid document name, so every file posted on a board is also a versioned doc. */
export function cleanFileName(raw: string): string {
  const n = raw
    .trim()
    .replace(/[^A-Za-z0-9 ._\-/]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 80)
    .trim();
  return n || "file";
}
function validateDocName(name: string) {
  if (!DOC_NAME_RE.test(name) || name.includes("..") || name.includes("//")) {
    throw new BoardError("Document names are 1–80 letters, numbers, spaces, dots, dashes, underscores or slashes, e.g. BACKLOG.md or notes/plan.md.");
  }
}

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
    mentions: JSON.parse((r.mentions as string | null) || "[]"),
    reply_to: (r.reply_to as number | null) ?? null,
    resolves: JSON.parse((r.resolves as string) || "[]"),
    supersedes: (r.supersedes as number | null) ?? null,
    retracts: (r.retracts as number | null) ?? null,
    via: ((r.via as string | null) ?? null) as Entry["via"],
    client: (r.client as string | null) ?? null,
    artifact_name: (r.artifact_name as string | null) ?? null,
    artifact_size: (r.artifact_size as number | null) ?? null,
    artifact_version: (r.artifact_version as number | null) ?? null,
    card: r.card ? (JSON.parse(r.card as string) as ChangeCard) : null,
  };
}

const ENTRY_COLS = "seq, ts, author, type, text, to_user, mentions, reply_to, resolves, supersedes, retracts, via, client, artifact_name, artifact_size, artifact_version, card";

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
        mentions TEXT,
        self_agent INTEGER NOT NULL DEFAULT 0,
        reply_to INTEGER,
        resolves TEXT NOT NULL DEFAULT '[]',
        supersedes INTEGER,
        retracts INTEGER,
        via TEXT,
        client TEXT,
        artifact_name TEXT,
        artifact_size INTEGER,
        artifact_version INTEGER,
        artifact_content TEXT,
        card TEXT,
        card_diff TEXT
      );
      CREATE TABLE IF NOT EXISTS reactions (
        seq INTEGER NOT NULL,
        user TEXT NOT NULL,
        emoji TEXT NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (seq, user, emoji)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS search_idx USING fts5(body, name, kind UNINDEXED, ref UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS reviews (
        seq INTEGER NOT NULL,
        reviewer TEXT NOT NULL,
        verdict TEXT NOT NULL,
        via TEXT,
        note_seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        PRIMARY KEY (seq, reviewer)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        seq INTEGER PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'todo',
        assignee TEXT,
        assignee_agent INTEGER NOT NULL DEFAULT 1,
        due INTEGER,
        lease_holder TEXT,
        lease_agent INTEGER,
        lease_until INTEGER,
        stop_reason TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS docs (
        name TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        via TEXT,
        client TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS doc_versions (
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        author TEXT NOT NULL,
        ts INTEGER NOT NULL,
        via TEXT,
        client TEXT,
        summary TEXT,
        PRIMARY KEY (name, version)
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
    if (!cols.has("mentions")) this.sql.exec("ALTER TABLE entries ADD COLUMN mentions TEXT");
    if (!cols.has("self_agent")) this.sql.exec("ALTER TABLE entries ADD COLUMN self_agent INTEGER NOT NULL DEFAULT 0");
    if (!cols.has("artifact_version")) this.sql.exec("ALTER TABLE entries ADD COLUMN artifact_version INTEGER");
    if (!cols.has("card")) this.sql.exec("ALTER TABLE entries ADD COLUMN card TEXT");
    if (!cols.has("card_diff")) this.sql.exec("ALTER TABLE entries ADD COLUMN card_diff TEXT");
    // Files posted before files became documents: each becomes the next version of the doc with its (cleaned) name.
    if (this.meta("files_backfilled") !== "1") {
      for (const r of this.sql.exec("SELECT seq, ts, author, via, client, text, artifact_name, artifact_content FROM entries WHERE type = 'artifact' AND artifact_version IS NULL AND artifact_content IS NOT NULL ORDER BY seq").toArray()) {
        const name = cleanFileName(r.artifact_name as string);
        const v = this.storeVersion(r.author as string, name, r.artifact_content as string, { via: r.via as "agent" | "person" | null, client: r.client as string | null, summary: r.text as string }, r.ts as number);
        this.sql.exec("UPDATE entries SET artifact_name = ?, artifact_version = ? WHERE seq = ?", name, v, r.seq);
      }
      this.setMeta("files_backfilled", "1");
    }
    // Full-text index: every entry, plus the latest version of every file/doc.
    if (this.meta("fts_built") !== "1") {
      this.sql.exec("DELETE FROM search_idx");
      const rows = this.sql
        .exec(
          `SELECT e.seq, e.text, e.artifact_name, e.card, COALESCE(e.artifact_content, v.content) AS content
           FROM entries e LEFT JOIN doc_versions v ON v.name = e.artifact_name AND v.version = e.artifact_version`,
        )
        .toArray();
      for (const r of rows) {
        this.indexEntry(r.seq as number, r.text as string, r.artifact_name as string | null, r.card ? (JSON.parse(r.card as string) as ChangeCard) : null, (r.content as string | null) ?? null);
      }
      for (const d of this.sql.exec("SELECT name, content FROM docs").toArray()) this.indexDoc(d.name as string, d.content as string);
      this.setMeta("fts_built", "1");
    }
    // Tasks posted before the tasks table existed: give them a row once (done if something resolved them).
    if (this.meta("tasks_backfilled") !== "1") {
      this.sql.exec(
        `INSERT OR IGNORE INTO tasks (seq, status, assignee, assignee_agent, updated_at)
         SELECT t.seq,
                CASE WHEN EXISTS (SELECT 1 FROM entries r, json_each(r.resolves) j WHERE j.value = t.seq) THEN 'done' ELSE 'todo' END,
                t.to_user, 1, t.ts
         FROM entries t WHERE t.type = 'task'`,
      );
      this.setMeta("tasks_backfilled", "1");
    }
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

  async post(user: string, input: NewEntry, internal: { docVersion?: number } = {}): Promise<Entry> {
    const info = this.info();
    if (info.archived) throw new BoardError(`"${info.title}" is archived, so it's read-only. Its creator can restore it.`);
    this.rateLimit(user);
    this.touch(user);

    if (!ENTRY_TYPES.includes(input.type)) {
      throw new BoardError(`type must be one of: ${ENTRY_TYPES.join(", ")}`);
    }
    const text = (input.text ?? "").trim();
    if (!text) throw new BoardError("text is required.");
    if (text.length > MAX_TEXT) throw new BoardError(`text is too long (max ${MAX_TEXT} characters); post the long part as an artifact.`);

    // Egress filter: nothing that looks like a credential is ever stored.
    // (A document save already checked its content; the log entry for it carries the same content.)
    const hit = scanFields({ text, artifact_name: input.artifact_name, artifact_content: internal.docVersion != null ? null : input.artifact_content });
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
    let artifactVersion: number | null = null;
    if (input.type === "artifact") {
      artifactName = (input.artifact_name ?? "").trim() || null;
      artifactContent = input.artifact_content ?? null;
      if (!artifactName || artifactContent == null) {
        throw new BoardError("artifact entries need artifact_name and artifact_content.");
      }
      if (artifactContent.length > MAX_ARTIFACT) throw new BoardError(`artifact_content is too large (max ${MAX_ARTIFACT} characters).`);
      // A file is a document: posting one publishes its next version (no base version needed). Content lives in doc_versions.
      artifactName = cleanFileName(artifactName);
      artifactVersion =
        internal.docVersion ??
        this.storeVersion(user, artifactName, artifactContent, { via: input.via, client: input.client, summary: text });
    }

    let card: ChangeCard | null = null;
    let cardDiff: string | null = null;
    if (input.type === "change") {
      try {
        ({ card, diff: cardDiff } = parseCard(input.card));
      } catch (e) {
        throw new BoardError(e instanceof Error ? e.message : String(e));
      }
      const hit = scanFields({ card: cardText(card), diff: cardDiff });
      if (hit) throw new BoardError(blockedMessage(hit));
    }

    // Resolved against the board's members by the Worker; stored as given, minus anything malformed or meaningless.
    const mentions: Mention[] = [];
    for (const m of input.mentions ?? []) {
      if (typeof m?.user !== "string" || !USER_RE.test(m.user)) continue;
      const clean = { user: m.user, agent: m.agent === true };
      if (keep(clean, user, input.via) && !mentions.some((x) => x.user === clean.user && x.agent === clean.agent)) mentions.push(clean);
      if (mentions.length >= MAX_MENTIONS) break;
    }

    const row = this.sql
      .exec(
        `INSERT INTO entries (ts, author, type, text, to_user, mentions, self_agent, reply_to, resolves, supersedes, retracts, via, client, artifact_name, artifact_size, artifact_version, artifact_content, card, card_diff)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${ENTRY_COLS}`,
        Date.now(),
        user,
        input.type,
        text,
        input.to ?? null,
        mentions.length ? JSON.stringify(mentions) : null,
        mentionsOwnAgent({ author: user, mentions }) ? 1 : 0,
        input.reply_to ?? null,
        JSON.stringify([...new Set(input.resolves ?? [])]),
        input.supersedes ?? null,
        input.retracts ?? null,
        input.via ?? null,
        input.via === "agent" ? (input.client ?? "agent").slice(0, 40) : null,
        artifactName,
        artifactContent == null ? null : new TextEncoder().encode(artifactContent).length,
        artifactVersion,
        null,
        card ? JSON.stringify(card) : null,
        cardDiff,
      )
      .one();
    if (artifactVersion != null) this.broadcast({ type: "doc", name: artifactName, version: artifactVersion, by: user });
    const entry = toEntry(row);
    this.indexEntry(entry.seq, entry.text, entry.artifact_name, entry.card ?? null, artifactContent);
    if (entry.type === "task") {
      this.sql.exec("INSERT OR IGNORE INTO tasks (seq, status, assignee, assignee_agent, updated_at) VALUES (?, 'todo', ?, 1, ?)", entry.seq, entry.to, entry.ts);
    }
    if (entry.retracts != null) this.stopDependents(user, entry.retracts);

    // Your own post counts as read, unless you're handing it to your own agent: then it's new for your agent.
    // A later post doesn't skip the agent past a hand-off it hasn't read yet.
    const forOwnAgent = mentionsOwnAgent(entry);
    if (!forOwnAgent) {
      const pending = this.sql
        .exec("SELECT MIN(e.seq) AS s FROM entries e, members m WHERE m.name = ? AND e.seq > m.cursor AND e.author = ? AND e.self_agent = 1", user, user)
        .one().s as number | null;
      this.setCursor(user, pending != null ? pending - 1 : entry.seq);
    }

    for (const w of this.waiters) if (w.user !== user || forOwnAgent) w.wake();
    for (const wake of this.watchers) wake();
    // Who posted what to whom (no text): enough for tabs to refresh and for a member's CLI to decide whether to wake its agent.
    this.broadcast({ type: "entry", seq: entry.seq, retracts: entry.retracts, author: entry.author, via: entry.via ?? null, kind: entry.type, to: entry.to, mentions: entry.mentions, reply_to: entry.reply_to, board: info.id, title: info.title });
    return entry;
  }

  // ---- reads ----

  // "From others" for an agent: other members' entries, plus its own person's posts that mention it ("@me's agent").
  private entriesAfter(seq: number, excludeAuthor: string | null, limit: number): Entry[] {
    const rows = excludeAuthor
      ? this.sql.exec(`SELECT ${ENTRY_COLS} FROM entries WHERE seq > ? AND (author != ? OR self_agent = 1) ORDER BY seq LIMIT ?`, seq, excludeAuthor, limit)
      : this.sql.exec(`SELECT ${ENTRY_COLS} FROM entries WHERE seq > ? ORDER BY seq LIMIT ?`, seq, limit);
    return rows.toArray().map(toEntry);
  }

  private countAfter(seq: number, excludeAuthor: string): number {
    return this.sql.exec("SELECT COUNT(*) AS n FROM entries WHERE seq > ? AND (author != ? OR self_agent = 1)", seq, excludeAuthor).one().n as number;
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
      summaryText: formatSummary(info, members, this.summary(), user, DEFAULT_SUMMARY_CHARS, this.taskTags(), this.reviewers()),
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
    this.sql.exec("UPDATE tasks SET lease_holder = NULL, lease_until = NULL, status = CASE WHEN status = 'doing' THEN 'todo' ELSE status END WHERE lease_holder = ?", user);
    for (const w of this.waiters) if (w.user === user) w.wake();
    // Say so explicitly before closing: a close frame alone isn't reliably delivered to the page.
    for (const ws of this.ctx.getWebSockets(user)) {
      try {
        ws.send(JSON.stringify({ type: "removed" }));
        ws.close(4003, "removed from board");
      } catch {}
    }
  }

  async get(seq: number): Promise<{ entry: Entry; artifact_content: string | null; diff: string | null; replies: Entry[]; reactions: Reactions }> {
    this.info();
    const rows = this.sql.exec(`SELECT ${ENTRY_COLS}, artifact_content, card_diff FROM entries WHERE seq = ?`, seq).toArray();
    if (!rows.length) throw new BoardError(`Entry #${seq} does not exist on this board.`);
    const replies = this.sql
      .exec(`SELECT ${ENTRY_COLS} FROM entries WHERE reply_to = ? OR supersedes = ? OR retracts = ? OR resolves LIKE ? ORDER BY seq`, seq, seq, seq, `%${seq}%`)
      .toArray()
      .map(toEntry)
      .filter((e) => e.reply_to === seq || e.supersedes === seq || e.retracts === seq || e.resolves.includes(seq));
    const entry = toEntry(rows[0]);
    let content = (rows[0].artifact_content as string | null) ?? null;
    if (content == null && entry.artifact_name && entry.artifact_version != null) {
      const v = this.sql.exec("SELECT content FROM doc_versions WHERE name = ? AND version = ?", entry.artifact_name, entry.artifact_version).toArray()[0];
      content = v ? (v.content as string) : `(v${entry.artifact_version} of ${entry.artifact_name} is no longer kept; read the latest with the doc tool.)`;
    }
    return { entry, artifact_content: content, diff: (rows[0].card_diff as string | null) ?? null, replies, reactions: this.reactionsFor([seq])[seq] ?? [] };
  }

  // ---- search: ranked full text (FTS5, bm25) over entries and the latest version of every file; grep over files ----

  /** An entry's text, plus the file version it published or its change card, so older versions stay findable. */
  private indexEntry(seq: number, text: string, artifactName: string | null, card: ChangeCard | null, fileContent: string | null = null) {
    const body = [text, card ? cardText(card) : null, fileContent].filter(Boolean).join("\n");
    this.sql.exec("INSERT INTO search_idx (body, name, kind, ref) VALUES (?, ?, 'entry', ?)", body, artifactName ?? "", String(seq));
  }

  private indexDoc(name: string, content: string) {
    this.sql.exec("DELETE FROM search_idx WHERE kind = 'doc' AND ref = ?", name);
    this.sql.exec("INSERT INTO search_idx (body, name, kind, ref) VALUES (?, ?, 'doc', ?)", content, name, name);
  }

  /**
   * Best matches first. Every word must appear (the last one as a prefix, so "deplo" finds "deploy"); "quoted phrases"
   * match exactly. Returns entries (with a snippet) and files (latest version, with a snippet).
   */
  async rankedSearch(
    query: string,
    opts: { author?: string; type?: string; limit?: number } = {},
  ): Promise<{ entries: { entry: Entry; snippet: string }[]; files: { name: string; version: number; snippet: string }[] }> {
    this.info();
    const match = ftsQuery(query);
    if (!match) return { entries: [], files: [] };
    const limit = clamp(opts.limit ?? 20, 1, 100);
    let rows: Row[];
    try {
      rows = this.sql
        .exec(
          "SELECT kind, ref, snippet(search_idx, 0, '«', '»', ' … ', 16) AS snip FROM search_idx WHERE search_idx MATCH ? ORDER BY bm25(search_idx, 1.0, 4.0) LIMIT 500",
          match,
        )
        .toArray();
    } catch {
      // Anything FTS can't parse falls back to plain substring search.
      return { entries: (await this.search(query, opts)).map((entry) => ({ entry, snippet: "" })), files: [] };
    }
    const seqs = rows.filter((r) => r.kind === "entry").map((r) => Number(r.ref));
    const bySeq = new Map<number, Entry>();
    if (seqs.length) {
      for (const r of this.sql.exec(`SELECT ${ENTRY_COLS} FROM entries WHERE seq IN (${seqs.map(() => "?").join(",")})`, ...seqs).toArray()) bySeq.set(r.seq as number, toEntry(r));
    }
    const entries: { entry: Entry; snippet: string }[] = [];
    const files: { name: string; version: number; snippet: string }[] = [];
    const filtered = !!(opts.author || opts.type);
    for (const r of rows) {
      if (r.kind === "entry") {
        const e = bySeq.get(Number(r.ref));
        if (!e || (opts.author && e.author !== opts.author) || (opts.type && e.type !== opts.type)) continue;
        if (entries.length < limit) entries.push({ entry: e, snippet: r.snip as string });
      } else if (!filtered && files.length < 10) {
        const v = this.sql.exec("SELECT version FROM docs WHERE name = ?", r.ref).toArray()[0];
        if (v) files.push({ name: r.ref as string, version: v.version as number, snippet: r.snip as string });
      }
    }
    return { entries, files };
  }

  /** Lines in files (latest versions) containing `pattern` (case-insensitive text, or a simple regex), like grep -n. */
  async grep(pattern: string, opts: { name?: string; regex?: boolean; limit?: number } = {}): Promise<{ name: string; version: number; line: number; text: string }[]> {
    this.info();
    const p = pattern.trim();
    if (!p || p.length > 200) throw new BoardError("Give a pattern of 1–200 characters.");
    let test: (line: string) => boolean;
    if (opts.regex) {
      // Nested quantifiers like (a+)+ can take forever on a crafted line; refuse them.
      if (/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(p)) throw new BoardError("That regex has nested repetition (like (a+)+); simplify it.");
      let re: RegExp;
      try {
        re = new RegExp(p, "i");
      } catch (e) {
        throw new BoardError(`Not a valid regex: ${e instanceof Error ? e.message : e}`);
      }
      test = (line) => re.test(line);
    } else {
      const needle = p.toLowerCase();
      test = (line) => line.toLowerCase().includes(needle);
    }
    const limit = clamp(opts.limit ?? 100, 1, 500);
    const out: { name: string; version: number; line: number; text: string }[] = [];
    const docs = opts.name
      ? this.sql.exec("SELECT name, version, content FROM docs WHERE name = ?", opts.name).toArray()
      : this.sql.exec("SELECT name, version, content FROM docs ORDER BY name").toArray();
    if (opts.name && !docs.length) throw new BoardError(`There's no file named "${opts.name}" on this board.`);
    for (const d of docs) {
      const lines = (d.content as string).split("\n");
      for (let i = 0; i < lines.length && out.length < limit; i++) {
        const line = lines[i].length > 2000 ? lines[i].slice(0, 2000) : lines[i];
        if (test(line)) out.push({ name: d.name as string, version: d.version as number, line: i + 1, text: line.slice(0, 300) });
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Case-insensitive substring search over text and artifact names/content, with optional filters. */
  async search(query: string, opts: { author?: string; type?: string; limit?: number } = {}): Promise<Entry[]> {
    this.info();
    const q = `%${query.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    const clauses = [
      `(text LIKE ?1 ESCAPE '\\' OR artifact_name LIKE ?1 ESCAPE '\\' OR artifact_content LIKE ?1 ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM doc_versions v WHERE v.name = entries.artifact_name AND v.version = entries.artifact_version AND v.content LIKE ?1 ESCAPE '\\'))`,
    ];
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

  // ---- per-person rate limit (abuse is bounded by budgets, not reputation: PRD) ----

  private rates = new Map<string, { minute: number; n: number }>();
  private rateLimit(user: string) {
    const minute = Math.floor(Date.now() / 60_000);
    const r = this.rates.get(user);
    if (!r || r.minute !== minute) return void this.rates.set(user, { minute, n: 1 });
    const max = Number(this.env.POSTS_PER_MINUTE) || POSTS_PER_MINUTE;
    if (++r.n > max) throw new BoardError(`Slow down: at most ${max} posts a minute per person on a board.`);
  }

  // ---- reactions: toggled per person; don't create entries or wake agents ----

  reactionsFor(seqs?: number[]): Record<number, Reactions> {
    const rows = seqs
      ? seqs.length
        ? this.sql.exec(`SELECT seq, emoji, user FROM reactions WHERE seq IN (${seqs.map(() => "?").join(",")}) ORDER BY ts`, ...seqs).toArray()
        : []
      : this.sql.exec("SELECT seq, emoji, user FROM reactions ORDER BY ts").toArray();
    const out: Record<number, Reactions> = {};
    for (const r of rows) {
      const list = (out[r.seq as number] ??= []);
      const hit = list.find((x) => x.emoji === r.emoji);
      if (hit) hit.users.push(r.user as string);
      else list.push({ emoji: r.emoji as string, users: [r.user as string] });
    }
    return out;
  }

  async reactions(): Promise<Record<number, Reactions>> {
    this.info();
    return this.reactionsFor();
  }

  /** Add your reaction, or remove it if it's already there. Returns the entry's reactions. */
  async react(user: string, seq: number, emoji: string): Promise<{ on: boolean; reactions: Reactions }> {
    const info = this.info();
    if (info.archived) throw new BoardError(`"${info.title}" is archived, so it's read-only. Its creator can restore it.`);
    const e = (emoji ?? "").trim();
    if (!EMOJI_RE.test(e)) throw new BoardError("Give one emoji, like 👍, or a :shortcode:.");
    if (!Number.isInteger(seq) || seq < 1 || seq > info.last_seq) throw new BoardError(`Entry #${seq} does not exist on this board.`);
    const had = this.sql.exec("DELETE FROM reactions WHERE seq = ? AND user = ? AND emoji = ? RETURNING seq", seq, user, e).toArray().length > 0;
    if (!had) {
      this.rateLimit(user);
      const n = this.sql.exec("SELECT COUNT(*) AS n FROM reactions WHERE seq = ? AND user = ?", seq, user).one().n as number;
      if (n >= MAX_REACTIONS_PER_PERSON) throw new BoardError(`At most ${MAX_REACTIONS_PER_PERSON} different reactions per person on one entry.`);
      this.sql.exec("INSERT INTO reactions (seq, user, emoji, ts) VALUES (?, ?, ?, ?)", seq, user, e, Date.now());
    }
    const reactions = this.reactionsFor([seq])[seq] ?? [];
    this.broadcast({ type: "reaction", seq, reactions });
    return { on: !had, reactions };
  }

  // ---- tasks: status, assignee, leases, stop signal ----

  taskRows(filter: { status?: string; assignee?: string } = {}): TaskView[] {
    const now = Date.now();
    const rows = this.sql
      .exec(
        `SELECT t.*, e.text, e.author, e.via, e.ts AS created_at, e.reply_to FROM tasks t JOIN entries e ON e.seq = t.seq
         WHERE NOT EXISTS (SELECT 1 FROM entries r WHERE r.retracts = t.seq) ORDER BY t.seq`,
      )
      .toArray()
      .map((r) => ({
        seq: r.seq as number,
        text: r.text as string,
        author: r.author as string,
        via: (r.via as string | null) ?? null,
        status: r.status as TaskStatus,
        assignee: (r.assignee as string | null) ?? null,
        assignee_agent: r.assignee_agent === 1,
        due: (r.due as number | null) ?? null,
        lease_holder: (r.lease_until as number | null) && (r.lease_until as number) > now ? ((r.lease_holder as string | null) ?? null) : null,
        lease_agent: r.lease_agent === 1,
        lease_until: (r.lease_until as number | null) && (r.lease_until as number) > now ? (r.lease_until as number) : null,
        stop_reason: (r.stop_reason as string | null) ?? null,
        reply_to: (r.reply_to as number | null) ?? null,
        updated_at: r.updated_at as number,
      }));
    return rows.filter((t) => (!filter.status || t.status === filter.status) && (!filter.assignee || t.assignee === filter.assignee));
  }

  async tasks(filter: { status?: string; assignee?: string } = {}): Promise<TaskView[]> {
    this.info();
    return this.taskRows(filter);
  }

  private task(seq: number): TaskView {
    const t = this.taskRows().find((x) => x.seq === seq);
    if (!t) throw new BoardError(`#${seq} isn't an open task on this board (or it was retracted).`);
    return t;
  }

  /** Each reviewer's latest verdict on each change. */
  reviewRows(): { seq: number; reviewer: string; verdict: ReviewVerdict; via: string | null }[] {
    return this.sql.exec("SELECT seq, reviewer, verdict, via FROM reviews ORDER BY ts").toArray() as unknown as { seq: number; reviewer: string; verdict: ReviewVerdict; via: string | null }[];
  }

  reviewsBySeq(): Record<number, { reviewer: string; verdict: ReviewVerdict; via: string | null }[]> {
    const out: Record<number, { reviewer: string; verdict: ReviewVerdict; via: string | null }[]> = {};
    for (const r of this.reviewRows()) (out[r.seq] ??= []).push({ reviewer: r.reviewer, verdict: r.verdict, via: r.via });
    return out;
  }

  /** Who has reviewed each change (for "Reviews for YOU"). */
  reviewers(): Map<number, string[]> {
    const m = new Map<number, string[]>();
    for (const r of this.reviewRows()) m.set(r.seq, [...(m.get(r.seq) ?? []), r.reviewer]);
    return m;
  }

  /**
   * Review a change card: approve, request changes, or comment. Your latest approve/request_changes is your verdict;
   * each review is also a reply in the conversation, addressed to the change's author.
   */
  async review(user: string, seq: number, verdict: ReviewVerdict, note: string, opts: TaskActOpts): Promise<{ entry: Entry; state: string }> {
    this.info();
    if (!REVIEW_VERDICTS.includes(verdict)) throw new BoardError(`verdict must be one of: ${REVIEW_VERDICTS.join(", ")}`);
    const row = this.sql.exec(`SELECT ${ENTRY_COLS} FROM entries WHERE seq = ?`, seq).toArray()[0];
    if (!row || row.type !== "change") throw new BoardError(`#${seq} isn't a change card. Reviews are for entries of type change.`);
    if (this.sql.exec("SELECT 1 AS x FROM entries WHERE retracts = ?", seq).toArray().length) throw new BoardError(`#${seq} was retracted.`);
    const change = toEntry(row);
    if (verdict !== "comment" && change.author === user) throw new BoardError("You can't approve or request changes on your own change; ask someone else to review it.");
    const text = (note ?? "").trim();
    if (verdict !== "approve" && !text) throw new BoardError("Say what to change (note).");
    const head = verdict === "approve" ? `✅ Approved #${seq}` : verdict === "request_changes" ? `✋ Changes requested on #${seq}` : `💬 Review comment on #${seq}`;
    const entry = await this.post(user, { type: "note", reply_to: seq, to: change.author, text: text ? `${head}: ${text}` : `${head}.`, via: opts.via, client: opts.client });
    if (verdict !== "comment") {
      this.sql.exec(
        "INSERT OR REPLACE INTO reviews (seq, reviewer, verdict, via, note_seq, ts) VALUES (?, ?, ?, ?, ?, ?)",
        seq, user, verdict, opts.via ?? null, entry.seq, Date.now(),
      );
    }
    return { entry, state: this.taskTags().get(seq) ?? "no verdicts yet" };
  }

  taskTags(): Map<number, string> {
    const m = new Map<number, string>();
    // Change cards: each reviewer's verdict, e.g. "approved by jxn's agent · changes requested by vedu".
    const byChange = new Map<number, string[]>();
    for (const r of this.reviewRows()) {
      const who = r.via === "agent" ? `${r.reviewer}'s agent` : r.reviewer;
      byChange.set(r.seq, [...(byChange.get(r.seq) ?? []), `${r.verdict === "approve" ? "approved" : "changes requested"} by ${who}`]);
    }
    for (const [seq, bits] of byChange) m.set(seq, bits.join(" · "));
    for (const t of this.taskRows()) {
      const bits: string[] = [t.status];
      if (t.assignee) bits.push(`for ${t.assignee_agent ? `${t.assignee}'s agent` : t.assignee}`);
      if (t.lease_holder) bits.push(`${t.lease_agent ? `${t.lease_holder}'s agent` : t.lease_holder} holds it until ${iso(t.lease_until!)}`);
      if (t.stop_reason) bits.push(t.stop_reason);
      if (t.due) bits.push(`due ${iso(t.due).slice(0, 10)}`);
      m.set(t.seq, bits.join(" · "));
    }
    return m;
  }

  /** Lease a task so no one else takes it. Expires on its own; claim again to renew. */
  async taskClaim(user: string, seq: number, minutes: number, opts: TaskActOpts): Promise<TaskView> {
    const info = this.info();
    const t = this.task(seq);
    if (t.status === "done") throw new BoardError(`#${seq} is already done.`);
    if (t.lease_holder && t.lease_holder !== user) {
      throw new BoardError(`#${seq} is claimed by ${t.lease_agent ? `${t.lease_holder}'s agent` : t.lease_holder} until ${iso(t.lease_until!)}. Pick another task, or ask them on the board.`);
    }
    const mins = Math.min(240, Math.max(5, Math.floor(minutes || 30)));
    const until = Date.now() + mins * 60_000;
    const renewing = t.lease_holder === user;
    this.sql.exec(
      "UPDATE tasks SET lease_holder = ?, lease_agent = ?, lease_until = ?, status = CASE WHEN status IN ('todo','stopped') THEN 'doing' ELSE status END, stop_reason = NULL, updated_at = ? WHERE seq = ?",
      user, opts.via === "agent" ? 1 : 0, until, Date.now(), seq,
    );
    if (!renewing) await this.post(user, { type: "note", reply_to: seq, text: `Claimed task #${seq} for ${mins} min.`, via: opts.via, client: opts.client });
    void info;
    return this.task(seq);
  }

  async taskRelease(user: string, seq: number, opts: TaskActOpts): Promise<TaskView> {
    const info = this.info();
    const t = this.task(seq);
    if (t.lease_holder && t.lease_holder !== user && info.created_by !== user) throw new BoardError(`Only ${t.lease_holder} (or the board's creator) can release #${seq}.`);
    this.sql.exec("UPDATE tasks SET lease_holder = NULL, lease_agent = NULL, lease_until = NULL, status = CASE WHEN status = 'doing' THEN 'todo' ELSE status END, updated_at = ? WHERE seq = ?", Date.now(), seq);
    await this.post(user, { type: "note", reply_to: seq, text: `Released task #${seq}; anyone can pick it up.`, via: opts.via, client: opts.client });
    return this.task(seq);
  }

  /** Change status, assignee or due date, optionally with a note. Blocked while someone else holds the lease. */
  async taskUpdate(user: string, seq: number, change: TaskChange, opts: TaskActOpts): Promise<TaskView> {
    const info = this.info();
    const t = this.task(seq);
    if (t.lease_holder && t.lease_holder !== user && info.created_by !== user) {
      throw new BoardError(`#${seq} is claimed by ${t.lease_holder} until ${iso(t.lease_until!)}; post on the board instead of changing it.`);
    }
    const parts: string[] = [];
    if (change.status && change.status !== t.status) {
      if (!TASK_STATUSES.includes(change.status)) throw new BoardError(`status must be one of: ${TASK_STATUSES.join(", ")}`);
      this.sql.exec("UPDATE tasks SET status = ?, stop_reason = CASE WHEN ? = 'stopped' THEN stop_reason ELSE NULL END WHERE seq = ?", change.status, change.status, seq);
      if (change.status === "done") this.sql.exec("UPDATE tasks SET lease_holder = NULL, lease_until = NULL WHERE seq = ?", seq);
      parts.push(`status → ${change.status}`);
    }
    if (change.assignee !== undefined) {
      const who = change.assignee ? change.assignee.toLowerCase() : null;
      if (who && !this.sql.exec("SELECT 1 AS x FROM members WHERE name = ?", who).toArray().length) throw new BoardError(`${who} isn't a member of this board.`);
      this.sql.exec("UPDATE tasks SET assignee = ?, assignee_agent = ? WHERE seq = ?", who, change.assignee_agent === false ? 0 : 1, seq);
      parts.push(who ? `assigned to ${change.assignee_agent === false ? who : `${who}'s agent`}` : "unassigned");
    }
    if (change.due !== undefined) {
      this.sql.exec("UPDATE tasks SET due = ? WHERE seq = ?", change.due, seq);
      parts.push(change.due ? `due ${iso(change.due).slice(0, 10)}` : "no due date");
    }
    if (!parts.length && !change.note) throw new BoardError("Nothing to update: give a status, assignee, due date or note.");
    this.sql.exec("UPDATE tasks SET updated_at = ? WHERE seq = ?", Date.now(), seq);
    const after = this.task(seq);
    await this.post(user, {
      type: "note",
      reply_to: seq,
      to: change.assignee ? change.assignee.toLowerCase() : after.assignee,
      resolves: change.status === "done" ? [seq] : undefined,
      text: `Task #${seq}: ${[...parts, change.note ?? ""].filter(Boolean).join("; ")}`,
      via: opts.via,
      client: opts.client,
    });
    return after;
  }

  /** Stop signal: any member can halt a task; whoever holds it hears about it on their next read. */
  async taskStop(user: string, seq: number, reason: string, opts: TaskActOpts): Promise<TaskView> {
    this.info();
    const t = this.task(seq);
    const why = reason.trim().slice(0, 300) || "stopped";
    this.sql.exec("UPDATE tasks SET status = 'stopped', stop_reason = ?, lease_holder = NULL, lease_until = NULL, updated_at = ? WHERE seq = ?", why, Date.now(), seq);
    await this.post(user, { type: "note", reply_to: seq, to: t.lease_holder ?? t.assignee, text: `Stop task #${seq}: ${why}`, via: opts.via, client: opts.client });
    return this.task(seq);
  }

  /** A retracted premise stops every open task built on it (reply_to). */
  private stopDependents(user: string, retracted: number) {
    const deps = this.sql
      .exec("SELECT t.seq, t.lease_holder, t.assignee FROM tasks t JOIN entries e ON e.seq = t.seq WHERE e.reply_to = ? AND t.status NOT IN ('done','stopped')", retracted)
      .toArray();
    for (const d of deps) {
      this.sql.exec("UPDATE tasks SET status = 'stopped', stop_reason = ?, lease_holder = NULL, lease_until = NULL, updated_at = ? WHERE seq = ?", `premise #${retracted} was retracted`, Date.now(), d.seq);
    }
    if (deps.length) {
      // Queued after the retraction itself so the notice lands right after it.
      queueMicrotask(() => {
        for (const d of deps) {
          void this.post(user, { type: "note", reply_to: d.seq as number, to: (d.lease_holder as string | null) ?? (d.assignee as string | null), text: `Stop task #${d.seq}: its premise #${retracted} was retracted.` }).catch(() => {});
        }
      });
    }
  }

  // ---- shared documents: versioned files people and agents edit together ----

  docList(): DocMeta[] {
    return this.sql
      .exec("SELECT name, version, updated_by, updated_at, via, client, length(content) AS size FROM docs ORDER BY updated_at DESC")
      .toArray() as unknown as DocMeta[];
  }

  async docs(): Promise<DocMeta[]> {
    this.info();
    return this.docList();
  }

  async docRead(name: string, version?: number): Promise<Doc> {
    this.info();
    const cur = this.sql.exec("SELECT name, version, content, updated_by, updated_at, via, client, created_by, created_at FROM docs WHERE name = ?", name).toArray()[0];
    if (!cur) throw new BoardError(`There's no document named "${name}" on this board.`);
    if (version != null && version !== cur.version) {
      const v = this.sql.exec("SELECT name, version, content, author AS updated_by, ts AS updated_at, via, client FROM doc_versions WHERE name = ? AND version = ?", name, version).toArray()[0];
      if (!v) throw new BoardError(`"${name}" has no version ${version} (current is v${cur.version}; older versions may have been pruned).`);
      return { ...(v as unknown as Doc), latest: cur.version as number };
    }
    return { ...(cur as unknown as Doc), latest: cur.version as number };
  }

  async docHistory(name: string): Promise<DocVersion[]> {
    this.info();
    return this.sql
      .exec("SELECT version, author, ts, via, client, summary, length(content) AS size FROM doc_versions WHERE name = ? ORDER BY version DESC LIMIT 100", name)
      .toArray() as unknown as DocVersion[];
  }

  /**
   * Write a whole document. Creating needs base_version 0; changing needs the version you read, so two editors
   * can't silently overwrite each other (a mismatch returns the current version to merge with).
   */
  async docWrite(user: string, name: string, content: string, baseVersion: number, opts: DocEditOpts): Promise<DocResult> {
    const info = this.info();
    if (info.archived) throw new BoardError(`"${info.title}" is archived, so it's read-only. Its creator can restore it.`);
    validateDocName(name);
    if (content.length > MAX_ARTIFACT) throw new BoardError(`That document is too large (max ${MAX_ARTIFACT} characters).`);
    const hit = scanFields({ [name]: content, summary: opts.summary ?? null });
    if (hit) throw new BoardError(blockedMessage(hit));
    const cur = this.sql.exec("SELECT version, content FROM docs WHERE name = ?", name).toArray()[0];
    const curVersion = (cur?.version as number) ?? 0;
    if (baseVersion !== curVersion) return { conflict: true, current: curVersion, content: (cur?.content as string) ?? "" };
    return this.saveDoc(user, name, content, curVersion, opts);
  }

  /** Replace one exact, unique piece of text in the latest version (atomic, no version needed). */
  async docEdit(user: string, name: string, oldStr: string, newStr: string, opts: DocEditOpts): Promise<DocResult> {
    const info = this.info();
    if (info.archived) throw new BoardError(`"${info.title}" is archived, so it's read-only. Its creator can restore it.`);
    const cur = this.sql.exec("SELECT version, content FROM docs WHERE name = ?", name).toArray()[0];
    if (!cur) throw new BoardError(`There's no document named "${name}" on this board. Create it with action "write" and base_version 0.`);
    const content = cur.content as string;
    if (!oldStr) throw new BoardError("old_str is required for an edit.");
    const first = content.indexOf(oldStr);
    if (first < 0) throw new BoardError(`old_str wasn't found in "${name}" v${cur.version}. Read it again and copy the text exactly.`);
    if (content.indexOf(oldStr, first + 1) >= 0) throw new BoardError(`old_str appears more than once in "${name}"; include more surrounding text so it's unique.`);
    const next = content.slice(0, first) + newStr + content.slice(first + oldStr.length);
    if (next.length > MAX_ARTIFACT) throw new BoardError(`That would make the document too large (max ${MAX_ARTIFACT} characters).`);
    const hit = scanFields({ [name]: newStr, summary: opts.summary ?? null });
    if (hit) throw new BoardError(blockedMessage(hit));
    return this.saveDoc(user, name, next, cur.version as number, opts);
  }

  /** Store the next version of a document (no log entry). Returns the new version number. */
  private storeVersion(user: string, name: string, content: string, opts: DocEditOpts, now = Date.now()): number {
    const prev = (this.sql.exec("SELECT version FROM docs WHERE name = ?", name).toArray()[0]?.version as number | undefined) ?? 0;
    const version = prev + 1;
    const client = opts.via === "agent" ? (opts.client ?? "agent").slice(0, 40) : null;
    if (prev === 0) {
      this.sql.exec(
        "INSERT INTO docs (name, version, content, updated_by, updated_at, via, client, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        name, version, content, user, now, opts.via ?? null, client, user, now,
      );
    } else {
      this.sql.exec("UPDATE docs SET version = ?, content = ?, updated_by = ?, updated_at = ?, via = ?, client = ? WHERE name = ?", version, content, user, now, opts.via ?? null, client, name);
    }
    this.sql.exec(
      "INSERT INTO doc_versions (name, version, content, author, ts, via, client, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      name, version, content, user, now, opts.via ?? null, client, opts.summary?.slice(0, 200) ?? null,
    );
    // Keep the last 50 versions of each document.
    this.sql.exec("DELETE FROM doc_versions WHERE name = ? AND version <= ?", name, version - 50);
    this.indexDoc(name, content);
    return version;
  }

  private async saveDoc(user: string, name: string, content: string, prev: number, opts: DocEditOpts): Promise<DocResult> {
    const version = this.storeVersion(user, name, content, opts);
    void prev;
    // One log entry per version: everyone's agents notice through the conversation, and tabs update live.
    const entry = await this.post(
      user,
      {
        type: "artifact",
        text: `${version === 1 ? "Created" : "Updated"} the document ${name} (v${version})${opts.summary ? `: ${opts.summary}` : "."}`,
        artifact_name: name,
        artifact_content: content,
        via: opts.via,
        client: opts.client,
      },
      { docVersion: version },
    );
    return { conflict: false, version, note: entry.seq };
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
    // File and document versions (reported against the entry that published them, or 0 if none).
    for (const r of this.sql.exec("SELECT v.name, v.version, v.content, (SELECT seq FROM entries e WHERE e.artifact_name = v.name AND e.artifact_version = v.version) AS seq FROM doc_versions v").toArray()) {
      const hit = scanText(r.content as string, `${r.name} v${r.version}`);
      if (hit) out.push({ seq: (r.seq as number | null) ?? 0, hit });
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
      reactions: afterSeq === 0 ? this.reactionsFor() : {},
      reviews: this.reviewsBySeq(),
    };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(Number.isFinite(n) ? n : lo)));
}
