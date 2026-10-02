// D1 directory: which boards exist, who uses them, and invites. Kept in step with the boards by the Worker.

import type { Env } from "./types";

export interface BoardRow {
  id: string;
  title: string;
  created_by: string;
  created_at: number;
  entry_count: number;
  last_activity: number;
}

export interface UserRow {
  name: string;
  email: string | null;
  display_name: string | null;
  workos_id: string | null;
  first_seen: number;
  last_seen: number;
  boards: number;
}

export interface MemberRow {
  board_id: string;
  user: string;
  joined_at: number;
  last_seen: number;
}

export interface InviteRow {
  id: string;
  board_id: string;
  email: string;
  invited_by: string;
  created_at: number;
  email_status: string;
  accepted_at?: number | null;
  accepted_by?: string | null;
  workos_invitation_id?: string | null;
}

export async function recordBoard(env: Env, b: { id: string; title: string; created_by: string; created_at: number }) {
  await env.DB.prepare(
    `INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity) VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(b.id, b.title, b.created_by, b.created_at, b.created_at)
    .run();
}

/** Marks a user active (and, if they are already a member, active on that board). Never grants membership. */
export async function touch(env: Env, user: string, boardId: string | null) {
  const now = Date.now();
  const stmts = [env.DB.prepare(`UPDATE users SET last_seen = ? WHERE name = ?`).bind(now, user)];
  if (boardId) {
    stmts.push(env.DB.prepare(`UPDATE members SET last_seen = ? WHERE board_id = ? AND user = ?`).bind(now, boardId, user));
  }
  await env.DB.batch(stmts);
}

/** The only way into a board: creating it, an accepted invite, or an existing member adding someone. */
export async function addMember(env: Env, boardId: string, user: string) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO members (board_id, user, joined_at, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(board_id, user) DO NOTHING`,
  )
    .bind(boardId, user, now, now)
    .run();
}

export async function removeMember(env: Env, boardId: string, user: string) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM members WHERE board_id = ? AND user = ?`).bind(boardId, user),
    env.DB.prepare(`UPDATE mcp_sessions SET board_id = NULL WHERE board_id = ? AND user = ?`).bind(boardId, user),
  ]);
}

/** Removes a board from the directory: memberships, invitations, joined sessions, and the board row. */
export async function deleteBoard(env: Env, boardId: string) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM members WHERE board_id = ?`).bind(boardId),
    env.DB.prepare(`DELETE FROM invites WHERE board_id = ?`).bind(boardId),
    env.DB.prepare(`UPDATE mcp_sessions SET board_id = NULL WHERE board_id = ?`).bind(boardId),
    env.DB.prepare(`DELETE FROM boards WHERE id = ?`).bind(boardId),
  ]);
}

export async function isMember(env: Env, boardId: string, user: string): Promise<boolean> {
  const r = await env.DB.prepare(`SELECT 1 AS ok FROM members WHERE board_id = ? AND user = ?`).bind(boardId, user).first();
  return !!r;
}

export async function boardMembers(env: Env, boardId: string): Promise<{ user: string; joined_at: number; last_seen: number; display_name: string | null }[]> {
  const r = await env.DB.prepare(
    `SELECT m.user, m.joined_at, m.last_seen, u.display_name FROM members m LEFT JOIN users u ON u.name = m.user WHERE m.board_id = ? ORDER BY m.joined_at`,
  )
    .bind(boardId)
    .all<{ user: string; joined_at: number; last_seen: number; display_name: string | null }>();
  return r.results;
}

export async function getBoard(env: Env, id: string): Promise<BoardRow | null> {
  return env.DB.prepare(`SELECT * FROM boards WHERE id = ?`).bind(id).first<BoardRow>();
}

// ---------- users ----------

export interface FullUser {
  name: string;
  email: string | null;
  email_verified: number;
  workos_id: string | null;
  display_name: string | null;
  first_seen: number;
  last_seen: number;
}

export async function userByName(env: Env, name: string): Promise<FullUser | null> {
  return env.DB.prepare(`SELECT name, email, email_verified, workos_id, display_name, first_seen, last_seen FROM users WHERE name = ?`).bind(name).first<FullUser>();
}

export async function userByWorkosId(env: Env, workosId: string): Promise<FullUser | null> {
  return env.DB.prepare(`SELECT name, email, email_verified, workos_id, display_name, first_seen, last_seen FROM users WHERE workos_id = ?`).bind(workosId).first<FullUser>();
}

