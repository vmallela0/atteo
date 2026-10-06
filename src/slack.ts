// The Slack bridge (vedu #5401; design v1: board #5405, docs/SLACK.md). It carries a board into Slack instead of copying
// it: agents keep working on Atteo, and people never have to leave Slack.
//
// - Install: a board's ⋯ → Connect Slack → Slack's OAuth (bot scopes only) → pick a channel. Only the board's owner
//   links; never an encrypted board, a DM or "Your agent". `/atteo link` in a channel does the same from Slack.
// - People link once per workspace, on a signed-in Atteo page (a single-use 10-minute nonce bound to that Slack person).
//   Installing the app links its installer: they proved both accounts.
// - What shows: the Decisions lane by default (questions, approvals as status only, ready-to-gate handoffs, tasks for
//   and posts naming linked people), each its own message; the rest rolls into one digest message per channel, edited
//   in place at most every 15 minutes, a fresh one each hour. Replies thread under their root. Everything is opt-in.
// - Replies in a bridged thread post on the board as their linked person (reply_to its root, client "Slack").
// - Approvals go by DM to their owner only, with Approve / Deny for low and medium risk (high risk: Review in Atteo).
//   The click is checked here: the approval's owner must be the Atteo person linked to that Slack person, in that
//   workspace. The decision goes through approvals.decide like the browser's, with "slack:<team>/<user>" recorded.
// - /atteo: what's waiting for me · link · unlink · lane · ask · who. App Home shows the same.
// - Every request from Slack is checked (signature over the raw body, 5 minutes), deduped (event and trigger ids, an
//   hour), acknowledged at once, and handled in waitUntil. Board text is escaped (slackCore.ts).
//
// Hidden until SLACK_CLIENT_ID and the three secrets are set (slackOn): /slack/* answers 404 and there's no menu item.
// A localhost server with DEV_FAKE_SLACK=1 runs against a stub Slack (slackQueue.ts) that records every call.

import * as approvals from "./approvals";
import type { ForYouCore } from "./forYou";
import * as registry from "./registry";
import * as sessions from "./sessions";
import type { ApprovalRef, Entry, Env } from "./types";
import { page, type Viewer } from "./ui";
import { esc as html, offBoardSeq } from "./util";
import * as core from "./slackCore";
import { FAKE_TEAM, revoke, teamStub, type Job, type LinkRow, type SlackResp } from "./slackQueue";

// ---- what the bridge needs (tests pass stand-ins) ----

export interface BoardOps {
  /** Posts as a person (via "person", client "Slack"); `from` is the channel it came from, so it isn't echoed back there. */
  post(board: string, user: string, input: { type: "note" | "question"; text: string; reply_to?: number | null }, from: string | null): Promise<number>;
  setSlack(board: string, on: boolean): Promise<void>;
  approvalDecided(board: string, ref: ApprovalRef): Promise<void>;
  forYou(board: string, user: string, since: number): Promise<ForYouCore | null>;
  notice(board: string, user: string, text: string): Promise<void>;
  agents(board: string): Promise<{ user: string; name: string | null; client: string | null }[]>;
}

export interface OAuthAnswer {
  ok: boolean;
  error?: string;
  team?: { id: string; name: string };
  enterprise?: { id: string } | null;
  bot_user_id?: string;
  access_token?: string;
  authed_user?: { id: string };
}

/** Sign in with Slack (OpenID Connect): who the person proved they are on Slack. */
export interface SlackIdentity {
  ok: boolean;
  error?: string;
  team?: string;
  user?: string;
}

export interface Bridge {
  db: D1Database;
  env: core.SlackEnv;
  origin: string;
  now(): number;
  /** One Web API call now (interactive answers, lookups). */
  call(team: string, method: string, body: Record<string, unknown>): Promise<SlackResp>;
  /** Messages, in order, through the workspace's queue. */
  enqueue(team: string, jobs: Job[]): Promise<void>;
  /** An answer through a response_url. */
  respond(team: string, url: string, body: Record<string, unknown>): Promise<void>;
  oauth(code: string, redirectUri: string): Promise<OAuthAnswer>;
  /** Sign in with Slack's code → the Slack account that signed in. */
  openid(code: string, redirectUri: string): Promise<SlackIdentity>;
  board: BoardOps;
}

const stubOf = (env: Env, id: string) => env.BOARD.get(env.BOARD.idFromName(id));

