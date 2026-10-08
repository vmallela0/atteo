// The Linear integration (vedu #6508, plan #6509 item 1). A board's tasks become issues in one Linear team; status
// changes and comments on those issues come back to the board.
//
// - Link: GET /api/integrations/linear/start?board=<id> (a signed-in person, a contributor or owner of the board, never
//   an agent token) → Linear's OAuth (state: HMAC-signed, 10 minutes, bound to that person and board) →
//   /api/integrations/linear/callback stores the tokens sealed (AES-GCM with LINEAR_TOKEN_KEY, as Slack's bot tokens)
//   and shows a tiny page to pick the team (and an optional project), which POSTs /api/integrations/linear. Never an
//   encrypted board (the server can't read its tasks), a DM or "Your agent".
// - Board → Linear: every task change on a linked board (the board object's task broadcasts) syncs that task, one at a
//   time per board, in waitUntil: issueCreate the first time, then issueUpdate only for what changed (a hash of title
//   and description, the state type last sent or seen). Status → state by Linear's fixed state types: todo → unstarted
//   (Todo; Backlog when the team has none), doing → started, done → completed, stopped → canceled, frozen → backlog;
//   blocked keeps the state and adds the team's "blocked" label, or comments once when it has none.
// - Linear → board: POST /api/integrations/linear/webhook, signed (Linear-Signature: hex HMAC-SHA256 of the raw body
//   with LINEAR_WEBHOOK_SECRET; webhookTimestamp within 60s; each delivery once). An issue's state change sets its
//   task's status; a new comment is a note in the task's thread. That note is the linker's agent's post, client
//   "Linear", origin "linear" (server-set), with the Linear author's name as a label in the text: never "from your
//   person", since nothing proves who wrote it. Its @mentions route like any post (@agents, @vedu's agent). It's
//   untrusted board text like any other.
// - No echo: the issue's state type is recorded before the board changes and compared before Linear is told; comments
//   by the token's own Linear user, or ones Atteo made, aren't brought back.
//
// Off until LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET and LINEAR_TOKEN_KEY are set: the routes answer 503 "Linear isn't
// set up yet". The webhook also needs LINEAR_WEBHOOK_SECRET.

import { mayMention, parseMentions, type Mention, type MemberRef } from "./mentions";
import * as registry from "./registry";
import { keyFromB64, openWith, sameText, sealWith } from "./slackCore";
import type { TaskStatus, TaskView } from "./board";
import type { Env } from "./types";
import { page, type Viewer } from "./ui";
import { esc as html } from "./util";

export const LINEAR_AUTHORIZE = "https://linear.app/oauth/authorize";
export const LINEAR_TOKEN = "https://api.linear.app/oauth/token";
export const LINEAR_REVOKE = "https://api.linear.app/oauth/revoke";
export const LINEAR_GRAPHQL = "https://api.linear.app/graphql";
export const SCOPES = "read,write,issues:create,comments:create";
export const STATE_MS = 10 * 60_000;
export const REPLAY_MS = 60_000;
export const SEEN_MS = 24 * 3600_000;
export const MAX_WEBHOOK_BYTES = 1_000_000;
export const NOT_SET_UP = "Linear isn't set up yet";
export const CALLBACK_PATH = "/api/integrations/linear/callback";

export type LinearEnv = {
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
  LINEAR_TOKEN_KEY?: string;
  LINEAR_WEBHOOK_SECRET?: string;
  PUBLIC_URL?: string;
};

/** Whether linking exists here at all: the OAuth app and the key tokens are sealed with. */
export const linearOn = (env: LinearEnv): boolean => !!(env.LINEAR_CLIENT_ID && env.LINEAR_CLIENT_SECRET && env.LINEAR_TOKEN_KEY);

// ---- pure parts ----

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
}

export const sha256 = async (s: string): Promise<string> => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

export type WebhookCheck = { ok: true; payload: LinearEvent } | { ok: false; status: number; why: string };

/** Whether a webhook really is Linear's: a good signature over the raw body, sent in the last 60 seconds. */
export async function verifyWebhook(secret: string | undefined, signature: string | null, raw: string, nowMs: number): Promise<WebhookCheck> {
  if (!secret) return { ok: false, status: 503, why: NOT_SET_UP };
  if (!signature) return { ok: false, status: 401, why: "unsigned" };
  if (!sameText(await hmacHex(secret, raw), signature.trim().toLowerCase())) return { ok: false, status: 401, why: "bad signature" };
  let payload: LinearEvent;
  try {
    payload = JSON.parse(raw) as LinearEvent;
  } catch {
    return { ok: false, status: 400, why: "not JSON" };
  }
  const ts = Number(payload?.webhookTimestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > REPLAY_MS) return { ok: false, status: 401, why: "stale timestamp" };
  return { ok: true, payload };
}

const b64url = (s: string) => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

