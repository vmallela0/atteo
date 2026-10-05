// Deleting an account (Apple 5.1.1(v); jxn #4329): the person's messages stay on the boards they shared, under a
// tombstone shown as "Deleted user"; everything that is theirs alone goes. The tombstone is random, not a hash of the
// handle, so it can't be walked back to who it was. The handle itself is never given out again: only its SHA-256 is
// kept (deleted_handles), so nobody can later post as the name old messages and links still point at.

import * as registry from "./registry";
import { forgetUserTokens, sha256hex } from "./auth";
import type { Env } from "./types";

/** Tombstones look like "deleted-3f9a1c2b7e": a handle no one can register (isTombstone, isReservedHandle). */
export const TOMBSTONE_PREFIX = "deleted-";
export const isTombstone = (name: string | null | undefined): boolean => !!name && /^deleted-[0-9a-f]{10}$/.test(name);
/** What a tombstone reads as, everywhere a name is shown. */
export const DELETED_LABEL = "Deleted user";
export const shownName = (name: string): string => (isTombstone(name) ? DELETED_LABEL : name);

export function newTombstone(): string {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return TOMBSTONE_PREFIX + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Has this handle belonged to a deleted account? (Then it stays taken, forever.) */
export async function isDeletedHandle(env: Env, name: string): Promise<boolean> {
  const r = await env.DB.prepare(`SELECT 1 AS x FROM deleted_handles WHERE hash = ?`).bind(await sha256hex(name.toLowerCase())).first();
  return !!r;
}

export interface BoardForget {
  forgetUser(user: string, tomb: string): Promise<unknown>;
  destroy(): Promise<void>;
}

export interface DeleteResult {
  tombstone: string;
  boards_kept: number;
  boards_removed: number;
  owners_promoted: number;
  /** They paid for Pro: the Stripe subscription is NOT cancelled here; ops does that by hand. */
  stripe_followup: boolean;
}

/**
 * Deletes `name`'s account. Boards they share keep their messages, attributed to the tombstone; boards only they
 * could see (their own agent board, or one nobody else is left on) are destroyed. A board left without an owner gets
 * its longest-standing member as owner. Every statement binds a fixed handful of values (D1 caps a query at 100).
 */
export async function deleteAccount(env: Env, name: string, stub: (boardId: string) => BoardForget): Promise<DeleteResult> {
  const user = await registry.userByName(env, name);
  if (!user) throw new Error("No such account.");
  const tomb = newTombstone();
  const memberships = (await env.DB.prepare(`SELECT m.board_id AS id, m.role AS role, b.kind AS kind, b.created_by AS created_by FROM members m LEFT JOIN boards b ON b.id = m.board_id WHERE m.user = ?`).bind(name).all<{ id: string; role: string; kind: string | null; created_by: string | null }>()).results;

  let kept = 0, removed = 0, promoted = 0;
  for (const m of memberships) {
    const others = (await env.DB.prepare(`SELECT user, role FROM members WHERE board_id = ? AND user != ? ORDER BY joined_at, user`).bind(m.id, name).all<{ user: string; role: string }>()).results.filter((o) => !isTombstone(o.user));
    if (m.kind === "agent" || !others.length) {
      // Theirs alone: nothing shared to keep.
      await stub(m.id).destroy().catch(() => {});
      await registry.deleteBoard(env, m.id);
      removed++;
      continue;
    }
    await stub(m.id).forgetUser(name, tomb);
    await registry.removeMember(env, m.id, name);
    if (m.role === "owner" && !others.some((o) => o.role === "owner")) {
      await registry.setMemberAccess(env, m.id, others[0].user, { role: "owner" });
      await registry.audit(env, m.id, tomb, "owner.promoted", others[0].user, "the only owner deleted their account");
      promoted++;
    }
    await registry.audit(env, m.id, tomb, "account.deleted", null, null);
    kept++;
  }

  const email = user.email ?? null;
  const stripe = await env.DB.prepare(`SELECT stripe_customer FROM users WHERE name = ?`).bind(name).first<{ stripe_customer: string | null }>();
  const n = name, t = tomb;
  const S = (sql: string, ...v: unknown[]) => env.DB.prepare(sql).bind(...v);
  // What other people's records say about them: kept, pointing at the tombstone.
  const rename = [
    S(`UPDATE boards SET created_by = ? WHERE created_by = ?`, t, n),
    S(`UPDATE boards SET last_author = ? WHERE last_author = ?`, t, n),
    S(`UPDATE boards SET deleted_by = ? WHERE deleted_by = ?`, t, n),
    S(`UPDATE boards SET member_notes = json_remove(member_notes, '$."' || ? || '"') WHERE member_notes IS NOT NULL AND json_valid(member_notes) AND json_type(member_notes, '$."' || ? || '"') IS NOT NULL`, n, n),
    S(`UPDATE members SET added_by = ? WHERE added_by = ?`, t, n),
    S(`UPDATE invites SET invited_by = ? WHERE invited_by = ?`, t, n),
    S(`UPDATE invites SET accepted_by = ? WHERE accepted_by = ?`, t, n),
    S(`UPDATE invite_links SET created_by = ? WHERE created_by = ?`, t, n),
    S(`UPDATE audit SET actor = ? WHERE actor = ?`, t, n),
    S(`UPDATE audit SET target = ? WHERE target = ?`, t, n),
    S(`UPDATE reports SET reporter = ? WHERE reporter = ?`, t, n),
    S(`UPDATE reports SET author = ? WHERE author = ?`, t, n),
    S(`UPDATE tape SET author = ? WHERE author = ?`, t, n),
    S(`UPDATE tape SET to_user = ? WHERE to_user = ?`, t, n),
    S(`UPDATE notifications SET actor = ? WHERE actor = ?`, t, n),
    S(`UPDATE mutes SET muted = ? WHERE muted = ?`, t, n),
    S(`UPDATE approvals SET requested_by = ? WHERE requested_by = ?`, t, n),
    S(`UPDATE key_grants SET granted_by = ? WHERE granted_by = ?`, t, n),
    S(`UPDATE board_epochs SET created_by = ? WHERE created_by = ?`, t, n),
    S(`UPDATE device_logins SET approved_by = NULL WHERE approved_by = ?`, n),
  ];
  // What is theirs alone: gone.
  const drop = [
    S(`DELETE FROM sessions WHERE user = ?`, n),
    S(`DELETE FROM tokens WHERE user = ?`, n),
    S(`DELETE FROM agent_keys WHERE user = ?`, n),
    S(`DELETE FROM key_grants WHERE user = ?`, n),
    S(`DELETE FROM agent_sessions WHERE user = ?`, n),
    S(`DELETE FROM agent_profiles WHERE user = ?`, n),
    S(`DELETE FROM agent_caps WHERE user = ?`, n),
    S(`DELETE FROM agent_record WHERE user = ?`, n),
    S(`DELETE FROM avatars WHERE user = ?`, n),
    S(`DELETE FROM push_devices WHERE user = ?`, n),
    S(`DELETE FROM inbox_reminders WHERE user = ?`, n),
    S(`DELETE FROM notifications WHERE user = ?`, n),
    S(`DELETE FROM notify_levels WHERE user = ?`, n),
    S(`DELETE FROM notify_prefs WHERE user = ?`, n),
    S(`DELETE FROM oauth_codes WHERE user = ?`, n),
    S(`DELETE FROM oauth_refresh_tokens WHERE user = ?`, n),
    S(`DELETE FROM oauth_requests WHERE user = ?`, n),
    S(`DELETE FROM mcp_sessions WHERE user = ?`, n),
    S(`DELETE FROM mailbox_leases WHERE user = ?`, n),
    S(`DELETE FROM standing_rules WHERE user = ?`, n),
    S(`DELETE FROM standing_rules WHERE scope = 'person' AND scope_id = ?`, n),
    S(`DELETE FROM voice_sessions WHERE user = ?`, n),
    S(`DELETE FROM voice_usage WHERE user = ?`, n),
    S(`DELETE FROM tts_usage WHERE user = ?`, n),
    S(`DELETE FROM reaction_usage WHERE user = ?`, n),
    S(`DELETE FROM webhooks WHERE user = ?`, n),
    S(`DELETE FROM account_audit WHERE user = ?`, n),
    S(`DELETE FROM approvals WHERE user = ?`, n),
    S(`DELETE FROM mutes WHERE user = ?`, n),
    S(`DELETE FROM friendships WHERE a = ? OR b = ?`, n, n),
    S(`DELETE FROM agent_contacts WHERE a = ? OR b = ?`, n, n),
    S(`DELETE FROM members WHERE user = ?`, n),
    ...(email ? [S(`DELETE FROM invites WHERE email = ? AND accepted_at IS NULL`, email), S(`DELETE FROM app_signups WHERE email = ?`, email)] : []),
    S(`INSERT OR IGNORE INTO deleted_handles (hash, deleted_at) VALUES (?, ?)`, await sha256hex(n.toLowerCase()), Date.now()),
    S(`DELETE FROM users WHERE name = ?`, n),
  ];
  // D1 runs a batch as one transaction; keep each batch modest.
  for (let i = 0; i < rename.length; i += 20) await env.DB.batch(rename.slice(i, i + 20));
  for (let i = 0; i < drop.length; i += 20) await env.DB.batch(drop.slice(i, i + 20));
  forgetUserTokens(n);
  return { tombstone: tomb, boards_kept: kept, boards_removed: removed, owners_promoted: promoted, stripe_followup: !!stripe?.stripe_customer };
}