export function bridgeFor(env: Env, origin?: string): Bridge {
  const fake = core.fakeSlack(env);
  return {
    db: env.DB,
    env,
    origin: (origin ?? env.PUBLIC_URL ?? "https://atteo.dev").replace(/\/$/, ""),
    now: () => Date.now(),
    call: (team, method, body) => teamStub(env, team).call(team, method, body),
    enqueue: (team, jobs) => teamStub(env, team).enqueue(team, jobs),
    respond: (team, url, body) => teamStub(env, team).respond(team, url, body),
    async oauth(code, redirectUri) {
      if (fake && code.startsWith("fake:")) {
        return { ok: true, team: { id: FAKE_TEAM.id, name: FAKE_TEAM.name }, enterprise: null, bot_user_id: FAKE_TEAM.bot_user_id, access_token: "xoxb-fake-token", authed_user: { id: code.slice(5) || "U0FAKEOWNER" } };
      }
      const form = new URLSearchParams({ client_id: env.SLACK_CLIENT_ID ?? "", client_secret: env.SLACK_CLIENT_SECRET ?? "", code, redirect_uri: redirectUri });
      const res = await fetch(core.SLACK_API + "oauth.v2.access", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(10_000) });
      return ((await res.json().catch(() => null)) as OAuthAnswer | null) ?? { ok: false, error: `http_${res.status}` };
    },
    async openid(code, redirectUri) {
      // The stub: "fake:<team>/<user>" is whoever the local test says signed in.
      if (fake && code.startsWith("fake:")) {
        const [team, user] = code.slice(5).split("/");
        return team && user ? { ok: true, team, user } : { ok: false, error: "invalid_code" };
      }
      const form = new URLSearchParams({ client_id: env.SLACK_CLIENT_ID ?? "", client_secret: env.SLACK_CLIENT_SECRET ?? "", code, redirect_uri: redirectUri });
      const res = await fetch(core.SLACK_API + "openid.connect.token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(10_000) });
      const r = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; id_token?: string } | null;
      if (!r?.ok || !r.id_token) return { ok: false, error: r?.error ?? `http_${res.status}` };
      // The ID token came straight from Slack's token endpoint over TLS, for our client secret: its claims can be read
      // without checking its signature (OpenID Connect Core §3.1.3.7).
      try {
        const claims = JSON.parse(atob(r.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
        const team = claims["https://slack.com/team_id"], user = claims["https://slack.com/user_id"];
        return typeof team === "string" && typeof user === "string" ? { ok: true, team, user } : { ok: false, error: "no_identity" };
      } catch {
        return { ok: false, error: "bad_id_token" };
      }
    },
    board: {
      async post(board, user, input, from) {
        const e = await stubOf(env, board).post(user, { type: input.type, text: input.text, reply_to: input.reply_to ?? null, via: "person", client: "Slack" }, { slackFrom: from, origin: "slack" });
        await registry.bumpBoard(env, board, e.seq).catch(() => {});
        return e.seq;
      },
      setSlack: (board, on) => stubOf(env, board).setSlack(on),
      approvalDecided: async (board, ref) => void (await stubOf(env, board).approvalDecided(ref)),
      forYou: (board, user, since) => stubOf(env, board).forYou(user, since).catch(() => null),
      notice: async (board, user, text) => void (await stubOf(env, board).notice(user, "Slack", text, { via: "agent", client: "Slack", session: null }, "slack")),
      agents: async (board) => {
        const now = Date.now();
        return (await sessions.onBoard(env, board)).filter((s) => sessions.present(s.last_seen, now)).map((s) => ({ user: s.user, name: s.name, client: s.client }));
      },
    },
  };
}

// ---- small lookups ----

interface BoardLite {
  id: string;
  title: string;
  encrypted: number;
  kind: string | null;
  archived_at: number | null;
  deleted_at: number | null;
}

const boardRow = (b: Bridge, id: string) => b.db.prepare(`SELECT id, title, encrypted, kind, archived_at, deleted_at FROM boards WHERE id = ?`).bind(id).first<BoardLite>();

async function roleOf(b: Bridge, board: string, user: string): Promise<string | null> {
  const r = await b.db.prepare(`SELECT role, expires_at FROM members WHERE board_id = ? AND user = ?`).bind(board, user).first<{ role: string; expires_at: number | null }>();
  return r && (r.expires_at == null || r.expires_at > b.now()) ? r.role : null;
}

const personOf = async (b: Bridge, team: string, slackUser: string) =>
  (await b.db.prepare(`SELECT user FROM slack_people WHERE team_id = ? AND slack_user = ?`).bind(team, slackUser).first<{ user: string }>())?.user ?? null;

/** Slack id → Atteo handle, for one workspace. */
async function peopleOf(b: Bridge, team: string): Promise<Map<string, string>> {
  const rows = (await b.db.prepare(`SELECT slack_user, user FROM slack_people WHERE team_id = ?`).bind(team).all<{ slack_user: string; user: string }>()).results;
  return new Map(rows.map((r) => [r.slack_user, r.user]));
}

const installOf = (b: Bridge, team: string) =>
  b.db.prepare(`SELECT team_id, team_name, bot_user_id, revoked_at FROM slack_installs WHERE team_id = ?`).bind(team).first<{ team_id: string; team_name: string; bot_user_id: string; revoked_at: number | null }>();

/** The first time this key is seen in the last hour (Slack retries, double clicks). */
async function firstSeen(b: Bridge, key: string): Promise<boolean> {
  const r = await b.db.prepare(`INSERT OR IGNORE INTO slack_seen (key, at) VALUES (?, ?)`).bind(key.slice(0, 200), b.now()).run();
  return (r.meta?.changes ?? 0) > 0;
}

async function newNonce(b: Bridge, o: { kind: string; user?: string | null; board_id?: string | null; team_id?: string | null; slack_user?: string | null; slack_name?: string | null; enterprise_id?: string | null }): Promise<string> {
  const n = core.randomNonce();
  await b.db
    .prepare(`INSERT INTO slack_nonces (nonce, kind, user, board_id, team_id, slack_user, slack_name, enterprise_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(n, o.kind, o.user ?? null, o.board_id ?? null, o.team_id ?? null, o.slack_user ?? null, o.slack_name ?? null, o.enterprise_id ?? null, b.now() + core.NONCE_MS)
    .run();
  return n;
}

interface NonceRow {
  nonce: string;
  kind: string;
  user: string | null;
  board_id: string | null;
  team_id: string | null;
  slack_user: string | null;
  slack_name: string | null;
  enterprise_id: string | null;
  expires_at: number;
}

/** Used once: taken (deleted) whatever happens next; null if it's unknown, of another kind, or expired. */
async function takeNonce(b: Bridge, nonce: string, kind: string): Promise<NonceRow | null> {
  if (!/^[0-9a-f]{36}$/.test(nonce)) return null;
  const n = await b.db.prepare(`DELETE FROM slack_nonces WHERE nonce = ? RETURNING *`).bind(nonce).first<NonceRow>();
  return n && n.kind === kind && n.expires_at > b.now() ? n : null;
}

const peekNonce = async (b: Bridge, nonce: string, kind: string) => {
  if (!/^[0-9a-f]{36}$/.test(nonce)) return null;
  const n = await b.db.prepare(`SELECT * FROM slack_nonces WHERE nonce = ?`).bind(nonce).first<NonceRow>();
  return n && n.kind === kind && n.expires_at > b.now() ? n : null;
};

const entryUrl = (b: Bridge, board: string, seq?: number | null) => `${b.origin}/b/${board}${seq ? `#e${seq}` : ""}`;

/** Why this person can't link this board to Slack, or the board. */
export async function linkable(b: Bridge, board: string, user: string): Promise<BoardLite | string> {
  const row = /^b_[a-z0-9]{8,32}$/.test(board) ? await boardRow(b, board) : null;
  if (!row || row.deleted_at) return "No such board.";
  if ((await roleOf(b, board, user)) !== "owner") return "Only the board's owner can connect it to Slack.";
  if (row.encrypted) return "This board is end-to-end encrypted: in Slack its messages would be plain text, so it can't be connected.";
  if (row.kind === "agent") return "\"Your agent\" stays between you and your agents: it can't be connected to Slack.";
  if (row.kind === "direct") return "A conversation between two people can't be connected to a Slack channel.";
  if (row.archived_at) return "This board is archived.";
  return row;
}

// ---- the board's side: what a new entry or a decision does in Slack ----

/** From the board object, after a public post (never people-only, Just mine, or anything on an encrypted board). */
export async function onEntry(env: Env, info: { id: string; title: string }, e: Entry, root: Entry | null, from: string | null): Promise<void> {
  if (!core.slackOn(env)) return;
  await bridgeEntry(bridgeFor(env), info, e, root, from);
}

/** From the board object, when one of its approvals is decided (or timed out). */
export async function onApprovalDecided(env: Env, info: { id: string; title: string }, seq: number | null, ref: ApprovalRef): Promise<void> {
  if (!core.slackOn(env)) return;
  await bridgeApproval(bridgeFor(env), info, seq, ref);
}

const liveLinks = async (b: Bridge, board: string) => (await b.db.prepare(`SELECT * FROM slack_links WHERE board_id = ? AND paused IS NULL`).bind(board).all<LinkRow>()).results;

const askerOf = (ref: Pick<ApprovalRef, "user" | "requested_by" | "session">) => (ref.requested_by && ref.requested_by !== ref.user ? `${ref.requested_by}'s agent` : `${ref.user}'s agent${ref.session ? ` (${ref.session})` : ""}`);

export async function bridgeEntry(b: Bridge, info: { id: string; title: string }, e: Entry, root: Entry | null, from: string | null): Promise<void> {
  const links = await liveLinks(b, info.id);
  if (!links.length) return;
  const byTeam = new Map<string, LinkRow[]>();
  for (const l of links) byTeam.set(l.team_id, [...(byTeam.get(l.team_id) ?? []), l]);
  for (const [team, mine] of byTeam) {
    const jobs: Job[] = [];
    if (e.retracts != null) {
      for (const l of mine) jobs.push({ kind: "retract", channel: l.channel_id, board: info.id, seq: e.retracts, url: entryUrl(b, info.id, e.retracts) });
      await b.enqueue(team, jobs);
      continue;
    }
    const people = await peopleOf(b, team);
    const slackIdOf = new Map<string, string>();
    for (const [sid, u] of people) if (!slackIdOf.has(u)) slackIdOf.set(u, sid);
    const linked = new Set(slackIdOf.keys());
    if (e.type === "approval" && e.approval) {
      const ref = e.approval;
      for (const l of mine) {
        if (l.channel_id === from) continue;
        jobs.push({ kind: "entry", channel: l.channel_id, board: info.id, seq: e.seq, root: null, msg: core.approvalStatusMessage(ref, { boardTitle: info.title, url: entryUrl(b, info.id, e.seq), owner: ref.user, asker: askerOf(ref) }) });
      }
      // The details and the buttons: only to the approval's owner, by DM, and only while they're on the board.
      const sid = slackIdOf.get(ref.user);
      if (sid && (await roleOf(b, info.id, ref.user))) {
        const a = await b.db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(ref.id).first<approvals.Approval>();
        if (a) jobs.push({ kind: "dm", channel: sid, approval: a.id, msg: core.approvalDm(a, { boardTitle: info.title, url: `${b.origin}/approvals#${a.id}`, asker: askerOf(ref) }) });
      }
      await b.enqueue(team, jobs);
      if (sid) await publishHome(b, team, sid).catch(() => {});
      continue;
    }
    for (const l of mine) {
      if (l.channel_id === from) continue; // it came from this channel's thread: it's there already
      const route = core.routeOf(e, root, l.lane, linked);
      if (route === "skip") continue;
      if (route === "digest") {
        await toDigest(b, l, e);
        if (await claimFlush(b, l.channel_id)) jobs.push({ kind: "digest", channel: l.channel_id, board: info.id, title: info.title, url: entryUrl(b, info.id) });
        continue;
      }
      const named = [...(e.mentions ?? []).filter((m) => !m.agent && m.user !== e.author).map((m) => m.user), ...(e.type === "task" && e.to ? [e.to] : [])];
      const cc = [...new Set(named.map((u) => slackIdOf.get(u)).filter((x): x is string => !!x))];
      jobs.push({ kind: "entry", channel: l.channel_id, board: info.id, seq: e.seq, root: route === "thread" ? root!.seq : null, msg: core.entryMessage(e, { boardTitle: info.title, url: entryUrl(b, info.id, e.seq), cc, boardId: info.id }) });
    }
    if (jobs.length) await b.enqueue(team, jobs);
  }
}

/** One more entry for the channel's digest: counted (flagged ones apart), its author noted, its seq kept (never its text). */
async function toDigest(b: Bridge, l: LinkRow, e: Entry): Promise<void> {
  if (core.flagOf(e)) {
    await b.db.prepare(`UPDATE slack_links SET pending_flagged = pending_flagged + 1 WHERE channel_id = ?`).bind(l.channel_id).run();
    return;
  }
  const who = e.via === "agent" ? `${e.author}'s agent` : e.author;
  const now = (await b.db.prepare(`SELECT pending_agents FROM slack_links WHERE channel_id = ?`).bind(l.channel_id).first<{ pending_agents: string | null }>())?.pending_agents;
  let names: string[] = [];
  try {
    names = JSON.parse(now ?? "[]");
  } catch {}
  if (!names.includes(who)) names = [...names, who].slice(-20);
  await b.db.prepare(`UPDATE slack_links SET pending_n = pending_n + 1, pending_agents = ?, pending_latest = ? WHERE channel_id = ?`).bind(JSON.stringify(names), String(e.seq), l.channel_id).run();
}