/** A user row with this (verified) email that has not been linked to a WorkOS account yet. */
export async function unlinkedUserByEmail(env: Env, email: string): Promise<FullUser | null> {
  return env.DB.prepare(
    `SELECT name, email, email_verified, workos_id, display_name, first_seen, last_seen FROM users WHERE lower(email) = lower(?) AND workos_id IS NULL`,
  )
    .bind(email)
    .first<FullUser>();
}

export async function userByEmail(env: Env, email: string): Promise<FullUser | null> {
  return env.DB.prepare(`SELECT name, email, email_verified, workos_id, display_name, first_seen, last_seen FROM users WHERE lower(email) = lower(?)`)
    .bind(email)
    .first<FullUser>();
}

export async function createUser(
  env: Env,
  u: { name: string; email: string | null; email_verified?: boolean; workos_id: string | null; display_name: string | null },
) {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO users (name, email, email_verified, workos_id, display_name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(u.name, u.email, u.email_verified ? 1 : 0, u.workos_id, u.display_name, now, now)
    .run();
}

export async function linkWorkos(env: Env, name: string, workosId: string, email: string, displayName: string | null, verified: boolean) {
  await env.DB.prepare(
    `UPDATE users SET workos_id = ?, email = ?, email_verified = ?, display_name = COALESCE(display_name, ?), last_seen = ? WHERE name = ?`,
  )
    .bind(workosId, email, verified ? 1 : 0, displayName, Date.now(), name)
    .run();
}

/** Refreshed on every sign-in from what WorkOS reports. */
export async function setEmailVerified(env: Env, name: string, email: string, verified: boolean) {
  await env.DB.prepare(`UPDATE users SET email = ?, email_verified = ?, last_seen = ? WHERE name = ?`).bind(email, verified ? 1 : 0, Date.now(), name).run();
}

// ---------- invites ----------

export interface Invitation {
  id: string;
  board_id: string;
  board_title: string;
  invited_by: string;
  created_at: number;
}

/** Open invitations addressed to this user's email. Only a WorkOS-verified email can see or accept them. */
export async function invitationsFor(env: Env, user: FullUser): Promise<Invitation[]> {
  if (!user.email || !user.email_verified) return [];
  const r = await env.DB.prepare(
    `SELECT i.id, i.board_id, b.title AS board_title, i.invited_by, MAX(i.created_at) AS created_at
     FROM invites i JOIN boards b ON b.id = i.board_id
     WHERE lower(i.email) = lower(?) AND i.accepted_at IS NULL AND i.declined_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM members m WHERE m.board_id = i.board_id AND m.user = ?)
     GROUP BY i.board_id ORDER BY created_at DESC`,
  )
    .bind(user.email, user.name)
    .all<Invitation>();
  return r.results;
}

/** Accepts the user's open invitation(s) to a board: adds them as a member. Returns false if there was none. */
export async function acceptInvitation(env: Env, user: FullUser, boardId: string): Promise<boolean> {
  if (!(await invitationsFor(env, user)).some((i) => i.board_id === boardId)) return false;
  await addMember(env, boardId, user.name);
  await env.DB.prepare(
    `UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE board_id = ? AND lower(email) = lower(?) AND accepted_at IS NULL AND declined_at IS NULL`,
  )
    .bind(Date.now(), user.name, boardId, user.email)
    .run();
  return true;
}

export async function declineInvitation(env: Env, user: FullUser, boardId: string): Promise<boolean> {
  if (!(await invitationsFor(env, user)).some((i) => i.board_id === boardId)) return false;
  await env.DB.prepare(`UPDATE invites SET declined_at = ? WHERE board_id = ? AND lower(email) = lower(?) AND accepted_at IS NULL AND declined_at IS NULL`)
    .bind(Date.now(), boardId, user.email)
    .run();
  return true;
}

export async function hasOpenInvite(env: Env, boardId: string, email: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `SELECT 1 AS ok FROM invites WHERE board_id = ? AND lower(email) = lower(?) AND accepted_at IS NULL AND declined_at IS NULL`,
  )
    .bind(boardId, email)
    .first();
  return !!r;
}

// ---------- MCP sessions: which board each agent session has joined ----------

export async function mcpSessionBoard(env: Env, sessionId: string, user: string): Promise<string | null> {
  const r = await env.DB.prepare(`SELECT board_id FROM mcp_sessions WHERE id = ? AND user = ?`).bind(sessionId, user).first<{ board_id: string | null }>();
  return r?.board_id ?? null;
}