/** The OAuth state: who started it, for which board, until when; signed so the callback can't be pointed elsewhere. */
export async function signState(secret: string, o: { user: string; board: string; exp: number }): Promise<string> {
  const n = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const body = b64url(JSON.stringify({ u: o.user, b: o.board, e: o.exp, n }));
  return `${body}.${await hmacHex(secret, `linear-state:${body}`)}`;
}

export async function readState(secret: string, state: string, nowMs: number): Promise<{ user: string; board: string } | null> {
  const [body, sig, extra] = state.split(".");
  if (!body || !sig || extra !== undefined || !/^[0-9a-f]{64}$/.test(sig)) return null;
  if (!sameText(await hmacHex(secret, `linear-state:${body}`), sig)) return null;
  try {
    const o = JSON.parse(unb64url(body)) as { u?: unknown; b?: unknown; e?: unknown };
    if (typeof o.u !== "string" || typeof o.b !== "string" || typeof o.e !== "number" || o.e < nowMs) return null;
    return { user: o.u, board: o.b };
  } catch {
    return null;
  }
}

export interface LinearState {
  id: string;
  name: string;
  type: string; // backlog | unstarted | started | completed | canceled (| triage)
  position: number;
}

/** The state types a task status prefers, in order; null keeps the issue's state (blocked). */
export const WANT: Record<TaskStatus, string[] | null> = {
  todo: ["unstarted", "backlog"],
  doing: ["started"],
  blocked: null,
  done: ["completed"],
  stopped: ["canceled"],
  frozen: ["backlog", "unstarted"],
};

/** The team's state for a task status: the first of its preferred types the team has ("Todo" among unstarted). */
export function stateFor(states: LinearState[], status: TaskStatus): LinearState | null {
  for (const type of WANT[status] ?? []) {
    const of = states.filter((s) => s.type === type).sort((a, b) => a.position - b.position);
    if (!of.length) continue;
    return (type === "unstarted" ? of.find((s) => /^to ?do$/i.test(s.name.trim())) : null) ?? of[0];
  }
  return null;
}

/** An issue's new state type, as a task status; null leaves the task alone. Backlog keeps a frozen task frozen. */
export function statusFor(type: string, current: TaskStatus | null): TaskStatus | null {
  switch (type) {
    case "triage":
    case "unstarted":
      return "todo";
    case "backlog":
      return current === "frozen" ? "frozen" : "todo";
    case "started":
      return "doing";
    case "completed":
      return "done";
    case "canceled":
      return "stopped";
    default:
      return null;
  }
}

/** The issue's description: the task's body, then the way back to the board. */
export function describe(origin: string, board: string, t: Pick<TaskView, "seq" | "body">): string {
  const back = `From Atteo task #${t.seq}: ${origin}/b/${board}#e${t.seq}`;
  return t.body.trim() ? `${t.body.trim()}\n\n---\n${back}` : back;
}