/** Whether this call gets to send the digest now: at most every 15 minutes per channel (the cron sends what waits). */
async function claimFlush(b: Bridge, channel: string): Promise<boolean> {
  const now = b.now();
  const r = await b.db.prepare(`UPDATE slack_links SET flushed_at = ? WHERE channel_id = ? AND (flushed_at IS NULL OR flushed_at < ?)`).bind(now, channel, now - core.DIGEST_EVERY_MS).run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function bridgeApproval(b: Bridge, info: { id: string; title: string }, seq: number | null, ref: ApprovalRef): Promise<void> {
  const links = seq != null ? await liveLinks(b, info.id) : [];
  const dms = (await b.db.prepare(`SELECT team_id FROM slack_dms WHERE approval_id = ?`).bind(ref.id).all<{ team_id: string }>()).results;
  const teams = new Set([...links.map((l) => l.team_id), ...dms.map((d) => d.team_id)]);
  if (!teams.size) return;
  const a = await b.db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(ref.id).first<approvals.Approval & { decided_via: string | null }>();
  for (const team of teams) {
    const jobs: Job[] = [];
    const sid = (await b.db.prepare(`SELECT slack_user FROM slack_people WHERE team_id = ? AND user = ?`).bind(team, ref.user).first<{ slack_user: string }>())?.slack_user;
    for (const l of links.filter((x) => x.team_id === team)) {
      jobs.push({ kind: "entry", channel: l.channel_id, board: info.id, seq: seq!, root: null, msg: core.approvalStatusMessage(ref, { boardTitle: info.title, url: entryUrl(b, info.id, seq), owner: ref.user, asker: askerOf(ref) }) });
    }
    if (a && dms.some((d) => d.team_id === team)) {
      jobs.push({ kind: "dm", channel: sid ?? "", approval: a.id, msg: core.approvalDm({ ...a, status: ref.status }, { boardTitle: info.title, url: `${b.origin}/approvals#${a.id}`, asker: askerOf(ref), via: a.decided_via }) });
    }
    if (jobs.length) await b.enqueue(team, jobs);
    if (sid) await publishHome(b, team, sid).catch(() => {});
  }
}

// ---- linking a channel ----

interface ChannelInfo {
  id: string;
  name: string;
  is_member?: boolean;
  is_private?: boolean;
  is_ext_shared?: boolean;
  is_archived?: boolean;
  is_im?: boolean;
  num_members?: number;
}

/** Links a channel to a board (the owner already checked). Null when done; otherwise why not, in words. */
export async function linkChannel(b: Bridge, o: { team: string; channel: ChannelInfo; board: BoardLite; user: string; lane: core.Lane }): Promise<string | null> {
  const ch = o.channel;
  if (ch.is_im) return "Run /atteo link in the channel you want the board in.";
  if (ch.is_archived) return `#${ch.name} is archived.`;
  const existing = await b.db.prepare(`SELECT board_id FROM slack_links WHERE channel_id = ?`).bind(ch.id).first<{ board_id: string }>();
  if (existing) return existing.board_id === o.board.id ? `#${ch.name} already follows this board.` : `#${ch.name} already follows another board (one board per channel). Unlink it there first: /atteo unlink.`;
  if (!ch.is_member) {
    if (ch.is_private) return `Invite Atteo to #${ch.name} first (/invite @Atteo in the channel), then try again.`;
    const j = await b.call(o.team, "conversations.join", { channel: ch.id });
    if (!j.ok) return `Slack wouldn't let Atteo join #${ch.name} (${j.error ?? "error"}).`;
  }
  const shared = !!ch.is_ext_shared;
  const lane: core.Lane = shared ? "decisions" : o.lane; // shared channels start with decisions only; everything is the owner's explicit opt-in later
  await b.db
    .prepare(`INSERT INTO slack_links (channel_id, team_id, channel_name, board_id, lane, shared, created_by, created_at, audience_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(ch.id, o.team, ch.name.slice(0, 80), o.board.id, lane, shared ? 1 : 0, o.user, b.now(), b.now())
    .run();
  await b.board.setSlack(o.board.id, true);
  const url = entryUrl(b, o.board.id);
  const intro: core.SlackMessage = {
    text: `#${core.esc(ch.name)} now follows ${core.esc(o.board.title)}.`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", verbatim: true, text: `#${core.esc(ch.name)} now follows *${core.esc(o.board.title)}*. Reply in a thread here to post on the board as yourself.` } },
      {
        type: "context",
        elements: [{ type: "mrkdwn", verbatim: true, text: lane === "decisions" ? "Questions, approvals and handoffs show here; everything else is in one digest. Type /atteo for what's waiting on you." : "Every post on the board shows here. Type /atteo for what's waiting on you." }],
      },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in Atteo" }, url, action_id: "open" }] },
    ],
  };
  await b.enqueue(o.team, [{ kind: "call", channel: ch.id, method: "chat.postMessage", body: { channel: ch.id, ...core.postFields(intro) } }]);
  const inst = await installOf(b, o.team);
  await b.board.notice(o.board.id, o.user, `Connected to Slack: #${ch.name}${inst ? ` (${inst.team_name})` : ""} now follows this board (${lane === "decisions" ? "decisions and a digest" : "everything"}).`).catch(() => {});
  return null;
}

export async function unlinkChannel(b: Bridge, l: LinkRow, by: string, say = true): Promise<void> {
  await b.db.batch([
    b.db.prepare(`DELETE FROM slack_links WHERE channel_id = ?`).bind(l.channel_id),
    b.db.prepare(`DELETE FROM slack_messages WHERE channel_id = ? AND board_id = ?`).bind(l.channel_id, l.board_id),
  ]);
  const left = await b.db.prepare(`SELECT COUNT(*) AS n FROM slack_links WHERE board_id = ?`).bind(l.board_id).first<{ n: number }>();
  if (!left?.n) await b.board.setSlack(l.board_id, false).catch(() => {});
  const title = (await boardRow(b, l.board_id))?.title ?? "the board";
  if (say && l.paused !== "disconnected") await b.enqueue(l.team_id, [{ kind: "call", channel: l.channel_id, method: "chat.postMessage", body: { channel: l.channel_id, ...core.postFields({ text: `This channel no longer follows ${core.esc(title)}.`, blocks: [{ type: "context", elements: [{ type: "mrkdwn", verbatim: true, text: `This channel no longer follows *${core.esc(title)}*.` }] }] }) } }]);
  await b.board.notice(l.board_id, by, `Disconnected from Slack: #${l.channel_name} no longer follows this board.`).catch(() => {});
}

async function pauseChannel(b: Bridge, channel: string, why: "archived" | "removed" | "shared", say: string): Promise<void> {
  const l = await b.db.prepare(`SELECT * FROM slack_links WHERE channel_id = ?`).bind(channel).first<LinkRow>();
  if (!l || l.paused === why) return;
  await b.db.prepare(`UPDATE slack_links SET paused = ? WHERE channel_id = ?`).bind(why, channel).run();
  await b.board.notice(l.board_id, l.created_by, `Slack: the bridge to #${l.channel_name} is paused (${say}). The board's owner can resume it from ⋯ → Connect Slack.`).catch(() => {});
}

// ---- requests from Slack ----

const empty = () => new Response(null, { status: 200 });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
type Later = { waitUntil(p: Promise<unknown>): void };
const logged = (what: string) => (e: unknown) => console.error(`slack ${what} failed`, e);

/** /slack/events, /slack/commands and /slack/interactivity: checked, deduped, acknowledged at once. */
export async function inbound(request: Request, b: Bridge, ctx: Later, kind: "events" | "commands" | "interactivity"): Promise<Response> {
  const raw = await request.text();
  const ok = await core.verify(core.signingSecret(b.env, request), request.headers.get("x-slack-request-timestamp"), request.headers.get("x-slack-signature"), raw, b.now());
  if (!ok.ok) return json({ error: ok.why }, 401);
  if (kind === "events") {
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "bad json" }, 400);
    }
    if (body?.type === "url_verification") return json({ challenge: String(body.challenge ?? "") });
    if (body?.type !== "event_callback" || !body.event_id) return empty();
    if (!(await firstSeen(b, `e:${body.event_id}`))) return empty();
    ctx.waitUntil(onEvent(b, body).catch(logged("event")));
    return empty();
  }
  const form = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
  if (kind === "commands") {
    ctx.waitUntil(onCommand(b, form).catch(logged("command")));
    return empty();
  }
  let payload: any;
  try {
    payload = JSON.parse(form.payload ?? "null");
  } catch {
    payload = null;
  }
  if (!payload) return json({ error: "no payload" }, 400);
  if (payload.type === "view_submission") return onSubmit(b, payload);
  if (payload.type === "block_actions") {
    if (payload.trigger_id && !(await firstSeen(b, `t:${payload.trigger_id}`))) return empty();
    ctx.waitUntil(onAction(b, payload).catch(logged("action")));
  }
  return empty();
}

export async function onEvent(b: Bridge, body: any): Promise<void> {
  const team = String(body.team_id ?? body.team?.id ?? "");
  const ev = body.event ?? {};
  const inst = await installOf(b, team);
  if (!inst) return;
  switch (ev.type) {
    case "message":
      return onThreadReply(b, team, ev);
    case "app_home_opened":
      if (ev.tab === "home" && ev.user) await publishHome(b, team, String(ev.user));
      return;
    case "app_uninstalled":
      return disconnected(b, team);
    case "tokens_revoked":
      if (Array.isArray(ev.tokens?.bot) && ev.tokens.bot.length) await disconnected(b, team);
      return;
    case "channel_archive":
    case "group_archive":
      return pauseChannel(b, String(ev.channel), "archived", "the channel was archived");
    case "channel_unarchive":
    case "group_unarchive":
      await b.db.prepare(`UPDATE slack_links SET paused = NULL WHERE channel_id = ? AND paused = 'archived'`).bind(String(ev.channel)).run();
      return;
    case "member_left_channel":
      if (ev.user === inst.bot_user_id) await pauseChannel(b, String(ev.channel), "removed", "Atteo was removed from the channel");
      return;
    case "group_left":
      return pauseChannel(b, String(ev.channel), "removed", "Atteo was removed from the channel");
    case "channel_deleted":
    case "group_deleted": {
      const l = await b.db.prepare(`SELECT * FROM slack_links WHERE channel_id = ?`).bind(String(ev.channel)).first<LinkRow>();
      if (l) await unlinkChannel(b, l, l.created_by, false);
      return;
    }
    case "channel_shared":
      await b.db.prepare(`UPDATE slack_links SET shared = 1, lane = 'decisions' WHERE channel_id = ?`).bind(String(ev.channel)).run();
      return pauseChannel(b, String(ev.channel), "shared", "the channel is now shared with another organization: confirm who can read it");
    case "channel_unshared":
      await b.db.prepare(`UPDATE slack_links SET shared = 0, paused = CASE WHEN paused = 'shared' THEN NULL ELSE paused END WHERE channel_id = ?`).bind(String(ev.channel)).run();
      return;
  }
}

/** The app was uninstalled or its token revoked: the token goes, links stop; people's links stay 30 days for a reinstall. */
async function disconnected(b: Bridge, team: string): Promise<void> {
  const links = (await b.db.prepare(`SELECT * FROM slack_links WHERE team_id = ? AND (paused IS NULL OR paused != 'disconnected')`).bind(team).all<LinkRow>()).results;
  await revoke(b.db, team, b.now());
  for (const l of links) await b.board.notice(l.board_id, l.created_by, `Slack disconnected: Atteo was removed from the workspace, so #${l.channel_name} no longer gets this board. Connect Slack again from ⋯ to resume.`).catch(() => {});
}

