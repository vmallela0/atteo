// Browser-only agent connections and their hashed 90-day web sessions. A person creates a connection by approving the
// agent's 10-minute device request; there is no username, password, setup code minted by the person, or URL secret.

import { randomSecret, readCookie, sha256hex } from "./auth";
import type { Env } from "./types";

export const AGENT_COOKIE = "atteo_agent";
export const AGENT_PENDING_COOKIE = "atteo_agent_pending";
export const MAX_LIVE_AGENT_LOGINS = 10;
export const AGENT_SESSION_TTL_MS = 90 * 86_400_000;
const BOARD_RE = /^b_[a-z0-9]{8,32}$/;

export interface AgentLoginView {
  id: string;
  label: string;
  boards: string[] | null;
  email_alerts: boolean;
  created_at: number;
  last_used: number | null;
  revoked: boolean;
}

interface AgentLoginRow {
  id: string;
  user: string;
  label: string;
  boards: string | null;
  email_alerts: number;
  created_at: number;
  last_used: number | null;
  revoked_at: number | null;
}

export interface AgentWebIdentity {
  login_id: string;
  user: string;
  label: string;
  boards: string[] | null;
  email_alerts: boolean;
  session_hash: string;
  expires_at: number;
  session_secret: string;
}

export class AgentLoginError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function parseBoards(raw: string | null): string[] | null {
  if (raw == null) return null;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function view(row: Pick<AgentLoginRow, "id" | "label" | "boards" | "email_alerts" | "created_at" | "last_used" | "revoked_at">): AgentLoginView {
  return { id: row.id, label: row.label, boards: parseBoards(row.boards), email_alerts: !!row.email_alerts, created_at: row.created_at, last_used: row.last_used, revoked: row.revoked_at != null };
}

export async function checkedAgentBoards(env: Env, user: string, input: unknown): Promise<string[] | null> {
  if (input === null) return null;
  if (!Array.isArray(input)) throw new AgentLoginError("boards must be an array of board ids, or omitted for all boards");
  const boards = [...new Set(input.map(String))];
  if (boards.length > 100 || boards.some((id) => !BOARD_RE.test(id))) throw new AgentLoginError("boards must contain at most 100 valid board ids");
  for (const id of boards) {
    const member = await env.DB.prepare(`SELECT 1 AS ok FROM members m JOIN boards b ON b.id = m.board_id WHERE m.board_id = ? AND m.user = ? AND (m.expires_at IS NULL OR m.expires_at > ?) AND b.kind IS NULL AND b.deleted_at IS NULL`).bind(id, user, Date.now()).first();
    if (!member) throw new AgentLoginError(`You are not a member of board ${id}.`, 403);
  }
  return boards;
}

/** Called only while approving an agent-kind device request. The conditional insert ties it to that still-pending row. */
export async function approveAgentLogin(env: Env, userCode: string, user: string, body: { label?: unknown; boards?: unknown; email_alerts?: unknown }, now = Date.now()): Promise<AgentLoginView> {
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM agent_logins WHERE user = ? AND revoked_at IS NULL`).bind(user).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_LIVE_AGENT_LOGINS) throw new AgentLoginError(`You already have ${MAX_LIVE_AGENT_LOGINS} live agent sign-ins. Revoke one first.`, 409);
  const label = String(body.label ?? "browser agent").trim().slice(0, 80) || "browser agent";
  const boards = await checkedAgentBoards(env, user, body.boards);
  // Opt-in (jxn #6350, vedu's agent #6354): no alert email unless the person ticks the box when approving.
  const emailAlerts = body.email_alerts === true || body.email_alerts === "true" ? 1 : 0;
  const id = `agl_${randomSecret("", 12)}`;
  const serialized = boards == null ? null : JSON.stringify(boards);
  // D1 batch is transactional: the login and the device decision appear together, and concurrent taps cannot make two.
  const [inserted, decided] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agent_logins (id, user, label, boards, email_alerts, created_at)
       SELECT ?, ?, ?, ?, ?, ? FROM device_logins
       WHERE user_code = ? AND kind = 'agent' AND status = 'pending' AND expires_at > ?`,
    ).bind(id, user, label, serialized, emailAlerts, now, userCode, now),
    env.DB.prepare(
      `UPDATE device_logins SET status = 'approved', approved_by = ?, label = ?, boards = ?, agent_login_id = ?
       WHERE user_code = ? AND kind = 'agent' AND status = 'pending'
         AND EXISTS (SELECT 1 FROM agent_logins WHERE id = ?)`,
    ).bind(user, label, serialized, id, userCode, id),
  ]);
  if ((inserted.meta?.changes ?? 0) !== 1 || (decided.meta?.changes ?? 0) !== 1) throw new AgentLoginError("That sign-in request was already used or expired.", 409);
  return { id, label, boards, email_alerts: !!emailAlerts, created_at: now, last_used: null, revoked: false };
}