/** A Linear person's name as a plain label in board text: no @ (it can't mention anyone), one line, short. */
export function nameLabel(s: unknown): string {
  return String(s ?? "").replace(/[@\r\n\t<>`*_~[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Someone";
}

/** The board note for a Linear comment: its author as a label, which issue, and the words. */
export function commentNote(author: string, identifier: string | null, body: string): string {
  const head = `${nameLabel(author)} commented on Linear${identifier ? ` (${identifier})` : ""}:`;
  const max = 2900 - head.length;
  const words = body.trim();
  return `${head}\n\n${words.length > max ? words.slice(0, max - 1) + "…" : words}`;
}

// ---- GraphQL documents (tests check calls against these) ----

export const Q_VIEWER = `query AtteoLink { organization { id name urlKey } teams(first: 100) { nodes { id key name } } projects(first: 100) { nodes { id name teams { nodes { id } } } } }`;
/** Who the token acts as (the app, with actor=app): only to skip its own comments, so it's asked on its own and may fail. */
export const Q_ME = `query AtteoMe { viewer { id name } }`;
export const Q_TEAM = `query AtteoTeam($id: String!) { team(id: $id) { id key name states { nodes { id name type position } } labels(first: 250) { nodes { id name } } } }`;
export const Q_PROJECT = `query AtteoProject($id: String!) { project(id: $id) { id name teams { nodes { id } } } }`;
export const M_CREATE = `mutation AtteoIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`;
export const M_UPDATE = `mutation AtteoIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;
export const M_ADD_LABEL = `mutation AtteoAddLabel($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }`;
export const M_REMOVE_LABEL = `mutation AtteoRemoveLabel($id: String!, $labelId: String!) { issueRemoveLabel(id: $id, labelId: $labelId) { success } }`;
export const M_COMMENT = `mutation AtteoComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`;

// ---- what the integration needs (tests pass stand-ins) ----

export interface LinearBoardOps {
  status(board: string, seq: number): Promise<TaskStatus | null>;
  /** As the linker's agent (client "Linear"). Throws when the board refuses (someone else holds the task). */
  setStatus(board: string, user: string, seq: number, status: TaskStatus): Promise<void>;
  /** A note in the task's thread as the linker's agent, client "Linear", origin "linear". */
  comment(board: string, user: string, seq: number, text: string, mentions: Mention[]): Promise<number>;
  setLinear(board: string, on: boolean): Promise<void>;
  members(board: string): Promise<(MemberRef & object)[]>;
}

export interface Linear {
  db: D1Database;
  env: LinearEnv;
  origin: string;
  now(): number;
  http: typeof fetch;
  board: LinearBoardOps;
}

const stubOf = (env: Env, id: string) => env.BOARD.get(env.BOARD.idFromName(id));

export function linearFor(env: Env, origin?: string): Linear {
  return {
    db: env.DB,
    env,
    origin: (origin ?? env.PUBLIC_URL ?? "https://atteo.dev").replace(/\/$/, ""),
    now: () => Date.now(),
    http: (input, init) => fetch(input, init),
    board: {
      status: async (board, seq) => (await stubOf(env, board).taskGet(seq).catch(() => null))?.status ?? null,
      setStatus: async (board, user, seq, status) => void (await stubOf(env, board).taskUpdate(user, seq, { status }, { via: "agent", client: "Linear" })),
      async comment(board, user, seq, text, mentions) {
        const e = await stubOf(env, board).post(user, { type: "note", text, reply_to: seq, via: "agent", client: "Linear", mentions }, { origin: "linear" });
        await registry.bumpBoard(env, board, e.seq).catch(() => {});
        return e.seq;
      },
      setLinear: (board, on) => stubOf(env, board).setLinear(on),
      members: async (board) => (await registry.boardMembers(env, board)).map((m) => ({ user: m.user, agent_name: m.agent_name })),
    },
  };
}

// ---- D1 rows ----

export interface LinkRow {
  board_id: string;
  created_by: string;
  org_id: string;
  org_name: string | null;
  linear_user: string | null;
  token: string;
  refresh: string | null;
  expires_at: number | null;
  team_id: string | null;
  team_key: string | null;
  team_name: string | null;
  project_id: string | null;
  project_name: string | null;
  states: string | null;
  blocked_label: string | null;
  created_at: number;
  updated_at: number;
}

interface IssueRow {
  board_id: string;
  seq: number;
  issue_id: string;
  identifier: string | null;
  url: string | null;
  synced: string | null;
  state_type: string | null;
  blocked: number;
}

const linkOf = (l: Linear, board: string) => l.db.prepare(`SELECT * FROM linear_links WHERE board_id = ?`).bind(board).first<LinkRow>();
const statesOf = (link: LinkRow): LinearState[] => {
  try {
    return link.states ? (JSON.parse(link.states) as LinearState[]) : [];
  } catch {
    return [];
  }
};

/** The first time this key is seen in the last day (a redelivered webhook). */
async function firstSeen(l: Linear, key: string): Promise<boolean> {
  const r = await l.db.prepare(`INSERT OR IGNORE INTO linear_seen (key, at) VALUES (?, ?)`).bind(key.slice(0, 200), l.now()).run();
  return (r.meta?.changes ?? 0) > 0;
}

// ---- Linear's HTTP ----

const tokenKey = (l: Linear) => keyFromB64(l.env.LINEAR_TOKEN_KEY ?? "", "LINEAR_TOKEN_KEY");

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
}

async function tokenRequest(l: Linear, params: Record<string, string>): Promise<TokenAnswer & { access_token: string }> {
  const form = new URLSearchParams({ client_id: l.env.LINEAR_CLIENT_ID ?? "", client_secret: l.env.LINEAR_CLIENT_SECRET ?? "", ...params });
  const res = await l.http(LINEAR_TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(10_000) });
  const j = (await res.json().catch(() => null)) as TokenAnswer | null;
  if (!res.ok || !j?.access_token) throw new Error(`Linear didn't give a token (${j?.error ?? `HTTP ${res.status}`})`);
  return j as TokenAnswer & { access_token: string };
}

/** The sealed columns for a token answer. */
async function sealed(l: Linear, t: TokenAnswer & { access_token: string }) {
  const key = tokenKey(l);
  return {
    token: await sealWith(key, t.access_token),
    refresh: t.refresh_token ? await sealWith(key, t.refresh_token) : null,
    expires_at: typeof t.expires_in === "number" && t.expires_in > 0 ? l.now() + t.expires_in * 1000 : null,
  };
}

/** The link's access token, refreshed first when it's about to run out and Linear gave a refresh token. */
async function accessToken(l: Linear, link: LinkRow): Promise<string> {
  const key = tokenKey(l);
  if (link.refresh && link.expires_at && l.now() > link.expires_at - 5 * 60_000) {
    const t = await tokenRequest(l, { grant_type: "refresh_token", refresh_token: await openWith(key, link.refresh) });
    const s = await sealed(l, t);
    await l.db.prepare(`UPDATE linear_links SET token = ?, refresh = COALESCE(?, refresh), expires_at = ?, updated_at = ? WHERE board_id = ?`).bind(s.token, s.refresh, s.expires_at, l.now(), link.board_id).run();
    return t.access_token;
  }
  return openWith(key, link.token);
}

export async function gql<T = Record<string, any>>(l: Linear, token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await l.http(LINEAR_GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = (await res.json().catch(() => null)) as { data?: T; errors?: { message?: string }[] } | null;
  if (!res.ok || !j?.data || j.errors?.length) throw new Error(`Linear API: ${j?.errors?.[0]?.message ?? `HTTP ${res.status}`}`);
  return j.data;
}

async function revoke(l: Linear, link: LinkRow): Promise<void> {
  const token = await openWith(tokenKey(l), link.token).catch(() => null);
  if (!token) return;
  await l
    .http(LINEAR_REVOKE, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10_000) })
    .catch((e) => console.error("linear revoke failed", e));
}