/** A reply in a bridged thread: posted on the board as its linked person, in reply to the thread's root. */
async function onThreadReply(b: Bridge, team: string, ev: any): Promise<void> {
  if (ev.bot_id || ev.subtype || !ev.thread_ts || ev.thread_ts === ev.ts || !ev.user || !ev.channel) return;
  const l = await b.db.prepare(`SELECT * FROM slack_links WHERE channel_id = ? AND team_id = ?`).bind(String(ev.channel), team).first<LinkRow>();
  if (!l || l.paused) return;
  const root = await b.db.prepare(`SELECT seq FROM slack_messages WHERE channel_id = ? AND ts = ? AND board_id = ?`).bind(l.channel_id, String(ev.thread_ts), l.board_id).first<{ seq: number }>();
  if (!root) return; // a thread on something that isn't a board entry (the digest, the intro)
  const key = `m:${l.channel_id}:${ev.ts}`;
  if (!(await firstSeen(b, key))) return;
  const user = String(ev.user);
  const me = await personOf(b, team, user);
  const tell = (m: core.SlackMessage) => b.call(team, "chat.postEphemeral", { channel: l.channel_id, user, thread_ts: String(ev.thread_ts), ...core.postFields(m) });
  if (!me) return void (await tell(await connectMessage(b, team, user, null, null, "Your reply isn't on the board yet: link your Atteo account once, then reply again.")));
  const role = await roleOf(b, l.board_id, me);
  if (!role || role === "viewer") return void (await tell(plain(`Your reply wasn't posted: you're ${role ? "a viewer" : "not a member"} on this board in Atteo.`)));
  const text = core.fromSlack(String(ev.text ?? ""), await peopleOf(b, team));
  if (!text) return;
  try {
    const seq = await b.board.post(l.board_id, me, { type: "note", text, reply_to: root.seq }, l.channel_id);
    await b.db.prepare(`UPDATE slack_seen SET seq = ? WHERE key = ?`).bind(seq, key).run();
  } catch (e) {
    await tell(plain(`Your reply wasn't posted: ${e instanceof Error ? e.message : String(e)}`));
  }
}

const plain = (text: string): core.SlackMessage => ({ text: core.esc(text), blocks: [{ type: "section", text: { type: "mrkdwn", verbatim: true, text: core.esc(text) } }] });

/**
 * Links a Slack account to an Atteo person, and tells the person in their inbox (with where to unlink it). Never
 * replaces a link: a Slack account already linked to someone else stays theirs until they unlink it (#5438).
 */
async function linkPerson(b: Bridge, o: { team: string; slackUser: string; enterprise: string | null; user: string; slackName: string | null }): Promise<"linked" | "same" | "taken"> {
  const r = await b.db
    .prepare(`INSERT INTO slack_people (team_id, slack_user, enterprise_id, user, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(team_id, slack_user) DO NOTHING`)
    .bind(o.team, o.slackUser, o.enterprise, o.user, b.now())
    .run();
  if (!(r.meta?.changes ?? 0)) return (await personOf(b, o.team, o.slackUser)) === o.user ? "same" : "taken";
  const inst = await installOf(b, o.team);
  const who = `${o.slackName ? `@${o.slackName}` : o.slackUser}${inst ? ` (${inst.team_name})` : ""}`;
  await b.db
    .prepare(`INSERT INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at, read_at) VALUES (?, '', ?, 'slack_link', ?, 'person', 'slack_link', ?, ?, NULL)`)
    .bind(o.user, offBoardSeq(), o.user, `Slack ${who} now acts as you on Atteo. Not you? Unlink it in Slack accounts.`.slice(0, 180), b.now())
    .run()
    .catch(logged("slack link notice"));
  return "linked";
}

/** "Connect your Atteo account": a single-use link to a signed-in page that makes the link. */
async function connectMessage(b: Bridge, team: string, slackUser: string, slackName: string | null, enterprise: string | null, why = "Link your Slack account to Atteo once, so replies and buttons here act as you."): Promise<core.SlackMessage> {
  let name = slackName;
  if (!name) {
    const u = await b.call(team, "users.info", { user: slackUser }).catch(() => null);
    name = (u?.ok && (u.user as any)?.name) || null;
  }
  const n = await newNonce(b, { kind: "person", team_id: team, slack_user: slackUser, slack_name: name, enterprise_id: enterprise });
  return {
    text: "Connect your Atteo account",
    blocks: [
      { type: "section", text: { type: "mrkdwn", verbatim: true, text: core.esc(why) } },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Connect your Atteo account" }, url: `${b.origin}/slack/link/${n}`, action_id: "open", style: "primary" }] },
      { type: "context", elements: [{ type: "mrkdwn", verbatim: true, text: "The link works once, for 10 minutes, and only for you." }] },
    ],
  };
}

// ---- /atteo ----

const HELP = [
  "`/atteo` what's waiting on you",
  "`/atteo link [board]` this channel follows a board you own",
  "`/atteo unlink` stop it",
  "`/atteo lane decisions|everything` what shows here",
  "`/atteo ask <question>` ask the board's agents",
  "`/atteo who` which agents are working now",
  "`/atteo signout` unlink your Slack account from Atteo",
].join("\n");

export async function onCommand(b: Bridge, f: Record<string, string>): Promise<void> {
  const team = f.team_id ?? "";
  const reply = (m: core.SlackMessage) => b.respond(team, f.response_url ?? "", { response_type: "ephemeral", replace_original: false, ...core.postFields(m) });
  const inst = await installOf(b, team);
  if (!inst || inst.revoked_at) return reply(plain("Atteo isn't connected to this workspace any more. Connect Slack again from a board's ⋯ menu."));
  const me = await personOf(b, team, f.user_id ?? "");
  if (!me) return reply(await connectMessage(b, team, f.user_id ?? "", f.user_name ?? null, f.enterprise_id || null));
  const [cmd = "", ...rest] = (f.text ?? "").trim().split(/\s+/);
  const arg = rest.join(" ").trim();
  const channel = f.channel_id ?? "";
  switch (cmd.toLowerCase()) {
    case "":
    case "waiting":
      return reply(await waitingMessage(b, team, me));
    case "link":
      return reply(await linkCommand(b, team, channel, me, arg));
    case "unlink":
      return reply(await unlinkCommand(b, channel, me));
    case "lane":
      return reply(await laneCommand(b, channel, me, arg));
    case "ask":
      return reply(await askCommand(b, channel, me, arg));
    case "who":
      return reply(await whoCommand(b, channel));
    case "signout":
      await b.db.prepare(`DELETE FROM slack_people WHERE team_id = ? AND slack_user = ?`).bind(team, f.user_id ?? "").run();
      return reply(plain(`Unlinked: this Slack account no longer acts as ${me} on Atteo.`));
    default:
      return reply({ text: "Atteo commands", blocks: [{ type: "section", text: { type: "mrkdwn", verbatim: true, text: HELP } }] });
  }
}

const linkOfChannel = (b: Bridge, channel: string) => b.db.prepare(`SELECT * FROM slack_links WHERE channel_id = ?`).bind(channel).first<LinkRow>();

async function linkCommand(b: Bridge, team: string, channel: string, me: string, arg: string): Promise<core.SlackMessage> {
  const l = await linkOfChannel(b, channel);
  if (l) return plain(`This channel already follows ${(await boardRow(b, l.board_id))?.title ?? "a board"}.`);
  const mine = (
    await b.db
      .prepare(
        `SELECT b.id, b.title FROM boards b JOIN members m ON m.board_id = b.id AND m.user = ? AND m.role = 'owner' WHERE b.deleted_at IS NULL AND b.archived_at IS NULL AND b.encrypted = 0 AND (b.kind IS NULL OR b.kind = 'board') ORDER BY b.last_activity DESC LIMIT 40`,
      )
      .bind(me)
      .all<{ id: string; title: string }>()
  ).results.filter((x) => !arg || x.id === arg || x.title.toLowerCase().includes(arg.toLowerCase())).slice(0, 10);
  if (!mine.length) return plain(arg ? `None of the boards you own matches "${arg}".` : "You don't own a board that can be connected (encrypted boards, DMs and \"Your agent\" can't be).");
  return {
    text: "Which board should this channel follow?",
    blocks: [
      { type: "section", text: { type: "mrkdwn", verbatim: true, text: "Which board should this channel follow? Everyone in the channel will see its questions, approvals and handoffs; only the board's members can act on them." } },
      ...mine.map((x) => ({ type: "section", text: { type: "mrkdwn", verbatim: true, text: `*${core.esc(x.title)}*` }, accessory: { type: "button", text: { type: "plain_text", text: "Link" }, action_id: "link_board", value: x.id } })),
    ],
  };
}

async function ownerOf(b: Bridge, channel: string, me: string): Promise<{ l: LinkRow } | core.SlackMessage> {
  const l = await linkOfChannel(b, channel);
  if (!l) return plain("This channel doesn't follow a board. /atteo link connects one.");
  if ((await roleOf(b, l.board_id, me)) !== "owner") return plain("Only the board's owner can change this.");
  return { l };
}

async function unlinkCommand(b: Bridge, channel: string, me: string): Promise<core.SlackMessage> {
  const o = await ownerOf(b, channel, me);
  if (!("l" in o)) return o;
  await unlinkChannel(b, o.l, me);
  return plain(`Unlinked: #${o.l.channel_name} no longer follows the board.`);
}

async function laneCommand(b: Bridge, channel: string, me: string, arg: string): Promise<core.SlackMessage> {
  const o = await ownerOf(b, channel, me);
  if (!("l" in o)) return o;
  const [want, confirm] = arg.toLowerCase().split(/\s+/);
  if (want !== "decisions" && want !== "everything") return plain(`This channel shows ${o.l.lane}. /atteo lane decisions or /atteo lane everything.`);
  if (want === "everything" && o.l.shared && confirm !== "confirm") return plain("This channel is shared with other organizations. To show them every post, run /atteo lane everything confirm.");
  await b.db.prepare(`UPDATE slack_links SET lane = ? WHERE channel_id = ?`).bind(want, channel).run();
  return plain(want === "everything" ? "Every post on the board now shows here." : "Only decisions show here now; the rest goes in the digest.");
}

async function askCommand(b: Bridge, channel: string, me: string, arg: string): Promise<core.SlackMessage> {
  const l = await linkOfChannel(b, channel);
  if (!l || l.paused) return plain("This channel doesn't follow a board. /atteo link connects one.");
  if (!arg) return plain("Ask what? /atteo ask <your question>");
  const role = await roleOf(b, l.board_id, me);
  if (!role || role === "viewer") return plain(`You can't post on this board: you're ${role ? "a viewer" : "not a member"} there.`);
  const seq = await b.board.post(l.board_id, me, { type: "question", text: `@agents ${arg}` }, null);
  return plain(`Asked the board's agents (#${seq}). Their answers will show in its thread.`);
}

