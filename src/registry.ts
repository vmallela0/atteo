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
}

export async function recordBoard(env: Env, b: { id: string; title: string; created_by: string; created_at: number }) {
  await env.DB.prepare(
    `INSERT INTO boards (id, title, created_by, created_at, entry_count, last_activity) VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(b.id, b.title, b.created_by, b.created_at, b.created_at)
    .run();
}

/** Marks a user active on a board (creating user and membership rows on first sight). */
export async function touch(env: Env, user: string, boardId: string | null) {
  const now = Date.now();
  const stmts = [
    env.DB.prepare(
      `INSERT INTO users (name, first_seen, last_seen) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen`,
    ).bind(user, now, now),
  ];
  if (boardId) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO members (board_id, user, joined_at, last_seen) VALUES (?, ?, ?, ?)
         ON CONFLICT(board_id, user) DO UPDATE SET last_seen = excluded.last_seen`,
      ).bind(boardId, user, now, now),
    );
  }
  await env.DB.batch(stmts);
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
    `INSERT INTO invites (id, board_id, email, invited_by, created_at, email_status) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(inv.id, inv.board_id, inv.email, inv.invited_by, inv.created_at, inv.email_status)
    .run();
}