// ---- board → Linear ----

/**
 * One task to its issue: create it the first time, then send only what changed. Called by the board object, one task at
 * a time per board, after the change is stored. Never on an encrypted board (refused at link time; the object checks too).
 */
export async function syncTask(l: Linear, board: string, t: TaskView): Promise<"created" | "updated" | "unchanged" | "off"> {
  const link = await linkOf(l, board);
  if (!link?.team_id) return "off";
  const row = await l.db.prepare(`SELECT * FROM linear_issues WHERE board_id = ? AND seq = ?`).bind(board, t.seq).first<IssueRow>();
  const desc = describe(l.origin, board, t);
  const hash = await sha256(`${t.title}\n\u0000${desc}`);
  const target = stateFor(statesOf(link), t.status);
  const blocked = t.status === "blocked";
  if (!row) {
    const token = await accessToken(l, link);
    const input: Record<string, unknown> = { teamId: link.team_id, title: t.title, description: desc };
    if (link.project_id) input.projectId = link.project_id;
    if (target) input.stateId = target.id;
    if (blocked && link.blocked_label) input.labelIds = [link.blocked_label];
    const r = await gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null } }>(l, token, M_CREATE, { input });
    const issue = r.issueCreate?.issue;
    if (!r.issueCreate?.success || !issue?.id) throw new Error("Linear didn't create the issue");
    await l.db
      .prepare(`INSERT OR REPLACE INTO linear_issues (board_id, seq, issue_id, identifier, url, synced, state_type, blocked, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(board, t.seq, issue.id, issue.identifier ?? null, issue.url ?? null, hash, target?.type ?? null, blocked ? 1 : 0, l.now())
      .run();
    if (blocked && !link.blocked_label) await blockedComment(l, token, issue.id, board, t.seq);
    return "created";
  }
  const input: Record<string, unknown> = {};
  if (row.synced !== hash) Object.assign(input, { title: t.title, description: desc });
  if (target && target.type !== row.state_type) input.stateId = target.id;
  const flip = blocked !== !!row.blocked;
  if (!Object.keys(input).length && !flip) return "unchanged";
  const token = await accessToken(l, link);
  if (Object.keys(input).length) {
    const r = await gql<{ issueUpdate: { success: boolean } }>(l, token, M_UPDATE, { id: row.issue_id, input });
    if (!r.issueUpdate?.success) throw new Error("Linear didn't update the issue");
  }
  if (flip) {
    if (link.blocked_label) await gql(l, token, blocked ? M_ADD_LABEL : M_REMOVE_LABEL, { id: row.issue_id, labelId: link.blocked_label });
    else if (blocked) await blockedComment(l, token, row.issue_id, board, t.seq);
  }
  await l.db
    .prepare(`UPDATE linear_issues SET synced = ?, state_type = ?, blocked = ?, updated_at = ? WHERE board_id = ? AND seq = ?`)
    .bind(hash, input.stateId ? target!.type : row.state_type, blocked ? 1 : 0, l.now(), board, t.seq)
    .run();
  return "updated";
}

const BLOCKED_PREFIX = "Blocked on Atteo: ";

/** No "blocked" label in the team: say so once in a comment, remembered so the webhook doesn't bring it back. */
async function blockedComment(l: Linear, token: string, issueId: string, board: string, seq: number) {
  const r = await gql<{ commentCreate: { comment: { id: string } | null } }>(l, token, M_COMMENT, { input: { issueId, body: `${BLOCKED_PREFIX}${l.origin}/b/${board}#e${seq}` } });
  const id = r.commentCreate?.comment?.id;
  if (id) await firstSeen(l, `c:${id}`);
}

// ---- Linear → board ----

export interface LinearEvent {
  action?: string;
  type?: string;
  data?: Record<string, any>;
  updatedFrom?: Record<string, unknown>;
  actor?: { id?: string; name?: string; type?: string };
  organizationId?: string;
  webhookTimestamp?: number;
  webhookId?: string;
}

type Mapped = IssueRow & Pick<LinkRow, "created_by" | "org_id" | "linear_user" | "states">;

const mappedIssue = (l: Linear, issueId: string) =>
  l.db
    .prepare(`SELECT i.*, k.created_by, k.org_id, k.linear_user, k.states FROM linear_issues i JOIN linear_links k ON k.board_id = i.board_id WHERE i.issue_id = ?`)
    .bind(issueId)
    .first<Mapped>();

