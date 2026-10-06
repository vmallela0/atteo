// The Slack bridge's outbound side: one SlackTeam Durable Object per installed workspace is the only thing that talks to
// Slack's Web API for it. Messages queue in its storage and go out in order, about one a second per channel, honouring
// Retry-After on a 429. Every message is keyed by (channel, board, seq) → Slack ts in D1, so a retry edits instead of
// posting twice. Slack down: a job is kept 24 hours, then dropped and counted in the channel's digest ("missed N").
// A local server with DEV_FAKE_SLACK=1 never calls Slack: the object records each call and answers like Slack would,
// and /slack/dev/calls shows the record (the tests read it).

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import { digestMessage, excerpt, fakeSlack, openToken, postFields, retractedMessage, SLACK_API, DIGEST_FRESH_MS, type SlackMessage } from "./slackCore";

export interface SlackResp {
  ok: boolean;
  error?: string;
  retryAfter?: number; // seconds, on a 429
  [k: string]: unknown;
}

export type Job =
  | { kind: "entry"; channel: string; board: string; seq: number; root: number | null; msg: SlackMessage }
  | { kind: "retract"; channel: string; board: string; seq: number; url: string }
  | { kind: "dm"; channel: string; approval: string; msg: SlackMessage }
  | { kind: "digest"; channel: string; board: string; title: string; url: string }
  | { kind: "call"; channel: string; method: string; body: Record<string, unknown> };

export type Outcome = { done: true } | { retryAt: number; why: string } | { drop: string };

export interface QueueDeps {
  db: D1Database;
  team: string;
  api(method: string, body: Record<string, unknown>): Promise<SlackResp>;
  now(): number;
  /** The newest digest entry's words (its title or first line), fetched from the board when the digest goes out. */
  latest(board: string, seq: number): Promise<string | null>;
}

const PAUSE: Record<string, string> = { channel_not_found: "removed", not_in_channel: "removed", is_archived: "archived", channel_is_archived: "archived" };
const REVOKED = new Set(["invalid_auth", "token_revoked", "account_inactive", "not_authed", "token_expired"]);

/** What a failed call means for the queue: pause the link, mark the install revoked, retry, or give up. */
async function failed(d: QueueDeps, job: Job, r: SlackResp): Promise<Outcome> {
  const err = r.error ?? "unknown";
  if (err === "ratelimited") return { retryAt: d.now() + Math.max(1, r.retryAfter ?? 1) * 1000, why: err };
  if (PAUSE[err] && job.kind !== "dm" && job.kind !== "call") {
    await d.db.prepare(`UPDATE slack_links SET paused = ? WHERE channel_id = ? AND paused IS NULL`).bind(PAUSE[err], job.channel).run();
    return { drop: err };
  }
  if (REVOKED.has(err)) {
    await revoke(d.db, d.team, d.now());
    return { drop: err };
  }
  return { drop: err };
}