export async function listAgentLogins(env: Env, user: string): Promise<AgentLoginView[]> {
  const rows = (await env.DB.prepare(`SELECT id, label, boards, email_alerts, created_at, last_used, revoked_at FROM agent_logins WHERE user = ? ORDER BY created_at DESC`).bind(user).all<Pick<AgentLoginRow, "id" | "label" | "boards" | "email_alerts" | "created_at" | "last_used" | "revoked_at">>()).results;
  return rows.map(view);
}

export async function setAgentEmailAlerts(env: Env, user: string, id: string, on: boolean): Promise<boolean> {
  const changed = await env.DB.prepare(`UPDATE agent_logins SET email_alerts = ? WHERE id = ? AND user = ? AND revoked_at IS NULL`).bind(on ? 1 : 0, id, user).run();
  return (changed.meta?.changes ?? 0) === 1;
}

export async function revokeAgentLogin(env: Env, user: string, id: string, now = Date.now()): Promise<boolean> {
  const changed = await env.DB.prepare(`UPDATE agent_logins SET revoked_at = ? WHERE id = ? AND user = ? AND revoked_at IS NULL`).bind(now, id, user).run();
  if ((changed.meta?.changes ?? 0) !== 1) return false;
  await env.DB.prepare(`DELETE FROM agent_web_sessions WHERE login_id = ?`).bind(id).run();
  return true;
}

export async function revokeAllAgentLogins(env: Env, user: string, now = Date.now()): Promise<number> {
  const changed = await env.DB.prepare(`UPDATE agent_logins SET revoked_at = ? WHERE user = ? AND revoked_at IS NULL`).bind(now, user).run();
  await env.DB.prepare(`DELETE FROM agent_web_sessions WHERE login_id IN (SELECT id FROM agent_logins WHERE user = ?)`).bind(user).run();
  return changed.meta?.changes ?? 0;
}