async function whoCommand(b: Bridge, channel: string): Promise<core.SlackMessage> {
  const l = await linkOfChannel(b, channel);
  if (!l) return plain("This channel doesn't follow a board. /atteo link connects one.");
  const agents = await b.board.agents(l.board_id);
  if (!agents.length) return plain("No agents are working on the board right now.");
  return plain(`Working now: ${agents.map((a) => `${a.user}'s agent${a.name ? ` (${a.name}${a.client ? `, ${a.client}` : ""})` : ""}`).join(", ")}`);
}

/** What's waiting on this person: their pending approvals, then open decisions and questions naming them on bridged boards. */
async function waitingItems(b: Bridge, team: string, me: string) {
  const aps = await approvals.listApprovals({ DB: b.db } as Env, me, "pending");
  const boards = (await b.db.prepare(`SELECT DISTINCT l.board_id AS id, bo.title AS title FROM slack_links l JOIN boards bo ON bo.id = l.board_id WHERE l.team_id = ?`).bind(team).all<{ id: string; title: string }>()).results;
  const asks: { board: string; title: string; seq: number; what: string; kind: "decision" | "question" }[] = [];
  for (const bd of boards.slice(0, 10)) {
    if (!(await roleOf(b, bd.id, me))) continue;
    const f = await b.board.forYou(bd.id, me, b.now() - 26 * 3600_000);
    if (!f) continue;
    for (const d of f.decisions) asks.push({ board: bd.id, title: bd.title, seq: d.seq, what: d.title, kind: "decision" });
    for (const q of f.questions) asks.push({ board: bd.id, title: bd.title, seq: q.seq, what: q.title, kind: "question" });
  }
  return { aps, asks, boards };
}

function waitingBlocks(b: Bridge, w: Awaited<ReturnType<typeof waitingItems>>): unknown[] {
  const blocks: unknown[] = [];
  // Each approval as its DM shows it: the whole request, and Approve / Deny only when all of it fits (#5438).
  for (const a of w.aps.slice(0, 8)) blocks.push(...core.approvalDm(a, { boardTitle: null, url: `${b.origin}/approvals#${a.id}`, asker: approvals.askerOf(a) }).blocks);
  for (const q of w.asks.slice(0, 10)) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", verbatim: true, text: `${q.kind === "decision" ? "🗳️" : "❓"} ${core.esc(q.what)} · ${core.esc(q.title)}` },
      accessory: { type: "button", text: { type: "plain_text", text: "Open" }, url: entryUrl(b, q.board, q.seq), action_id: "open" },
    });
  }
  return blocks;
}

async function waitingMessage(b: Bridge, team: string, me: string): Promise<core.SlackMessage> {
  const w = await waitingItems(b, team, me);
  const blocks = waitingBlocks(b, w);
  if (!blocks.length) return plain("Nothing's waiting on you.");
  return { text: "Waiting on you", blocks: [{ type: "header", text: { type: "plain_text", text: "Waiting on you" } }, ...blocks] };
}

/** App Home: what's waiting on you, your bridged boards with unread counts, and who you're linked as. */
export async function publishHome(b: Bridge, team: string, slackUser: string): Promise<void> {
  const me = await personOf(b, team, slackUser);
  let blocks: unknown[];
  if (!me) {
    const c = await connectMessage(b, team, slackUser, null, null, "Link your Slack account to Atteo to see what's waiting on you and act on it here.");
    blocks = [{ type: "header", text: { type: "plain_text", text: "Atteo" } }, ...c.blocks];
  } else {
    const w = await waitingItems(b, team, me);
    const waiting = waitingBlocks(b, w);
    blocks = [{ type: "header", text: { type: "plain_text", text: "Waiting on you" } }, ...(waiting.length ? waiting : [{ type: "context", elements: [{ type: "mrkdwn", text: "Nothing's waiting on you." }] }]), { type: "divider" }, { type: "header", text: { type: "plain_text", text: "Your boards" } }];
    let any = false;
    for (const bd of w.boards.slice(0, 15)) {
      if (!(await roleOf(b, bd.id, me))) continue;
      any = true;
      const unread = (await b.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user = ? AND board_id = ? AND read_at IS NULL`).bind(me, bd.id).first<{ n: number }>())?.n ?? 0;
      const chans = (await b.db.prepare(`SELECT channel_name FROM slack_links WHERE board_id = ? AND team_id = ?`).bind(bd.id, team).all<{ channel_name: string }>()).results.map((c) => `#${core.esc(c.channel_name)}`);
      blocks.push({ type: "section", text: { type: "mrkdwn", verbatim: true, text: `*${core.esc(bd.title)}* · ${chans.join(", ")}${unread ? ` · ${unread} unread` : ""}` }, accessory: { type: "button", text: { type: "plain_text", text: "Open" }, url: entryUrl(b, bd.id), action_id: "open" } });
    }
    if (!any) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "No board follows a channel you're in yet. A board's owner connects one from its ⋯ menu, or /atteo link." }] });
    blocks.push({ type: "divider" }, { type: "context", elements: [{ type: "mrkdwn", verbatim: true, text: `Linked to Atteo as *${core.esc(me)}*. /atteo signout unlinks.` }] });
  }
  await b.call(team, "views.publish", { user_id: slackUser, view: { type: "home", blocks: blocks.slice(0, 100) } });
}

// ---- buttons and the answer form ----

/** Tells the person who clicked: in the conversation (response_url) or, from App Home, by DM. */
async function tellClicker(b: Bridge, team: string, payload: any, m: core.SlackMessage): Promise<void> {
  if (payload.response_url) await b.respond(team, payload.response_url, { response_type: "ephemeral", replace_original: false, ...core.postFields(m) });
  else await b.call(team, "chat.postMessage", { channel: payload.user?.id, ...core.postFields(m) });
}

export async function onAction(b: Bridge, payload: any): Promise<void> {
  const team = String(payload.team?.id ?? payload.user?.team_id ?? "");
  const slackUser = String(payload.user?.id ?? "");
  const act = payload.actions?.[0];
  if (!act || !team || !slackUser) return;
  const inst = await installOf(b, team);
  if (!inst || inst.revoked_at) return;
  switch (act.action_id) {
    case "approve":
    case "deny":
      return decideFromSlack(b, team, slackUser, String(act.value ?? ""), act.action_id === "approve", payload);
    case "answer":
      return openAnswer(b, team, slackUser, String(act.value ?? ""), payload);
    case "link_board":
    case "link_board_confirm":
      return linkFromButton(b, team, slackUser, String(act.value ?? ""), payload, act.action_id === "link_board_confirm");
  }
}

/**
 * Approve / Deny from Slack. The button carries only the approval id; the clicker must be the Atteo person linked to
 * this Slack person in this workspace, and the approval theirs. Agents can't press: a click is a person's, signed by
 * Slack, and no bot or agent token ever reaches decide. High risk is decided in Atteo only.
 */
export async function decideFromSlack(b: Bridge, team: string, slackUser: string, id: string, approve: boolean, payload: any): Promise<void> {
  const me = await personOf(b, team, slackUser);
  if (!me) return tellClicker(b, team, payload, await connectMessage(b, team, slackUser, null, null, "Link your Atteo account first: then your buttons here decide as you."));
  const a = /^ap_[A-Za-z0-9_-]+$/.test(id) ? await b.db.prepare(`SELECT * FROM approvals WHERE id = ?`).bind(id).first<approvals.Approval>() : null;
  if (!a) return tellClicker(b, team, payload, plain("No such approval."));
  if (a.user !== me) return tellClicker(b, team, payload, plain(`Not yours: only ${a.user} can decide this.`));
  const url = `${b.origin}/approvals#${a.id}`;
  // High risk, or too long to have shown whole in Slack: decided in Atteo only, whatever an old message offered.
  if (!core.decidableInSlack(a)) {
    const why = a.risk === "high" ? "High-risk approvals are decided in Atteo, where the whole command or diff is." : "This one is too long to show in Slack in full, so it's decided in Atteo, where all of it is.";
    return tellClicker(b, team, payload, { text: "Decide in Atteo", blocks: [{ type: "section", text: { type: "mrkdwn", verbatim: true, text: why }, accessory: { type: "button", text: { type: "plain_text", text: "Review in Atteo" }, url, action_id: "open" } }] });
  }
  let decided: approvals.Approval;
  try {
    decided = await approvals.decide({ DB: b.db } as Env, me, a.id, approve, "", null, `slack:${team}/${slackUser}`);
  } catch (e) {
    return tellClicker(b, team, payload, plain(e instanceof Error ? e.message : String(e)));
  }
  if (decided.board_id) await b.board.approvalDecided(decided.board_id, approvals.refOf(decided)).catch(logged("approval event"));
  // The message clicked shows the decision with its buttons gone (the DM is also updated from the board, by the same rule).
  const msg = core.approvalDm({ ...decided }, { boardTitle: decided.board_id ? ((await boardRow(b, decided.board_id))?.title ?? null) : null, url, asker: approvals.askerOf(decided), via: `slack:${team}/${slackUser}` });
  if (payload.response_url && payload.container?.type === "message") await b.respond(team, payload.response_url, { replace_original: true, ...core.postFields(msg) });
  if (payload.view?.type === "home") await publishHome(b, team, slackUser).catch(() => {});
}

