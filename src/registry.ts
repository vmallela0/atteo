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
  workos_id: string | null;
  display_name: string | null;
  first_seen: number;
  last_seen: number;
}

export async function userByName(env: Env, name: string): Promise<FullUser | null> {
  return env.DB.prepare(`SELECT name, email, workos_id, display_name, first_seen, last_seen FROM users WHERE name = ?`).bind(name).first<FullUser>();
}

export async function userByWorkosId(env: Env, workosId: string): Promise<FullUser | null> {
  return env.DB.prepare(`SELECT name, email, workos_id, display_name, first_seen, last_seen FROM users WHERE workos_id = ?`).bind(workosId).first<FullUser>();
}

/** A user row with this (verified) email that has not been linked to a WorkOS account yet. */
export async function unlinkedUserByEmail(env: Env, email: string): Promise<FullUser | null> {
  return env.DB.prepare(
    `SELECT name, email, workos_id, display_name, first_seen, last_seen FROM users WHERE lower(email) = lower(?) AND workos_id IS NULL`,
  )
    .bind(email)
    .first<FullUser>();
}

export async function userByEmail(env: Env, email: string): Promise<FullUser | null> {
  return env.DB.prepare(`SELECT name, email, workos_id, display_name, first_seen, last_seen FROM users WHERE lower(email) = lower(?)`)
    .bind(email)
    .first<FullUser>();
}

export async function createUser(env: Env, u: { name: string; email: string | null; workos_id: string | null; display_name: string | null }) {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO users (name, email, workos_id, display_name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(u.name, u.email, u.workos_id, u.display_name, now, now)
    .run();
}

export async function linkWorkos(env: Env, name: string, workosId: string, email: string, displayName: string | null) {
  await env.DB.prepare(`UPDATE users SET workos_id = ?, email = ?, display_name = COALESCE(display_name, ?), last_seen = ? WHERE name = ?`)
    .bind(workosId, email, displayName, Date.now(), name)
    .run();
}

// ---------- invites ----------

/** Adds the user to every board with a pending invite for this email. Returns the board ids. */
export async function acceptInvites(env: Env, email: string, user: string): Promise<string[]> {
  const r = await env.DB.prepare(`SELECT id, board_id FROM invites WHERE lower(email) = lower(?) AND accepted_at IS NULL`)
    .bind(email)
    .all<{ id: string; board_id: string }>();
  const now = Date.now();
  for (const inv of r.results) {
    await addMember(env, inv.board_id, user);
    await env.DB.prepare(`UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ?`).bind(now, user, inv.id).run();
  }
  return [...new Set(r.results.map((i) => i.board_id))];
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