export async function createAgentWebSession(env: Env, login: Pick<AgentLoginRow, "id">, now = Date.now()): Promise<string> {
  const secret = randomSecret("aws_", 32);
  await env.DB.prepare(`INSERT INTO agent_web_sessions (id_hash, login_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(await sha256hex(secret), login.id, now, now + AGENT_SESSION_TTL_MS).run();
  await env.DB.prepare(`UPDATE agent_logins SET last_used = ? WHERE id = ?`).bind(now, login.id).run();
  return secret;
}

export type AgentRedeem = { status: "pending" | "denied" | "expired" | "used" } | { status: "ok"; session: string; user: string; login_id: string };

/** The requesting browser redeems an approved request once. Its device code came from its strict HttpOnly cookie. */
export async function redeemAgentDevice(env: Env, deviceCode: string, now = Date.now(), deviceHash?: string): Promise<AgentRedeem> {
  const hash = deviceHash ?? await sha256hex(deviceCode);
  const d = await env.DB.prepare(`SELECT expires_at, status, approved_by, agent_login_id FROM device_logins WHERE device_hash = ? AND kind = 'agent'`)
    .bind(hash).first<{ expires_at: number; status: string; approved_by: string | null; agent_login_id: string | null }>();
  if (!d || d.expires_at <= now) return { status: "expired" };
  if (d.status === "pending") return { status: "pending" };
  if (d.status === "denied") return { status: "denied" };
  if (d.status === "issued") return { status: "used" };
  if (d.status !== "approved" || !d.approved_by || !d.agent_login_id) return { status: "expired" };
  const login = await env.DB.prepare(`SELECT id FROM agent_logins WHERE id = ? AND user = ? AND revoked_at IS NULL`).bind(d.agent_login_id, d.approved_by).first<{ id: string }>();
  if (!login) return { status: "used" };
  const session = randomSecret("aws_", 32);
  const sessionHash = await sha256hex(session);
  const [created, claimed] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agent_web_sessions (id_hash, login_id, created_at, expires_at)
       SELECT ?, agent_login_id, ?, ? FROM device_logins
       WHERE device_hash = ? AND kind = 'agent' AND status = 'approved' AND expires_at > ?`,
    ).bind(sessionHash, now, now + AGENT_SESSION_TTL_MS, hash, now),
    env.DB.prepare(
      `UPDATE device_logins SET status = 'issued' WHERE device_hash = ? AND kind = 'agent' AND status = 'approved'
       AND EXISTS (SELECT 1 FROM agent_web_sessions WHERE id_hash = ?)`,
    ).bind(hash, sessionHash),
    env.DB.prepare(`UPDATE agent_logins SET last_used = ? WHERE id = ? AND EXISTS (SELECT 1 FROM agent_web_sessions WHERE id_hash = ?)`).bind(now, login.id, sessionHash),
  ]);
  if ((created.meta?.changes ?? 0) !== 1 || (claimed.meta?.changes ?? 0) !== 1) return { status: "used" };
  return { status: "ok", session, user: d.approved_by, login_id: login.id };
}

export async function getAgentWebIdentity(request: Request, env: Env, now = Date.now()): Promise<AgentWebIdentity | null> {
  const secret = readCookie(request, AGENT_COOKIE);
  if (!secret) return null;
  const hash = await sha256hex(secret);
  const row = await env.DB.prepare(
    `SELECT s.login_id, s.expires_at, l.user, l.label, l.boards, l.email_alerts, l.revoked_at
     FROM agent_web_sessions s JOIN agent_logins l ON l.id = s.login_id WHERE s.id_hash = ?`,
  ).bind(hash).first<{ login_id: string; expires_at: number; user: string; label: string; boards: string | null; email_alerts: number; revoked_at: number | null }>();
  if (!row || row.revoked_at != null || row.expires_at <= now) {
    if (row) await env.DB.prepare(`DELETE FROM agent_web_sessions WHERE id_hash = ?`).bind(hash).run();
    return null;
  }
  await env.DB.prepare(`UPDATE agent_logins SET last_used = ? WHERE id = ? AND (last_used IS NULL OR last_used < ?)`).bind(now, row.login_id, now - 60_000).run();
  return { login_id: row.login_id, user: row.user, label: row.label, boards: parseBoards(row.boards), email_alerts: !!row.email_alerts, session_hash: hash, expires_at: row.expires_at, session_secret: secret };
}

export async function deleteAgentWebSession(request: Request, env: Env): Promise<void> {
  const secret = readCookie(request, AGENT_COOKIE);
  if (secret) await env.DB.prepare(`DELETE FROM agent_web_sessions WHERE id_hash = ?`).bind(await sha256hex(secret)).run();
}

export async function csrfFor(sessionSecret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(sessionSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode("atteo-agent-csrf-v1")));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function boardAllowed(identity: AgentWebIdentity, boardId: string): boolean {
  return identity.boards == null || identity.boards.includes(boardId);
}