async function openAnswer(b: Bridge, team: string, slackUser: string, value: string, payload: any): Promise<void> {
  const m = value.match(/^(b_[a-z0-9]{8,32}):(\d+)$/);
  if (!m) return;
  const me = await personOf(b, team, slackUser);
  if (!me) return tellClicker(b, team, payload, await connectMessage(b, team, slackUser, null, null, "Link your Atteo account first: then you can answer here as yourself."));
  const role = await roleOf(b, m[1], me);
  if (!role || role === "viewer") return tellClicker(b, team, payload, plain(`You can't answer: you're ${role ? "a viewer" : "not a member"} on this board in Atteo.`));
  await b.call(team, "views.open", {
    trigger_id: payload.trigger_id,
    view: {
      type: "modal",
      callback_id: "answer",
      private_metadata: JSON.stringify({ board: m[1], seq: Number(m[2]) }),
      title: { type: "plain_text", text: "Answer" },
      submit: { type: "plain_text", text: "Post" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [{ type: "input", block_id: "a", label: { type: "plain_text", text: `Your answer, posted on Atteo as ${me}` }, element: { type: "plain_text_input", action_id: "text", multiline: true, max_length: 4000 } }],
    },
  });
}

/** The answer form, submitted: posted as the person in reply to the question (the board bridges it into the thread). */
export async function onSubmit(b: Bridge, payload: any): Promise<Response> {
  if (payload.view?.callback_id !== "answer") return empty();
  const team = String(payload.team?.id ?? payload.user?.team_id ?? "");
  const errors = (msg: string) => json({ response_action: "errors", errors: { a: msg } });
  let meta: { board?: string; seq?: number } = {};
  try {
    meta = JSON.parse(payload.view.private_metadata ?? "{}");
  } catch {}
  if (!meta.board || !/^b_[a-z0-9]{8,32}$/.test(meta.board) || !Number.isInteger(meta.seq)) return errors("This form is out of date.");
  const me = await personOf(b, team, String(payload.user?.id ?? ""));
  if (!me) return errors("Link your Atteo account first: type /atteo.");
  const role = await roleOf(b, meta.board, me);
  if (!role || role === "viewer") return errors(`You can't post on this board: you're ${role ? "a viewer" : "not a member"} there.`);
  const text = String(payload.view.state?.values?.a?.text?.value ?? "").trim();
  if (!text) return errors("Write an answer.");
  try {
    await b.board.post(meta.board, me, { type: "note", text, reply_to: meta.seq! }, null);
  } catch (e) {
    return errors((e instanceof Error ? e.message : String(e)).slice(0, 150));
  }
  return empty();
}

/**
 * /atteo link's Link button. Like the web picker, a channel with more people than the board, or shared with other
 * organizations, asks once more who will read it (#5439) before anything is posted there.
 */
async function linkFromButton(b: Bridge, team: string, slackUser: string, board: string, payload: any, confirmed = false): Promise<void> {
  const me = await personOf(b, team, slackUser);
  if (!me) return;
  const row = await linkable(b, board, me);
  if (typeof row === "string") return tellClicker(b, team, payload, plain(row));
  const info = await b.call(team, "conversations.info", { channel: payload.channel?.id, include_num_members: true });
  if (!info.ok) return tellClicker(b, team, payload, plain(`Slack couldn't find this channel (${info.error ?? "error"}). Invite Atteo to it first.`));
  const ch = info.channel as ChannelInfo;
  const members = (await b.db.prepare(`SELECT COUNT(*) AS n FROM members WHERE board_id = ?`).bind(row.id).first<{ n: number }>())?.n ?? 0;
  if (!confirmed && (ch.is_ext_shared || (ch.num_members ?? 0) > members)) {
    const who = `#${ch.name} has ${ch.num_members ?? "several"} people${ch.is_ext_shared ? " and is shared with other organizations" : ""}; ${row.title} has ${members} ${members === 1 ? "member" : "members"}.`;
    const ask: core.SlackMessage = {
      text: "Who will read it?",
      blocks: [
        { type: "section", text: { type: "mrkdwn", verbatim: true, text: core.esc(`*Who will read it?* ${who} Everyone in the channel will see the board's questions, approval statuses and handoffs, and a digest of the rest. Only the board's members can answer or decide.`) } },
        { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: `Connect #${core.plainName(ch.name, 60)}` }, action_id: "link_board_confirm", value: row.id, style: "primary" }] },
      ],
    };
    if (payload.response_url) return b.respond(team, payload.response_url, { replace_original: true, ...core.postFields(ask) });
    return tellClicker(b, team, payload, ask);
  }
  const why = await linkChannel(b, { team, channel: ch, board: row, user: me, lane: "decisions" });
  const m = plain(why ?? `Linked: this channel now follows ${row.title}.`);
  if (payload.response_url) await b.respond(team, payload.response_url, { replace_original: true, ...core.postFields(m) });
}

// ---- the cron (every 5 minutes): digests that waited, the daily audience check, cleanup ----

export async function cron(env: Env, now = Date.now()): Promise<void> {
  if (!core.slackOn(env)) return;
  await sweep(bridgeFor(env), now);
}

export async function sweep(b: Bridge, now: number): Promise<void> {
  const due = (
    await b.db
      .prepare(`SELECT l.channel_id, l.team_id, l.board_id, bo.title FROM slack_links l JOIN boards bo ON bo.id = l.board_id WHERE l.paused IS NULL AND (l.pending_n > 0 OR l.pending_flagged > 0 OR l.pending_missed > 0) AND (l.flushed_at IS NULL OR l.flushed_at < ?) LIMIT 100`)
      .bind(now - core.DIGEST_EVERY_MS)
      .all<{ channel_id: string; team_id: string; board_id: string; title: string }>()
  ).results;
  for (const d of due) if (await claimFlush(b, d.channel_id)) await b.enqueue(d.team_id, [{ kind: "digest", channel: d.channel_id, board: d.board_id, title: d.title, url: entryUrl(b, d.board_id) }]);
  // Once a day: is the channel now shared with another organization, archived, or gone? (Slack's events say so too.)
  const check = (await b.db.prepare(`SELECT * FROM slack_links WHERE paused IS NULL AND (audience_at IS NULL OR audience_at < ?) LIMIT 20`).bind(now - 24 * 3600_000).all<LinkRow>()).results;
  for (const l of check) {
    await b.db.prepare(`UPDATE slack_links SET audience_at = ? WHERE channel_id = ?`).bind(now, l.channel_id).run();
    const r = await b.call(l.team_id, "conversations.info", { channel: l.channel_id }).catch(() => null);
    if (!r) continue;
    const ch = r.channel as ChannelInfo | undefined;
    if (!r.ok && (r.error === "channel_not_found" || r.error === "not_in_channel")) await pauseChannel(b, l.channel_id, "removed", "Atteo can't see the channel any more");
    else if (ch?.is_archived) await pauseChannel(b, l.channel_id, "archived", "the channel was archived");
    else if (ch?.is_ext_shared && !l.shared) {
      await b.db.prepare(`UPDATE slack_links SET shared = 1, lane = 'decisions' WHERE channel_id = ?`).bind(l.channel_id).run();
      await pauseChannel(b, l.channel_id, "shared", "the channel is now shared with another organization: confirm who can read it");
    } else if (ch && !ch.is_ext_shared && l.shared) await b.db.prepare(`UPDATE slack_links SET shared = 0 WHERE channel_id = ?`).bind(l.channel_id).run();
  }
  const month = now - 30 * 86_400_000;
  await b.db.batch([
    b.db.prepare(`DELETE FROM slack_nonces WHERE expires_at < ?`).bind(now),
    b.db.prepare(`DELETE FROM slack_seen WHERE at < ?`).bind(now - core.SEEN_MS),
    // Uninstalled a month ago and not reinstalled: people's links and the workspace's links go too.
    b.db.prepare(`DELETE FROM slack_people WHERE team_id IN (SELECT team_id FROM slack_installs WHERE revoked_at < ?)`).bind(month),
    b.db.prepare(`DELETE FROM slack_links WHERE team_id IN (SELECT team_id FROM slack_installs WHERE revoked_at < ?)`).bind(month),
    b.db.prepare(`DELETE FROM slack_messages WHERE team_id IN (SELECT team_id FROM slack_installs WHERE revoked_at < ?)`).bind(month),
    b.db.prepare(`DELETE FROM slack_installs WHERE revoked_at < ?`).bind(month),
  ]);
}

// ---- pages (people signed in on Atteo) ----

function msgPage(viewer: Viewer, title: string, text: string, status = 200, extra = ""): Response {
  return page(`${title} · Atteo`, `<div class="card pad" style="max-width:520px;margin:24px auto 0"><h1 style="font-size:20px">${html(title)}</h1><p class="muted" style="margin-top:8px">${html(text)}</p>${extra}</div>`, { viewer, narrow: true, status });
}

const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to, "cache-control": "no-store" } });

/** The board menu's Connect Slack: straight to Slack's consent screen (or this board's Slack settings, when it has a channel). */
export async function connectPage(b: Bridge, viewer: Viewer, url: URL, request: Request): Promise<Response> {
  const board = url.searchParams.get("board") ?? "";
  const row = await linkable(b, board, viewer.name);
  if (typeof row === "string") return msgPage(viewer, "Can't connect Slack", row, 400);
  if (!url.searchParams.has("add")) {
    const n = await b.db.prepare(`SELECT COUNT(*) AS n FROM slack_links WHERE board_id = ?`).bind(board).first<{ n: number }>();
    if (n?.n) return redirect(`/slack/board/${board}`);
  }
  const nonce = await newNonce(b, { kind: "install", user: viewer.name, board_id: board });
  if (core.fakeSlack(b.env, request)) return redirect(`/slack/oauth?code=${encodeURIComponent(`fake:${url.searchParams.get("fake_user") ?? "U0FAKEOWNER"}`)}&state=${nonce}`);
  const q = new URLSearchParams({ client_id: b.env.SLACK_CLIENT_ID ?? "", scope: core.BOT_SCOPES, redirect_uri: `${b.origin}/slack/oauth`, state: nonce });
  return redirect(`https://slack.com/oauth/v2/authorize?${q}`);
}

/** Back from Slack's consent screen: the workspace is installed, its installer linked, and the channel picker shows. */
export async function oauthDone(b: Bridge, viewer: Viewer, url: URL): Promise<Response> {
  const n = await takeNonce(b, url.searchParams.get("state") ?? "", "install");
  if (url.searchParams.get("error")) return msgPage(viewer, "Slack wasn't connected", url.searchParams.get("error") === "access_denied" ? "You cancelled on Slack's side. Nothing changed." : `Slack said: ${url.searchParams.get("error")}.`);
  if (!n || n.user !== viewer.name || !n.board_id) return msgPage(viewer, "This link expired", "Start again from the board's ⋯ menu → Connect Slack.", 400);
  const r = await b.oauth(url.searchParams.get("code") ?? "", `${b.origin}/slack/oauth`);
  if (!r.ok || !r.team?.id || !r.access_token || !r.bot_user_id) return msgPage(viewer, "Slack wasn't connected", `Slack said: ${r.error ?? "no token"}. Try again from the board's ⋯ menu.`, 502);
  const team = r.team.id;
  await b.db
    .prepare(
      `INSERT INTO slack_installs (team_id, enterprise_id, team_name, bot_user_id, bot_token, created_by, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(team_id) DO UPDATE SET enterprise_id = excluded.enterprise_id, team_name = excluded.team_name, bot_user_id = excluded.bot_user_id, bot_token = excluded.bot_token, revoked_at = NULL`,
    )
    .bind(team, r.enterprise?.id ?? null, String(r.team.name ?? team).slice(0, 120), r.bot_user_id, await core.sealToken(b.env, r.access_token), viewer.name, b.now())
    .run();
  // The installer signed in to both: that's the person link, made here.
  // (Slack's own consent screen proved who they are; a Slack account already linked to someone else stays theirs.)
  if (r.authed_user?.id) await linkPerson(b, { team, slackUser: r.authed_user.id, enterprise: r.enterprise?.id ?? null, user: viewer.name, slackName: null });
  await b.db.prepare(`UPDATE slack_links SET paused = NULL WHERE team_id = ? AND paused = 'disconnected'`).bind(team).run();
  return pickerPage(b, viewer, n.board_id, team);
}