export async function setMcpSessionBoard(env: Env, sessionId: string, user: string, boardId: string | null) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO mcp_sessions (id, user, board_id, created_at, last_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET board_id = excluded.board_id, last_seen = excluded.last_seen WHERE mcp_sessions.user = excluded.user`,
  )
    .bind(sessionId, user, boardId, now, now)
    .run();
}

export async function touchMcpSession(env: Env, sessionId: string, user: string) {
  await env.DB.prepare(`UPDATE mcp_sessions SET last_seen = ? WHERE id = ? AND user = ?`).bind(Date.now(), sessionId, user).run();
}

export const AGENT_LIVE_MS = 10 * 60 * 1000;

/** Members whose agent has a session on this board that was active in the last 10 minutes. */
export async function agentsOnBoard(env: Env, boardId: string): Promise<Record<string, number>> {
  const r = await env.DB.prepare(`SELECT user, MAX(last_seen) AS seen FROM mcp_sessions WHERE board_id = ? AND last_seen > ? GROUP BY user`)
    .bind(boardId, Date.now() - AGENT_LIVE_MS)
    .all<{ user: string; seen: number }>();
  return Object.fromEntries(r.results.map((x) => [x.user, x.seen]));
}

/** Whether this person has set up an agent (an active token that has been used), and when it was last active. */
export async function agentStatus(env: Env, user: string): Promise<{ connected: boolean; lastUsed: number | null }> {
  const r = await env.DB.prepare(`SELECT MAX(last_used) AS last FROM tokens WHERE user = ? AND revoked_at IS NULL`).bind(user).first<{ last: number | null }>();
  return { connected: !!r?.last, lastUsed: r?.last ?? null };
}

export async function endMcpSession(env: Env, sessionId: string) {
  await env.DB.prepare(`DELETE FROM mcp_sessions WHERE id = ?`).bind(sessionId).run();
}

export async function pendingInvites(env: Env, boardId: string): Promise<InviteRow[]> {
  const r = await env.DB.prepare(`SELECT * FROM invites WHERE board_id = ? AND accepted_at IS NULL ORDER BY created_at DESC`).bind(boardId).all<InviteRow>();
  return r.results;
}

export async function bumpBoard(env: Env, boardId: string, entryCount: number) {
  await env.DB.prepare(`UPDATE boards SET entry_count = MAX(entry_count, ?), last_activity = ? WHERE id = ?`).bind(entryCount, Date.now(), boardId).run();
}

export async function boardsForUser(env: Env, user: string): Promise<(BoardRow & { joined_at: number })[]> {
  const r = await env.DB.prepare(
    `SELECT b.*, m.joined_at FROM members m JOIN boards b ON b.id = m.board_id WHERE m.user = ? ORDER BY b.last_activity DESC`,
  )
    .bind(user)
    .all<BoardRow & { joined_at: number }>();
  return r.results;
}

export async function allBoards(env: Env): Promise<(BoardRow & { members: string | null })[]> {
  const r = await env.DB.prepare(
    `SELECT b.*, (SELECT GROUP_CONCAT(user, ', ') FROM members m WHERE m.board_id = b.id) AS members
     FROM boards b ORDER BY b.last_activity DESC`,
  ).all<BoardRow & { members: string | null }>();
  return r.results;
}

export async function allUsers(env: Env): Promise<UserRow[]> {
  const r = await env.DB.prepare(
    `SELECT u.*, (SELECT COUNT(*) FROM members m WHERE m.user = u.name) AS boards FROM users u ORDER BY u.last_seen DESC`,
  ).all<UserRow>();
  return r.results;
}

export async function allInvites(env: Env): Promise<(InviteRow & { board_title: string | null })[]> {
  const r = await env.DB.prepare(
    `SELECT i.*, b.title AS board_title FROM invites i LEFT JOIN boards b ON b.id = i.board_id ORDER BY i.created_at DESC LIMIT 200`,
  ).all<InviteRow & { board_title: string | null }>();
  return r.results;
}

export async function recordInvite(env: Env, inv: InviteRow) {
  await env.DB.prepare(
    `INSERT INTO invites (id, board_id, email, invited_by, created_at, email_status, accepted_at, accepted_by, workos_invitation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(inv.id, inv.board_id, inv.email, inv.invited_by, inv.created_at, inv.email_status, inv.accepted_at ?? null, inv.accepted_by ?? null, inv.workos_invitation_id ?? null)
    .run();
}
