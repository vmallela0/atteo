// Repo links identify a board. Only an owner deciding a join request adds a member; GitHub identity is not linked yet.

import { randomSecret } from "./auth";
import { checkCanAddMember } from "./billing";
import * as registry from "./registry";
import { checkOutsideMember } from "./policy";
import type { Env } from "./types";
import { offBoardSeq } from "./util";

export const REPO_RE = /^[a-z0-9][a-z0-9_.-]{0,99}\/[a-z0-9][a-z0-9_.-]{0,99}$/;
export const normalizeRepo = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const repo = value.toLowerCase();
  return REPO_RE.test(repo) && !repo.endsWith(".git") ? repo : null;
};

export interface JoinRequest {
  id: string;
  board_id: string;
  requester: string;
  status: "pending" | "approved" | "declined";
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  repo: string;
}

/** Only an exact server link can be used; a forged .atteo.json never picks an arbitrary board. */
export async function linkedBoard(env: Env, repo: string, boardId: string): Promise<registry.BoardRow | null> {
  const b = await env.DB.prepare(`SELECT b.* FROM repo_boards r JOIN boards b ON b.id = r.board_id WHERE r.repo = ? AND r.board_id = ?`).bind(repo, boardId).first<registry.BoardRow>();
  return b ?? null;
}

export async function ownedBoard(env: Env, owner: string, repo: string): Promise<registry.BoardRow | null> {
  return (await env.DB.prepare(`SELECT b.* FROM repo_boards r JOIN boards b ON b.id = r.board_id WHERE r.owner = ? AND r.repo = ?`).bind(owner, repo).first<registry.BoardRow>()) ?? null;
}

/** First creator wins a concurrent init; the unique key keeps one link for this owner and repo. */
export async function linkBoard(env: Env, owner: string, repo: string, boardId: string): Promise<string> {
  await env.DB.prepare(`INSERT OR IGNORE INTO repo_boards (owner, repo, board_id, linked_at) VALUES (?, ?, ?, ?)`).bind(owner, repo, boardId, Date.now()).run();
  const row = await env.DB.prepare(`SELECT board_id FROM repo_boards WHERE owner = ? AND repo = ?`).bind(owner, repo).first<{ board_id: string }>();
  return row!.board_id;
}

export async function requestJoin(env: Env, board: registry.BoardRow, requester: string): Promise<"member" | "pending" | "requested" | "cooldown"> {
  if (board.deleted_at || board.archived_at) throw new Error("This board is archived or deleted. Ask an owner to reopen it.");
  if (await registry.memberRole(env, board.id, requester)) return "member";
  // Future auto-let-in belongs here, after verified GitHub identity and collaborator proof. Neither exists today.
  const last = await env.DB.prepare(`SELECT status, created_at, decided_at FROM repo_join_requests WHERE board_id = ? AND requester = ? ORDER BY created_at DESC LIMIT 1`).bind(board.id, requester).first<{ status: string; created_at: number; decided_at: number | null }>();
  if (last?.status === "pending") return "pending";
  if (last?.status === "declined" && Date.now() - (last.decided_at ?? last.created_at) < 86_400_000) return "cooldown";
  const id = randomSecret("jr_", 9), now = Date.now();
  const owners = (await registry.boardMembers(env, board.id)).filter((m) => m.role === "owner");
  // Notifications have an empty board id because the requester is not a member. The owner's UI resolves the id itself.
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO repo_join_requests (id, board_id, requester, status, created_at) VALUES (?, ?, ?, 'pending', ?)`).bind(id, board.id, requester, now).run();
  if (!inserted.meta.changes) return "pending";
  await env.DB.batch(owners.map((o) => env.DB.prepare(`INSERT OR IGNORE INTO notifications (user, board_id, seq, kind, actor, actor_via, entry_type, excerpt, created_at, data) VALUES (?, '', ?, 'repo_join', ?, 'person', 'repo_join', ?, ?, ?)`).bind(o.user, offBoardSeq(), requester, `${requester} asks to join a repo board`, now, JSON.stringify({ join: id }))));
  return "requested";
}

/** Pending requests on boards this person still owns. */
export async function forOwner(env: Env, owner: string): Promise<JoinRequest[]> {
  return (await env.DB.prepare(`SELECT j.*, r.repo FROM repo_join_requests j JOIN repo_boards r ON r.board_id = j.board_id JOIN boards b ON b.id = j.board_id JOIN members m ON m.board_id = j.board_id AND m.user = ? WHERE j.status = 'pending' AND m.role = 'owner' AND (m.expires_at IS NULL OR m.expires_at > ?) AND b.archived_at IS NULL AND b.deleted_at IS NULL ORDER BY j.created_at DESC LIMIT 100`).bind(owner, Date.now()).all<JoinRequest>()).results;
}

/** No agent token may call this. Recheck ownership and board state at the moment of the decision. */
export async function decide(env: Env, id: string, owner: string, allow: boolean, origin: string): Promise<JoinRequest> {
  const request = await env.DB.prepare(`SELECT j.*, r.repo FROM repo_join_requests j JOIN repo_boards r ON r.board_id = j.board_id WHERE j.id = ?`).bind(id).first<JoinRequest>();
  if (!request || (await registry.memberRole(env, request.board_id, owner)) !== "owner") throw new Error("Join request not found.");
  const board = await registry.getBoard(env, request.board_id);
  if (!board || board.deleted_at || board.archived_at) throw new Error("This board is archived or deleted. Reopen it before deciding.");
  if (request.status !== "pending") throw new Error("This join request was already decided.");
  if (allow) {
    await checkCanAddMember(env, board.id, origin);
    const joiner = await registry.userByName(env, request.requester);
    await checkOutsideMember(env, board.id, joiner?.email ?? null);
  }
  const now = Date.now();
  const changed = await env.DB.prepare(`UPDATE repo_join_requests SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'`).bind(allow ? "approved" : "declined", now, owner, id).run();
  if (!changed.meta.changes) throw new Error("This join request was already decided.");
  if (allow) {
    await env.DB.prepare(`DELETE FROM members WHERE board_id = ? AND user = ? AND expires_at IS NOT NULL AND expires_at < ?`).bind(board.id, request.requester, now).run();
    await registry.addMember(env, board.id, request.requester, { role: "contributor", added_by: owner });
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE kind = 'repo_join' AND json_extract(data, '$.join') = ?`).bind(now, id),
    env.DB.prepare(`INSERT INTO audit (board_id, actor, action, target, detail, ts) VALUES (?, ?, ?, ?, ?, ?)`).bind(board.id, owner, allow ? "joined" : "join_declined", request.requester, "repo request", now),
  ]);
  return { ...request, status: allow ? "approved" : "declined", decided_at: now, decided_by: owner };
}