async function pickerPage(b: Bridge, viewer: Viewer, board: string, team: string, error?: string): Promise<Response> {
  const row = await boardRow(b, board);
  const list = await b.call(team, "conversations.list", { types: "public_channel,private_channel", exclude_archived: true, limit: 200 });
  if (!list.ok) return msgPage(viewer, "Slack wasn't connected", `Slack couldn't list channels (${list.error ?? "error"}).`, 502);
  const taken = new Set((await b.db.prepare(`SELECT channel_id FROM slack_links WHERE team_id = ?`).bind(team).all<{ channel_id: string }>()).results.map((x) => x.channel_id));
  const chans = ((list.channels as ChannelInfo[]) ?? []).filter((c) => !taken.has(c.id) && (!c.is_private || c.is_member)).slice(0, 200);
  const nonce = await newNonce(b, { kind: "pick", user: viewer.name, board_id: board, team_id: team });
  const opts = chans
    .map((c, i) => `<label class="row" style="gap:8px;padding:6px 0"><input type="radio" name="channel" value="${html(c.id)}"${i === 0 ? " checked" : ""}> <span>#${html(c.name)}</span>${c.is_ext_shared ? ` <span class="small muted">shared with other organizations: decisions only</span>` : ""}${c.is_private ? ` <span class="small muted">private</span>` : ""}</label>`)
    .join("");
  const body = `<div class="card pad" style="max-width:520px;margin:24px auto 0">
<p class="small muted">Connect Slack</p><h1 style="font-size:20px;margin-top:4px">Which channel should follow ${html(row?.title ?? board)}?</h1>
${error ? `<p class="flash err" style="margin-top:12px">${html(error)}</p>` : ""}
${chans.length ? `<form method="post" action="/slack/pick" style="margin-top:14px"><input type="hidden" name="nonce" value="${nonce}">
<fieldset style="border:0;padding:0;margin:0;max-height:320px;overflow:auto">${opts}</fieldset>
<p class="lbl" style="margin-top:14px">What shows in the channel</p>
<label class="row" style="gap:8px;padding:4px 0"><input type="radio" name="lane" value="decisions" checked> <span>Decisions: questions, approvals and handoffs; the rest in one digest</span></label>
<label class="row" style="gap:8px;padding:4px 0"><input type="radio" name="lane" value="everything"> <span>Everything: every post (small teams)</span></label>
<p class="small muted" style="margin-top:12px">Everyone in the channel can read what's posted there; only the board's members can act on it. Approval details go only to their owner, by DM.</p>
<div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn primary">Connect</button></div></form>`
    : `<p class="muted" style="margin-top:12px">No channel to pick: every channel Atteo can see already follows a board. For a private channel, invite Atteo first (/invite @Atteo).</p>`}
</div>`;
  return page("Connect Slack · Atteo", body, { viewer, narrow: true });
}

/** The picker, submitted. A channel with more people than the board, or shared with other organizations, asks once more. */
export async function pickChannel(b: Bridge, viewer: Viewer, form: Record<string, string>): Promise<Response> {
  const n = await takeNonce(b, form.nonce ?? "", "pick");
  if (!n || n.user !== viewer.name || !n.board_id || !n.team_id) return msgPage(viewer, "This link expired", "Start again from the board's ⋯ menu → Connect Slack.", 400);
  const row = await linkable(b, n.board_id, viewer.name);
  if (typeof row === "string") return msgPage(viewer, "Can't connect Slack", row, 400);
  const info = await b.call(n.team_id, "conversations.info", { channel: form.channel ?? "", include_num_members: true });
  if (!info.ok) return pickerPage(b, viewer, row.id, n.team_id, `Slack couldn't find that channel (${info.error ?? "error"}).`);
  const ch = info.channel as ChannelInfo;
  const lane: core.Lane = form.lane === "everything" ? "everything" : "decisions";
  const members = (await b.db.prepare(`SELECT COUNT(*) AS n FROM members WHERE board_id = ?`).bind(row.id).first<{ n: number }>())?.n ?? 0;
  if ((ch.is_ext_shared || (ch.num_members ?? 0) > members) && form.confirm !== "1") {
    const again = await newNonce(b, { kind: "pick", user: viewer.name, board_id: row.id, team_id: n.team_id });
    const who = `#${ch.name} has ${ch.num_members ?? "several"} people${ch.is_ext_shared ? " and is shared with other organizations" : ""}; ${row.title} has ${members} ${members === 1 ? "member" : "members"}.`;
    const what = ch.is_ext_shared || lane === "decisions" ? "its questions, approval statuses and handoffs, and a digest of the rest" : "every post on the board";
    return page(
      "Connect Slack · Atteo",
      `<div class="card pad" style="max-width:520px;margin:24px auto 0"><p class="small muted">Connect Slack</p><h1 style="font-size:20px;margin-top:4px">Who will read it?</h1>
<p style="margin-top:10px">${html(who)}</p><p class="muted" style="margin-top:8px">Everyone in the channel will see ${html(what)}. Only the board's members can answer or decide.</p>
<form method="post" action="/slack/pick" style="margin-top:16px"><input type="hidden" name="nonce" value="${again}"><input type="hidden" name="channel" value="${html(ch.id)}"><input type="hidden" name="lane" value="${lane}"><input type="hidden" name="confirm" value="1">
<div class="row" style="justify-content:flex-end;gap:8px"><a class="btn" href="/b/${html(row.id)}">Cancel</a><button class="btn primary">Connect #${html(ch.name)}</button></div></form></div>`,
      { viewer, narrow: true },
    );
  }
  const why = await linkChannel(b, { team: n.team_id, channel: ch, board: row, user: viewer.name, lane });
  if (why) return pickerPage(b, viewer, row.id, n.team_id, why);
  return msgPage(viewer, "Connected", `#${ch.name} now follows ${row.title}. Replies in its threads post here as their linked person.`, 200, `<div class="row" style="justify-content:flex-end;gap:8px;margin-top:16px"><a class="btn" href="/slack/board/${html(row.id)}">Slack settings</a><a class="btn primary" href="/b/${html(row.id)}">Back to the board</a></div>`);
}

/**
 * "Connect your Atteo account", signed in on Atteo. The link alone proves nothing (anyone can forward theirs), so the
 * person also signs in with Slack, and the Slack account they prove must be the one the link was made for (#5438).
 */
export async function personLinkPage(b: Bridge, viewer: Viewer, nonce: string, method: string, request?: Request): Promise<Response> {
  const n = method === "POST" ? await takeNonce(b, nonce, "person") : await peekNonce(b, nonce, "person");
  if (!n || !n.team_id || !n.slack_user) return msgPage(viewer, "This link expired", "Type /atteo in Slack for a new one.", 400);
  const inst = await installOf(b, n.team_id);
  const where = `${n.slack_name ? `@${n.slack_name}` : "your Slack account"}${inst ? ` (${inst.team_name})` : ""}`;
  if (method === "POST") {
    const state = await newNonce(b, { kind: "person_sso", user: viewer.name, team_id: n.team_id, slack_user: n.slack_user, slack_name: n.slack_name, enterprise_id: n.enterprise_id });
    if (core.fakeSlack(b.env, request)) return redirect(`/slack/link/done?code=${encodeURIComponent(`fake:${n.team_id}/${n.slack_user}`)}&state=${state}`, 303);
    const q = new URLSearchParams({ response_type: "code", scope: "openid", client_id: b.env.SLACK_CLIENT_ID ?? "", redirect_uri: `${b.origin}/slack/link/done`, state, nonce: state, team: n.team_id });
    return redirect(`https://slack.com/openid/connect/authorize?${q}`, 303);
  }
  return page(
    "Link Slack · Atteo",
    `<div class="card pad" style="max-width:520px;margin:24px auto 0"><p class="small muted">Connect your Atteo account</p><h1 style="font-size:20px;margin-top:4px">Link Slack ${html(where)} to Atteo ${html(viewer.name)}?</h1>
<p class="muted" style="margin-top:8px">Replies you write in Slack threads will post on Atteo as you, and Approve / Deny in your Slack DMs will decide as you. Slack asks you to sign in next, to prove the account is yours.</p>
<form method="post" action="/slack/link/${html(nonce)}" style="margin-top:16px"><div class="row" style="justify-content:flex-end;gap:8px"><a class="btn" href="/">Cancel</a><button class="btn primary">Continue with Slack</button></div></form></div>`,
    { viewer, narrow: true },
  );
}