/** The linker can still act there: a contributor or owner of the board (not a viewer, not gone). */
async function canAct(l: Linear, board: string, user: string): Promise<boolean> {
  const r = await l.db.prepare(`SELECT role, expires_at FROM members WHERE board_id = ? AND user = ?`).bind(board, user).first<{ role: string; expires_at: number | null }>();
  return !!r && r.role !== "viewer" && (r.expires_at == null || r.expires_at > l.now());
}

/** What one verified webhook does. Returns what happened, for logs and tests. */
export async function applyEvent(l: Linear, p: LinearEvent): Promise<string> {
  const d = p.data ?? {};
  if (p.type === "Issue" && p.action === "update") {
    if (!p.updatedFrom || !("stateId" in p.updatedFrom)) return "ignored: not a state change";
    const m = typeof d.id === "string" ? await mappedIssue(l, d.id) : null;
    if (!m) return "ignored: not a board task";
    if (p.organizationId && p.organizationId !== m.org_id) return "ignored: another organization";
    const type = (typeof d.state?.type === "string" ? d.state.type : null) ?? statesOf(m as unknown as LinkRow).find((s) => s.id === d.stateId)?.type ?? null;
    if (!type) return "ignored: unknown state";
    if (type === m.state_type) return "ignored: already in step";
    // Recorded first: the board's change comes back through syncTask, which then finds Linear already there.
    await l.db.prepare(`UPDATE linear_issues SET state_type = ?, updated_at = ? WHERE issue_id = ?`).bind(type, l.now(), m.issue_id).run();
    const cur = await l.board.status(m.board_id, m.seq);
    const next = statusFor(type, cur);
    if (!cur || !next || next === cur) return "ignored: same status";
    if (!(await canAct(l, m.board_id, m.created_by))) return "ignored: the linker can't change tasks there";
    try {
      await l.board.setStatus(m.board_id, m.created_by, m.seq, next);
    } catch (e) {
      return `refused: ${e instanceof Error ? e.message : String(e)}`;
    }
    return `status: ${next}`;
  }
  if (p.type === "Comment" && p.action === "create") {
    const issueId = typeof d.issueId === "string" ? d.issueId : typeof d.issue?.id === "string" ? d.issue.id : null;
    const m = issueId ? await mappedIssue(l, issueId) : null;
    if (!m) return "ignored: not a board task";
    if (p.organizationId && p.organizationId !== m.org_id) return "ignored: another organization";
    const author = (typeof d.userId === "string" ? d.userId : null) ?? d.user?.id ?? p.actor?.id ?? null;
    if (author && author === m.linear_user) return "ignored: Atteo's own comment";
    if (typeof d.id === "string" && (await l.db.prepare(`SELECT 1 AS x FROM linear_seen WHERE key = ?`).bind(`c:${d.id}`).first())) return "ignored: Atteo's own comment";
    const body = String(d.body ?? "").trim();
    if (body.startsWith(BLOCKED_PREFIX)) return "ignored: Atteo's own comment"; // its webhook can beat the seen row
    if (!body) return "ignored: empty";
    if (!(await canAct(l, m.board_id, m.created_by))) return "ignored: the linker can't post there";
    const text = commentNote(d.user?.name ?? p.actor?.name ?? "Someone", m.identifier, body);
    // Resolved with no author: the linker's own agent counts too ("@vedu's agent" from Linear reaches vedu's agent).
    const mentions = mayMention(text) ? parseMentions(text, await l.board.members(m.board_id)).mentions : [];
    const seq = await l.board.comment(m.board_id, m.created_by, m.seq, text, mentions);
    return `note: #${seq}`;
  }
  return "ignored";
}

type Later = { waitUntil(p: Promise<unknown>): void };

/** POST /api/integrations/linear/webhook: checked, deduped, answered at once, handled in waitUntil. */
export async function webhook(l: Linear, request: Request, later: Later): Promise<Response> {
  if (!linearOn(l.env) || !l.env.LINEAR_WEBHOOK_SECRET) return json({ error: NOT_SET_UP }, 503);
  const raw = await request.text();
  if (raw.length > MAX_WEBHOOK_BYTES) return json({ error: "Payload too large" }, 413);
  const v = await verifyWebhook(l.env.LINEAR_WEBHOOK_SECRET, request.headers.get("linear-signature"), raw, l.now());
  if (!v.ok) return json({ error: v.why }, v.status);
  const delivery = request.headers.get("linear-delivery") ?? `${v.payload.webhookId ?? ""}:${v.payload.webhookTimestamp}`;
  if (!(await firstSeen(l, `d:${delivery}`))) return json({ ok: true, applied: "duplicate" });
  later.waitUntil(
    (async () => {
      await l.db.prepare(`DELETE FROM linear_seen WHERE at < ?`).bind(l.now() - SEEN_MS).run().catch(() => {});
      await applyEvent(l, v.payload).catch((e) => console.error("linear webhook failed", e));
    })(),
  );
  return json({ ok: true, applied: "accepted" });
}

// ---- the people's routes ----

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });

function msgPage(viewer: Viewer | null, title: string, text: string, status = 200): Response {
  return page(`${title} · Atteo`, `<div class="card pad" style="max-width:520px;margin:24px auto 0"><h1 style="font-size:20px">${html(title)}</h1><p class="muted" style="margin-top:8px">${html(text)}</p></div>`, { viewer, narrow: true, status });
}

interface BoardLite {
  id: string;
  title: string;
  encrypted: number;
  kind: string | null;
  archived_at: number | null;
  deleted_at: number | null;
}

async function roleOf(l: Linear, board: string, user: string): Promise<string | null> {
  const r = await l.db.prepare(`SELECT role, expires_at FROM members WHERE board_id = ? AND user = ?`).bind(board, user).first<{ role: string; expires_at: number | null }>();
  return r && (r.expires_at == null || r.expires_at > l.now()) ? r.role : null;
}

/** Can this person link this board to Linear? The board row, or why not. */
export async function linkable(l: Linear, board: string, user: string): Promise<BoardLite | { status: number; error: string }> {
  const row = /^b_[a-z0-9]{8,32}$/.test(board) ? await l.db.prepare(`SELECT id, title, encrypted, kind, archived_at, deleted_at FROM boards WHERE id = ?`).bind(board).first<BoardLite>() : null;
  const role = row && !row.deleted_at ? await roleOf(l, board, user) : null;
  if (!row || row.deleted_at || !role) return { status: 404, error: "No such board." };
  if (role === "viewer") return { status: 403, error: "Viewers can't connect a board to Linear." };
  if (row.encrypted) return { status: 409, error: "This board is end-to-end encrypted: the server can't read its tasks, so they can't be synced to Linear." };
  if (row.kind === "agent") return { status: 409, error: "\"Your agent\" stays between you and your agents: it can't be connected to Linear." };
  if (row.kind === "direct") return { status: 409, error: "A conversation between two people can't be connected to Linear." };
  if (row.archived_at) return { status: 409, error: "This board is archived." };
  return row;
}

type Who = { ok: true; viewer: Viewer } | { ok: false; res: Response };

/** People only: signed in on Atteo, never an agent token (`page`: answer with pages, not JSON). */
function person(l: Linear, viewer: Viewer | null, url: URL, asPage: boolean): Who {
  if (!linearOn(l.env)) return { ok: false, res: asPage ? msgPage(viewer, NOT_SET_UP, "Linear isn't set up on this server yet.", 503) : json({ error: NOT_SET_UP }, 503) };
  if (!viewer) return { ok: false, res: asPage ? redirect(`/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`) : json({ error: "sign in required" }, 401) };
  if (viewer.via === "agent") return { ok: false, res: json({ error: "Connecting Linear is for people, signed in on Atteo. An agent's token can't." }, 403) };
  return { ok: true, viewer };
}

/** GET /api/integrations/linear/start?board=: to Linear's consent screen. */
export async function start(l: Linear, viewer: Viewer | null, url: URL): Promise<Response> {
  const who = person(l, viewer, url, true);
  if (!who.ok) return who.res;
  const board = url.searchParams.get("board") ?? "";
  const row = await linkable(l, board, who.viewer.name);
  if (!("id" in row)) return msgPage(who.viewer, "Can't connect Linear", row.error, row.status);
  const state = await signState(l.env.LINEAR_CLIENT_SECRET!, { user: who.viewer.name, board: row.id, exp: l.now() + STATE_MS });
  const q = new URLSearchParams({ client_id: l.env.LINEAR_CLIENT_ID!, redirect_uri: l.origin + CALLBACK_PATH, response_type: "code", scope: SCOPES, state, actor: "app", prompt: "consent" });
  return redirect(`${LINEAR_AUTHORIZE}?${q}`);
}

interface ViewerAnswer {
  viewer?: { id: string; name: string } | null;
  organization: { id: string; name: string; urlKey?: string };
  teams: { nodes: { id: string; key: string; name: string }[] };
  projects: { nodes: { id: string; name: string; teams?: { nodes: { id: string }[] } }[] };
}