/** The app was uninstalled or its token revoked: forget the token, and every link in the workspace stops ("disconnected"). */
export async function revoke(db: D1Database, team: string, now: number): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE slack_installs SET bot_token = NULL, revoked_at = COALESCE(revoked_at, ?) WHERE team_id = ?`).bind(now, team),
    db.prepare(`UPDATE slack_links SET paused = 'disconnected' WHERE team_id = ?`).bind(team),
  ]);
}

const tsOf = async (db: D1Database, channel: string, board: string, seq: number) =>
  (await db.prepare(`SELECT ts FROM slack_messages WHERE channel_id = ? AND board_id = ? AND seq = ?`).bind(channel, board, seq).first<{ ts: string }>())?.ts ?? null;

/** chat.update takes no username (a message keeps who posted it). */
const updateFields = (m: SlackMessage) => {
  const { username: _u, ...rest } = postFields(m);
  return rest;
};

/** Runs one job against Slack. Idempotent: an entry already in the channel is edited, not posted again. */
export async function runJob(job: Job, d: QueueDeps): Promise<Outcome> {
  const db = d.db;
  if (job.kind === "entry") {
    const ts = await tsOf(db, job.channel, job.board, job.seq);
    if (ts) {
      const r = await d.api("chat.update", { channel: job.channel, ts, ...updateFields(job.msg) });
      if (r.ok) return { done: true };
      if (r.error === "message_not_found") {
        await db.prepare(`DELETE FROM slack_messages WHERE channel_id = ? AND board_id = ? AND seq = ?`).bind(job.channel, job.board, job.seq).run();
        return { retryAt: d.now(), why: "message gone: post it again" };
      }
      return failed(d, job, r);
    }
    const parent = job.root != null ? await tsOf(db, job.channel, job.board, job.root) : null;
    const r = await d.api("chat.postMessage", { channel: job.channel, ...(parent ? { thread_ts: parent } : {}), ...postFields(job.msg) });
    if (!r.ok) return failed(d, job, r);
    await db.prepare(`INSERT OR IGNORE INTO slack_messages (channel_id, board_id, seq, ts, team_id) VALUES (?, ?, ?, ?, ?)`).bind(job.channel, job.board, job.seq, String(r.ts), d.team).run();
    return { done: true };
  }
  if (job.kind === "retract") {
    const ts = await tsOf(db, job.channel, job.board, job.seq);
    if (!ts) return { done: true };
    const r = await d.api("chat.update", { channel: job.channel, ts, ...updateFields(retractedMessage(job.url)) });
    return r.ok || r.error === "message_not_found" ? { done: true } : failed(d, job, r);
  }
  if (job.kind === "dm") {
    const row = await db.prepare(`SELECT channel_id, ts FROM slack_dms WHERE approval_id = ? AND team_id = ?`).bind(job.approval, d.team).first<{ channel_id: string | null; ts: string | null }>();
    if (row?.ts && row.channel_id) {
      const r = await d.api("chat.update", { channel: row.channel_id, ts: row.ts, ...updateFields(job.msg) });
      return r.ok ? { done: true } : failed(d, job, r);
    }
    const r = await d.api("chat.postMessage", { channel: job.channel, ...postFields(job.msg) });
    if (!r.ok) return failed(d, job, r);
    await db.prepare(`INSERT OR REPLACE INTO slack_dms (approval_id, team_id, channel_id, ts) VALUES (?, ?, ?, ?)`).bind(job.approval, d.team, String(r.channel ?? job.channel), String(r.ts)).run();
    return { done: true };
  }
  if (job.kind === "digest") {
    const l = await db.prepare(`SELECT * FROM slack_links WHERE channel_id = ? AND board_id = ?`).bind(job.channel, job.board).first<LinkRow>();
    if (!l || l.paused) return { drop: "link gone or paused" };
    if (!l.pending_n && !l.pending_flagged && !l.pending_missed) return { done: true };
    const now = d.now();
    const fresh = !l.digest_ts || !l.digest_since || now - l.digest_since >= DIGEST_FRESH_MS;
    const names = [...new Set([...(fresh ? [] : list(l.digest_agents)), ...list(l.pending_agents)])];
    const n = (fresh ? 0 : l.digest_n) + l.pending_n;
    const latestSeq = Number(l.pending_latest);
    const latest = latestSeq > 0 ? await d.latest(job.board, latestSeq).catch(() => null) : null;
    const msg = digestMessage({ n, agents: names, latest: latest ? excerpt(latest) : null, flagged: l.pending_flagged, missed: l.pending_missed, boardTitle: job.title, url: job.url });
    const r = fresh ? await d.api("chat.postMessage", { channel: job.channel, ...postFields(msg) }) : await d.api("chat.update", { channel: job.channel, ts: l.digest_ts, ...updateFields(msg) });
    if (!r.ok) return failed(d, job, r);
    // What this message took is subtracted, so a post that arrived meanwhile waits for the next one.
    await db
      .prepare(
        `UPDATE slack_links SET digest_ts = ?, digest_since = ?, digest_n = ?, digest_agents = ?, pending_n = MAX(0, pending_n - ?), pending_flagged = MAX(0, pending_flagged - ?), pending_missed = MAX(0, pending_missed - ?), pending_agents = NULL, flushed_at = ? WHERE channel_id = ?`,
      )
      .bind(fresh ? String(r.ts) : l.digest_ts, fresh ? now : l.digest_since, n, JSON.stringify(names), l.pending_n, l.pending_flagged, l.pending_missed, now, job.channel)
      .run();
    return { done: true };
  }
  const r = await d.api(job.method, job.body);
  return r.ok ? { done: true } : failed(d, job, r);
}

export interface LinkRow {
  channel_id: string;
  team_id: string;
  channel_name: string;
  board_id: string;
  lane: "decisions" | "everything";
  shared: number;
  created_by: string;
  created_at: number;
  paused: string | null;
  audience_at: number | null;
  digest_ts: string | null;
  digest_since: number | null;
  digest_n: number;
  digest_agents: string | null;
  pending_n: number;
  pending_agents: string | null;
  pending_latest: string | null;
  pending_flagged: number;
  pending_missed: number;
  flushed_at: number | null;
}

function list(json: string | null): string[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

// ---- the stub Slack (DEV_FAKE_SLACK=1 on localhost) ----

/** What Slack would answer, without Slack: messages get timestamps, a DM to a person lands in "D…", a few channels exist. */
export function fakeAnswer(method: string, body: Record<string, unknown>, n: number): SlackResp {
  const ts = `${1_700_000_000 + n}.000100`;
  const ch = String(body.channel ?? "");
  switch (method) {
    case "chat.postMessage":
      return { ok: true, channel: ch.startsWith("U") ? "D" + ch.slice(1) : ch, ts };
    case "chat.update":
      return { ok: true, channel: ch, ts: body.ts };
    case "conversations.list":
      return { ok: true, channels: FAKE_CHANNELS };
    case "conversations.info": {
      const c = FAKE_CHANNELS.find((x) => x.id === ch);
      return c ? { ok: true, channel: { ...c, num_members: c.is_ext_shared ? 40 : 8 } } : { ok: false, error: "channel_not_found" };
    }
    case "conversations.join":
      return { ok: true, channel: { id: ch } };
    case "users.info":
      return { ok: true, user: { id: body.user, name: `slack-${String(body.user).toLowerCase()}` } };
    default:
      return { ok: true };
  }
}

export const FAKE_TEAM = { id: "T0FAKE", name: "Fake Co", bot_user_id: "U0FAKEBOT" };
export const FAKE_CHANNELS = [
  { id: "C0GENERAL", name: "general", is_member: true, is_private: false, is_ext_shared: false },
  { id: "C0API", name: "acme-api", is_member: false, is_private: false, is_ext_shared: false },
  { id: "C0PARTNERS", name: "partners", is_member: true, is_private: false, is_ext_shared: true },
];

// ---- the Durable Object ----

const MAX_ATTEMPTS = 5;
const KEEP_MS = 24 * 3600_000;
const PER_CHANNEL_MS = 1000;

export class SlackTeam extends DurableObject<Env> {
  private sql: SqlStorage;
  private token: { sealed: string; token: string } | null = null;
  private draining = false;
  private again = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, channel TEXT NOT NULL, at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, not_before INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sent (channel TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS fake_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, method TEXT NOT NULL, body TEXT NOT NULL, answer TEXT, at INTEGER NOT NULL)`);
  }

  private team(t?: string): string {
    if (t) this.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('team', ?)`, t);
    return t ?? ((this.sql.exec(`SELECT v FROM meta WHERE k = 'team'`).toArray()[0]?.v as string | undefined) ?? "");
  }

  private async botToken(team: string): Promise<string | null> {
    const row = await this.env.DB.prepare(`SELECT bot_token FROM slack_installs WHERE team_id = ? AND revoked_at IS NULL`).bind(team).first<{ bot_token: string | null }>();
    if (!row?.bot_token) return (this.token = null);
    if (this.token?.sealed !== row.bot_token) this.token = { sealed: row.bot_token, token: await openToken(this.env, row.bot_token) };
    return this.token.token;
  }

  /** One Web API call, now (not queued): interactive answers (views.open, chat.postEphemeral) can't wait their turn. */
  async call(team: string, method: string, body: Record<string, unknown>): Promise<SlackResp> {
    this.team(team);
    if (fakeSlack(this.env)) return this.fake(method, body);
    const token = await this.botToken(team);
    if (!token) return { ok: false, error: "not_installed" };
    try {
      const res = await fetch(SLACK_API + method, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (res.status === 429) return { ok: false, error: "ratelimited", retryAfter: Number(res.headers.get("retry-after")) || 1 };
      return ((await res.json().catch(() => null)) as SlackResp | null) ?? { ok: false, error: `http_${res.status}` };
    } catch (e) {
      return { ok: false, error: "unreachable", detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /** An answer to a slash command or a button, through its response_url (only ever a hooks.slack.com address). */
  async respond(team: string, url: string, body: Record<string, unknown>): Promise<void> {
    this.team(team);
    if (fakeSlack(this.env)) return void this.fake("response_url", { url, ...body });
    if (!/^https:\/\/hooks\.slack\.com\//.test(url)) return;
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }

  private fake(method: string, body: Record<string, unknown>): SlackResp {
    const id = this.sql.exec(`INSERT INTO fake_calls (method, body, at) VALUES (?, ?, ?) RETURNING id`, method, JSON.stringify(body), Date.now()).one().id as number;
    const answer = fakeAnswer(method, body, id);
    this.sql.exec(`UPDATE fake_calls SET answer = ? WHERE id = ?`, JSON.stringify(answer), id);
    return answer;
  }

  /** The stub's record (DEV_FAKE_SLACK only): each call and what the stub answered. */
  async fakeLog(): Promise<{ method: string; body: Record<string, unknown>; answer: SlackResp | null }[]> {
    if (!fakeSlack(this.env)) return [];
    return this.sql.exec(`SELECT method, body, answer FROM fake_calls ORDER BY id`).toArray().map((r) => ({ method: r.method as string, body: JSON.parse(r.body as string), answer: r.answer ? JSON.parse(r.answer as string) : null }));
  }

  async enqueue(team: string, jobs: Job[]): Promise<void> {
    this.team(team);
    const now = Date.now();
    for (const j of jobs) this.sql.exec(`INSERT INTO jobs (job, channel, at) VALUES (?, ?, ?)`, JSON.stringify(j), j.channel, now);
    await this.drain();
  }

  async alarm(): Promise<void> {
    await this.drain();
  }

  /** How many jobs are waiting (the tests wait for 0). */
  async pending(): Promise<number> {
    return this.sql.exec(`SELECT COUNT(*) AS n FROM jobs`).toArray()[0].n as number;
  }

  private async drain(): Promise<void> {
    if (this.draining) return void (this.again = true);
    this.draining = true;
    try {
      do {
        this.again = false;
        await this.drainOnce();
      } while (this.again);
    } finally {
      this.draining = false;
    }
  }

  private async drainOnce(): Promise<void> {
    const team = this.team();
    const deps: QueueDeps = {
      db: this.env.DB,
      team,
      api: (method, body) => this.call(team, method, body),
      now: () => Date.now(),
      latest: async (board, seq) => {
        const got = await this.env.BOARD.get(this.env.BOARD.idFromName(board)).get(seq, null);
        return got.entry.title || got.entry.text;
      },
    };
    let wake = Infinity;
    const blocked = new Set<string>();
    for (const row of this.sql.exec(`SELECT id, job, channel, at, attempts, not_before FROM jobs ORDER BY id LIMIT 200`).toArray()) {
      const channel = row.channel as string;
      const now = Date.now();
      // Kept a day at most: then it's dropped, and the channel's digest says what was missed.
      if (now - (row.at as number) > KEEP_MS) {
        this.sql.exec(`DELETE FROM jobs WHERE id = ?`, row.id);
        await this.env.DB.prepare(`UPDATE slack_links SET pending_missed = pending_missed + 1 WHERE channel_id = ?`).bind(channel).run().catch(() => {});
        continue;
      }
      if (blocked.has(channel)) continue; // in order, per channel
      const last = (this.sql.exec(`SELECT at FROM sent WHERE channel = ?`, channel).toArray()[0]?.at as number | undefined) ?? 0;
      const ready = Math.max(row.not_before as number, last + PER_CHANNEL_MS);
      if (ready > now) {
        blocked.add(channel);
        wake = Math.min(wake, ready);
        continue;
      }
      let out: Outcome;
      try {
        out = await runJob(JSON.parse(row.job as string) as Job, deps);
      } catch (e) {
        out = { retryAt: Date.now() + 30_000 * 2 ** (row.attempts as number), why: e instanceof Error ? e.message : String(e) };
      }
      this.sql.exec(`INSERT OR REPLACE INTO sent (channel, at) VALUES (?, ?)`, channel, Date.now());
      if ("retryAt" in out && (row.attempts as number) + 1 < MAX_ATTEMPTS) {
        this.sql.exec(`UPDATE jobs SET attempts = attempts + 1, not_before = ? WHERE id = ?`, out.retryAt, row.id);
        blocked.add(channel);
        wake = Math.min(wake, out.retryAt);
      } else {
        if ("drop" in out || "retryAt" in out) console.error(`slack job dropped (${team}): ${"drop" in out ? out.drop : out.why}`);
        this.sql.exec(`DELETE FROM jobs WHERE id = ?`, row.id);
      }
    }
    const left = this.sql.exec(`SELECT COUNT(*) AS n FROM jobs`).toArray()[0].n as number;
    if (left && wake === Infinity) wake = Date.now() + PER_CHANNEL_MS;
    if (left) await this.ctx.storage.setAlarm(wake);
  }
}

/** The workspace's object. */
export function teamStub(env: Env, team: string) {
  return env.SLACK.get(env.SLACK.idFromName(team));
}