/** Back from Sign in with Slack: link only when the Slack account that signed in is the one the link was made for. */
export async function personLinkDone(b: Bridge, viewer: Viewer, url: URL): Promise<Response> {
  const n = await takeNonce(b, url.searchParams.get("state") ?? "", "person_sso");
  if (url.searchParams.get("error")) return msgPage(viewer, "Nothing was linked", url.searchParams.get("error") === "access_denied" ? "You cancelled on Slack's side." : `Slack said: ${url.searchParams.get("error")}.`);
  if (!n || n.user !== viewer.name || !n.team_id || !n.slack_user) return msgPage(viewer, "This link expired", "Type /atteo in Slack for a new one.", 400);
  const id = await b.openid(url.searchParams.get("code") ?? "", `${b.origin}/slack/link/done`);
  if (!id.ok) return msgPage(viewer, "Nothing was linked", `Slack couldn't confirm who you are (${id.error ?? "error"}). Type /atteo in Slack for a new link.`, 502);
  if (id.team !== n.team_id || id.user !== n.slack_user)
    return msgPage(viewer, "Nothing was linked", "This link was made for a different Slack account than the one you signed in with. Only link your own: type /atteo in Slack yourself for your link.", 403);
  const inst = await installOf(b, n.team_id);
  const where = `${n.slack_name ? `@${n.slack_name}` : "your Slack account"}${inst ? ` (${inst.team_name})` : ""}`;
  const r = await linkPerson(b, { team: n.team_id, slackUser: n.slack_user, enterprise: n.enterprise_id, user: viewer.name, slackName: n.slack_name });
  if (r === "taken") return msgPage(viewer, "Nothing was linked", `Slack ${where} is linked to another Atteo account. It stays theirs until it's unlinked there (/atteo signout in Slack).`, 409);
  await publishHome(b, n.team_id, n.slack_user).catch(() => {});
  return msgPage(viewer, "Linked", `Slack ${where} now acts as ${viewer.name} on Atteo: replies in bridged threads post as you, and your approval buttons work. Go back to Slack.`, 200, `<div class="row" style="justify-content:flex-end;margin-top:16px"><a class="btn" href="/slack/accounts">Slack accounts</a></div>`);
}

/** The Slack accounts that act as this person on Atteo, each with Unlink. */
export async function accountsPage(b: Bridge, viewer: Viewer, method: string, form: Record<string, string>): Promise<Response> {
  if (method === "POST" && form.op === "unlink") {
    const gone = await b.db.prepare(`DELETE FROM slack_people WHERE team_id = ? AND slack_user = ? AND user = ?`).bind(form.team ?? "", form.slack_user ?? "", viewer.name).run();
    if (gone.meta?.changes) await publishHome(b, form.team ?? "", form.slack_user ?? "").catch(() => {});
    return redirect("/slack/accounts", 303);
  }
  const rows = (
    await b.db
      .prepare(`SELECT p.team_id, p.slack_user, p.created_at, i.team_name FROM slack_people p LEFT JOIN slack_installs i ON i.team_id = p.team_id WHERE p.user = ? ORDER BY p.created_at DESC LIMIT 50`)
      .bind(viewer.name)
      .all<{ team_id: string; slack_user: string; created_at: number; team_name: string | null }>()
  ).results;
  const list = rows
    .map(
      (r) =>
        `<li class="row" style="justify-content:space-between;padding:10px 0;border-top:1px solid var(--line)"><div><b>${html(r.team_name ?? r.team_id)}</b> <span class="muted small">${html(r.slack_user)} · linked ${html(new Date(r.created_at).toISOString().slice(0, 10))}</span></div><form method="post" style="margin:0"><input type="hidden" name="op" value="unlink"><input type="hidden" name="team" value="${html(r.team_id)}"><input type="hidden" name="slack_user" value="${html(r.slack_user)}"><button class="btn sm danger">Unlink</button></form></li>`,
    )
    .join("");
  return page(
    "Slack accounts · Atteo",
    `<div class="card pad" style="max-width:560px;margin:24px auto 0"><h1 style="font-size:20px">Slack accounts</h1><p class="muted" style="margin-top:6px">These Slack accounts act as you on Atteo: their thread replies post as you and their approval buttons decide as you. Unlink any you don't recognize.</p>
${rows.length ? `<ul style="list-style:none;padding:0;margin:14px 0 0">${list}</ul>` : `<p class="muted" style="margin-top:12px">No Slack account is linked.</p>`}</div>`,
    { viewer, narrow: true },
  );
}

const PAUSED: Record<string, string> = { archived: "Paused: the channel was archived", removed: "Paused: Atteo was removed from the channel", disconnected: "Slack disconnected: connect Slack again", shared: "Paused: now shared with another organization; confirm to resume" };

/** A board's Slack settings (its owner): its channels, what each shows, resume, unlink. */
export async function boardSettings(b: Bridge, viewer: Viewer, board: string, method: string, form: Record<string, string>): Promise<Response> {
  const row = await linkable(b, board, viewer.name);
  if (typeof row === "string") return msgPage(viewer, "Slack", row, 404);
  if (method === "POST") {
    const l = await b.db.prepare(`SELECT * FROM slack_links WHERE channel_id = ? AND board_id = ?`).bind(form.channel ?? "", board).first<LinkRow>();
    if (l) {
      if (form.op === "unlink") await unlinkChannel(b, l, viewer.name);
      else if (form.op === "lane" && (form.lane === "decisions" || form.lane === "everything")) await b.db.prepare(`UPDATE slack_links SET lane = ? WHERE channel_id = ?`).bind(form.lane, l.channel_id).run();
      else if (form.op === "resume") {
        if (l.paused === "shared") await b.db.prepare(`UPDATE slack_links SET paused = NULL, audience_at = ? WHERE channel_id = ?`).bind(b.now(), l.channel_id).run();
        else if (l.paused === "archived" || l.paused === "removed") {
          const r = await b.call(l.team_id, "conversations.info", { channel: l.channel_id });
          const ch = r.channel as ChannelInfo | undefined;
          if (r.ok && ch && !ch.is_archived) {
            if (!ch.is_member && !ch.is_private) await b.call(l.team_id, "conversations.join", { channel: l.channel_id });
            await b.db.prepare(`UPDATE slack_links SET paused = NULL WHERE channel_id = ?`).bind(l.channel_id).run();
          }
        }
      }
    }
    return redirect(`/slack/board/${board}`, 303);
  }
  const links = (await b.db.prepare(`SELECT l.*, i.team_name FROM slack_links l LEFT JOIN slack_installs i ON i.team_id = l.team_id WHERE l.board_id = ? ORDER BY l.created_at`).bind(board).all<LinkRow & { team_name: string | null }>()).results;
  const form1 = (l: LinkRow, op: string, label: string, extra = "", cls = "btn sm") => `<form method="post" style="display:inline"><input type="hidden" name="op" value="${op}"><input type="hidden" name="channel" value="${html(l.channel_id)}">${extra}<button class="${cls}">${html(label)}</button></form>`;
  const rows = links
    .map((l) => {
      const other = l.lane === "decisions" ? "everything" : "decisions";
      const laneBtn = form1(l, "lane", other === "everything" ? (l.shared ? "Show everything (shared channel)" : "Show everything") : "Decisions only", `<input type="hidden" name="lane" value="${other}">`);
      const resume = l.paused === "disconnected" ? `<a class="btn sm" href="/slack/connect?board=${html(board)}&add=1">Connect Slack again</a>` : l.paused ? form1(l, "resume", l.paused === "shared" ? "Confirm and resume" : "Resume") : "";
      return `<li style="padding:12px 0;border-top:1px solid var(--line)"><div><b>#${html(l.channel_name)}</b> <span class="muted small">${html(l.team_name ?? l.team_id)}${l.shared ? " · shared with other organizations" : ""}</span></div>
<div class="small muted" style="margin-top:2px">${html(l.paused ? (PAUSED[l.paused] ?? `Paused: ${l.paused}`) : l.lane === "decisions" ? "Decisions, and a digest of the rest" : "Every post")}</div>
<div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">${l.paused ? resume : laneBtn}${form1(l, "unlink", "Unlink", "", "btn sm danger")}</div></li>`;
    })
    .join("");
  return page(
    "Slack · Atteo",
    `<div class="card pad" style="max-width:560px;margin:24px auto 0"><p class="small muted"><a href="/b/${html(board)}">${html(row.title)}</a></p><h1 style="font-size:20px;margin-top:4px">Slack</h1>
${links.length ? `<ul style="list-style:none;padding:0;margin:14px 0 0">${rows}</ul>` : `<p class="muted" style="margin-top:8px">No channel follows this board yet.</p>`}
<div class="row" style="justify-content:flex-end;margin-top:16px"><a class="btn primary" href="/slack/connect?board=${html(board)}&add=1">Add a channel</a></div></div>`,
    { viewer, narrow: true },
  );
}

// ---- the router's hook: /slack/… ----

export async function route(request: Request, env: Env, ctx: Later, path: string, viewer: Viewer | null, origin: string): Promise<Response> {
  const notFound = () => new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (!core.slackOn(env, request)) return notFound();
  const b = bridgeFor(env, origin);
  const method = request.method;
  const url = new URL(request.url);
  if (method === "POST" && (path === "/slack/events" || path === "/slack/commands" || path === "/slack/interactivity")) return inbound(request, b, ctx, path.slice(7) as "events" | "commands" | "interactivity");
  // The stub's record, for the local tests (DEV_FAKE_SLACK on localhost only).
  if (path === "/slack/dev/calls" && method === "GET") {
    if (!core.fakeSlack(env, request)) return notFound();
    const stub = teamStub(env, url.searchParams.get("team") ?? FAKE_TEAM.id);
    return json({ calls: await stub.fakeLog(), pending: await stub.pending() });
  }
  if (!viewer) return method === "GET" ? redirect(`/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`) : json({ error: "sign in required" }, 401);
  if (viewer.via === "agent") return json({ error: "Connecting Slack is for people, on Atteo's pages. An agent's token can't." }, 403);
  if (method === "POST") {
    // Forms here change who can read a board: only from Atteo's own pages.
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") return json({ error: "Use Atteo's own pages." }, 403);
  }
  const form = method === "POST" ? (Object.fromEntries(new URLSearchParams(await request.text())) as Record<string, string>) : {};
  if (path === "/slack/connect" && method === "GET") return connectPage(b, viewer, url, request);
  if (path === "/slack/oauth" && method === "GET") return oauthDone(b, viewer, url);
  if (path === "/slack/pick" && method === "POST") return pickChannel(b, viewer, form);
  if (path === "/slack/link/done" && method === "GET") return personLinkDone(b, viewer, url);
  if (path === "/slack/accounts" && (method === "GET" || method === "POST")) return accountsPage(b, viewer, method, form);
  let m = path.match(/^\/slack\/link\/([0-9a-f]{36})$/);
  if (m && (method === "GET" || method === "POST")) return personLinkPage(b, viewer, m[1], method, request);
  m = path.match(/^\/slack\/board\/(b_[a-z0-9]{8,32})$/);
  if (m && (method === "GET" || method === "POST")) return boardSettings(b, viewer, m[1], method, form);
  return notFound();
}