/** GET /api/integrations/linear/callback: the code for tokens, kept sealed; then the team picker. */
export async function callback(l: Linear, viewer: Viewer | null, url: URL): Promise<Response> {
  const who = person(l, viewer, url, true);
  if (!who.ok) return who.res;
  const st = await readState(l.env.LINEAR_CLIENT_SECRET!, url.searchParams.get("state") ?? "", l.now());
  if (!st || st.user !== who.viewer.name) return msgPage(who.viewer, "This link expired", "Start again from the board: Connect Linear.", 400);
  if (url.searchParams.get("error")) return msgPage(who.viewer, "Linear wasn't connected", url.searchParams.get("error") === "access_denied" ? "You cancelled on Linear's side. Nothing changed." : `Linear said: ${url.searchParams.get("error")}.`);
  const row = await linkable(l, st.board, who.viewer.name);
  if (!("id" in row)) return msgPage(who.viewer, "Can't connect Linear", row.error, row.status);
  let info: ViewerAnswer;
  let s: Awaited<ReturnType<typeof sealed>>;
  try {
    const t = await tokenRequest(l, { grant_type: "authorization_code", code: url.searchParams.get("code") ?? "", redirect_uri: l.origin + CALLBACK_PATH });
    s = await sealed(l, t);
    info = await gql<ViewerAnswer>(l, t.access_token, Q_VIEWER);
    info.viewer = (await gql<{ viewer: ViewerAnswer["viewer"] }>(l, t.access_token, Q_ME).catch(() => null))?.viewer ?? null;
  } catch (e) {
    return msgPage(who.viewer, "Linear wasn't connected", e instanceof Error ? e.message : String(e), 502);
  }
  // A board has one Linear link: connecting again replaces its token (the old one is revoked). In the same organization
  // the team and the issue map carry over until another team is picked; another organization starts over.
  const old = await linkOf(l, row.id);
  if (old) await revoke(l, old);
  const keep = old && old.org_id === info.organization.id ? old : null;
  if (old && !keep) await l.db.prepare(`DELETE FROM linear_issues WHERE board_id = ?`).bind(row.id).run();
  const now = l.now();
  await l.db
    .prepare(
      `INSERT OR REPLACE INTO linear_links (board_id, created_by, org_id, org_name, linear_user, token, refresh, expires_at, team_id, team_key, team_name, project_id, project_name, states, blocked_label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id, who.viewer.name, info.organization.id, String(info.organization.name ?? "").slice(0, 120), info.viewer?.id ?? null, s.token, s.refresh, s.expires_at,
      keep?.team_id ?? null, keep?.team_key ?? null, keep?.team_name ?? null, keep?.project_id ?? null, keep?.project_name ?? null, keep?.states ?? null, keep?.blocked_label ?? null, now, now,
    )
    .run();
  await l.board.setLinear(row.id, !!keep?.team_id); // nothing syncs until a team is picked
  return pickerPage(who.viewer, row, info);
}

function pickerPage(viewer: Viewer, row: BoardLite, info: ViewerAnswer): Response {
  const teams = info.teams?.nodes ?? [];
  const projects = info.projects?.nodes ?? [];
  const teamOpts = teams.map((t, i) => `<label class="row" style="gap:8px;padding:4px 0"><input type="radio" name="team_id" value="${html(t.id)}"${i === 0 ? " checked" : ""}> <span>${html(t.name)} <span class="small muted">${html(t.key)}</span></span></label>`).join("");
  const projOpts = [`<option value="">No project</option>`, ...projects.map((p) => `<option value="${html(p.id)}">${html(p.name)}</option>`)].join("");
  const body = `<div class="card pad" style="max-width:520px;margin:24px auto 0">
<p class="small muted">Connect Linear · ${html(info.organization?.name ?? "")}</p><h1 style="font-size:20px;margin-top:4px">Which team gets ${html(row.title)}'s tasks?</h1>
${teams.length ? `<form method="post" action="/api/integrations/linear" style="margin-top:14px"><input type="hidden" name="board" value="${html(row.id)}">
<fieldset style="border:0;padding:0;margin:0;max-height:300px;overflow:auto">${teamOpts}</fieldset>
<p class="lbl" style="margin-top:14px">Project (optional)</p><select name="project_id" class="input">${projOpts}</select>
<p class="small muted" style="margin-top:12px">Each task on the board becomes an issue in that team once it changes. Status changes and comments on those issues come back to the board.</p>
<div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn primary">Connect</button></div></form>`
    : `<p class="muted" style="margin-top:12px">Your Linear account can't see any team.</p>`}
</div>`;
  return page("Connect Linear · Atteo", body, { viewer, narrow: true });
}

/** What GET /api/integrations/linear shows: never a token. */
function view(link: LinkRow | null, issues: number) {
  if (!link) return { linked: false };
  return {
    linked: true,
    ready: !!link.team_id,
    org: { id: link.org_id, name: link.org_name },
    team: link.team_id ? { id: link.team_id, key: link.team_key, name: link.team_name } : null,
    project: link.project_id ? { id: link.project_id, name: link.project_name } : null,
    blocked_label: !!link.blocked_label,
    created_by: link.created_by,
    created_at: link.created_at,
    issues,
  };
}

/** GET /api/integrations/linear?board=: whether and how the board is linked (any member; agents too, read only). */
export async function status(l: Linear, viewer: Viewer | null, url: URL): Promise<Response> {
  if (!linearOn(l.env)) return json({ error: NOT_SET_UP }, 503);
  if (!viewer) return json({ error: "sign in required" }, 401);
  const board = url.searchParams.get("board") ?? "";
  if (!/^b_[a-z0-9]{8,32}$/.test(board) || !(await roleOf(l, board, viewer.name))) return json({ error: "No such board." }, 404);
  const link = await linkOf(l, board);
  const n = link ? ((await l.db.prepare(`SELECT COUNT(*) AS n FROM linear_issues WHERE board_id = ?`).bind(board).first<{ n: number }>())?.n ?? 0) : 0;
  return json(view(link, n));
}

/** POST /api/integrations/linear {board, team_id, project_id?}: the team (and project) the board's tasks go to. */
export async function choose(l: Linear, viewer: Viewer | null, request: Request, url: URL): Promise<Response> {
  const who = person(l, viewer, url, false);
  if (!who.ok) return who.res;
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return json({ error: "Use Atteo's own pages." }, 403);
  const isForm = (request.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
  const raw = await request.text();
  let body: Record<string, unknown> = {};
  try {
    body = isForm ? Object.fromEntries(new URLSearchParams(raw)) : (JSON.parse(raw || "{}") as Record<string, unknown>);
  } catch {
    return json({ error: "Send JSON: {board, team_id, project_id?}" }, 400);
  }
  const fail = (error: string, code: number) => (isForm ? msgPage(who.viewer, "Linear wasn't connected", error, code) : json({ error }, code));
  const board = typeof body.board === "string" ? body.board : "";
  const teamId = typeof body.team_id === "string" ? body.team_id.trim() : "";
  const projectId = typeof body.project_id === "string" && body.project_id.trim() ? body.project_id.trim() : null;
  const row = await linkable(l, board, who.viewer.name);
  if (!("id" in row)) return fail(row.error, row.status);
  const link = await linkOf(l, row.id);
  if (!link) return fail("Connect Linear first: GET /api/integrations/linear/start?board=<id>.", 409);
  if (link.created_by !== who.viewer.name && (await roleOf(l, row.id, who.viewer.name)) !== "owner") return fail(`Only ${link.created_by} (who connected it) or a board owner can change it.`, 403);
  if (!teamId || teamId.length > 100) return fail("team_id is required.", 400);
  type Team = { id: string; key: string; name: string; states: { nodes: LinearState[] }; labels: { nodes: { id: string; name: string }[] } };
  type Project = { id: string; name: string; teams: { nodes: { id: string }[] } };
  let found: { team: Team | null; project: Project | null };
  try {
    const token = await accessToken(l, link);
    const t = (await gql<{ team: Team | null }>(l, token, Q_TEAM, { id: teamId })).team;
    const p = t && projectId ? (await gql<{ project: Project | null }>(l, token, Q_PROJECT, { id: projectId })).project : null;
    found = { team: t, project: p };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 502);
  }
  const { team, project } = found;
  if (!team) return fail("Linear has no such team for this account.", 400);
  if (projectId && (!project || !(project.teams?.nodes ?? []).some((x) => x.id === team.id))) return fail("That project isn't in that team.", 400);
  const states = (team.states?.nodes ?? []).map((s) => ({ id: s.id, name: s.name, type: s.type, position: Number(s.position) || 0 }));
  const label = (team.labels?.nodes ?? []).find((x) => x.name.trim().toLowerCase() === "blocked")?.id ?? null;
  // Another team means other issues: the map starts over.
  if (link.team_id && link.team_id !== team.id) await l.db.prepare(`DELETE FROM linear_issues WHERE board_id = ?`).bind(row.id).run();
  await l.db
    .prepare(`UPDATE linear_links SET team_id = ?, team_key = ?, team_name = ?, project_id = ?, project_name = ?, states = ?, blocked_label = ?, updated_at = ? WHERE board_id = ?`)
    .bind(team.id, team.key, String(team.name).slice(0, 120), project?.id ?? null, project ? String(project.name).slice(0, 120) : null, JSON.stringify(states), label, l.now(), row.id)
    .run();
  await l.board.setLinear(row.id, true);
  if (isForm) return redirect(`/b/${row.id}`);
  const n = (await l.db.prepare(`SELECT COUNT(*) AS n FROM linear_issues WHERE board_id = ?`).bind(row.id).first<{ n: number }>())?.n ?? 0;
  return json({ ok: true, ...view(await linkOf(l, row.id), n) });
}

/** DELETE /api/integrations/linear?board=: unlink (who linked it, or a board owner); the token is revoked at Linear. */
export async function unlink(l: Linear, viewer: Viewer | null, url: URL): Promise<Response> {
  const who = person(l, viewer, url, false);
  if (!who.ok) return who.res;
  const board = url.searchParams.get("board") ?? "";
  const role = /^b_[a-z0-9]{8,32}$/.test(board) ? await roleOf(l, board, who.viewer.name) : null;
  if (!role) return json({ error: "No such board." }, 404);
  const link = await linkOf(l, board);
  if (!link) return json({ ok: true, linked: false });
  if (link.created_by !== who.viewer.name && role !== "owner") return json({ error: `Only ${link.created_by} (who connected it) or a board owner can disconnect Linear.` }, 403);
  await revoke(l, link);
  await l.db.batch([l.db.prepare(`DELETE FROM linear_issues WHERE board_id = ?`).bind(board), l.db.prepare(`DELETE FROM linear_links WHERE board_id = ?`).bind(board)]);
  await l.board.setLinear(board, false).catch(() => {});
  return json({ ok: true, linked: false });
}
