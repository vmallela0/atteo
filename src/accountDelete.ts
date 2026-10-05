// Deleting an account (Apple 5.1.1(v); jxn #4329): the person's messages stay on the boards they shared, under a
// tombstone shown as "Deleted user"; everything that is theirs alone goes. The tombstone is random, not a hash of the
// handle, so it can't be walked back to who it was. The handle itself is never given out again: only its SHA-256 is
// kept (deleted_handles), so nobody can later post as the name old messages and links still point at.
//
// A run can stop part way (a board's Durable Object fails): the users row goes last, so the person can sign in and
// try again, and the retry reuses the same tombstone (deleted_handles.tombstone, cleared once it's done), so one
// account never ends up split across two (jxn's agent #4389).

import * as registry from "./registry";
import { forgetUserTokens, readCookie, SESSION_COOKIE, sha256hex } from "./auth";
import type { Env } from "./types";

/** Tombstones look like "deleted-3f9a1c2b7e": a handle no one can register (bugBoard.isReservedUser). */
export const TOMBSTONE_PREFIX = "deleted-";
export const isTombstone = (name: string | null | undefined): boolean => !!name && /^deleted-[0-9a-f]{10}$/.test(name);
/** What a tombstone reads as, everywhere a name is shown. */
export const DELETED_LABEL = "Deleted user";
export const shownName = (name: string): string => (isTombstone(name) ? DELETED_LABEL : name);

/** Deleting needs a sign-in this recent (a stolen session or a phone left open can't do it). */
export const FRESH_SIGNIN_MS = 10 * 60_000;

export function newTombstone(): string {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return TOMBSTONE_PREFIX + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const handleHash = (name: string) => sha256hex(name.toLowerCase());

/** Has this handle belonged to a deleted account? (Then it stays taken, forever.) */
export async function isDeletedHandle(env: Env, name: string): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT 1 AS x FROM deleted_handles WHERE hash = ?`).bind(await handleHash(name)).first());
}

/** When the request's sign-in happened: the web session's, or the bearer token's (the app's) creation time. */
export async function signedInAt(env: Env, request: Request): Promise<number | null> {
  const cookie = readCookie(request, SESSION_COOKIE);
  if (cookie) {
    const r = await env.DB.prepare(`SELECT created_at FROM sessions WHERE id_hash = ?`).bind(await sha256hex(cookie)).first<{ created_at: number }>();
    if (r) return r.created_at;
  }
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer) {
    const r = await env.DB.prepare(`SELECT created_at FROM tokens WHERE hash = ? AND revoked_at IS NULL`).bind(await sha256hex(bearer)).first<{ created_at: number }>();
    if (r) return r.created_at;
  }
  return null;
}
export const isFresh = (at: number | null, now = Date.now()) => at != null && now - at <= FRESH_SIGNIN_MS;

export interface BoardForget {
  forgetUser(user: string, tomb: string, opts?: { title?: string | null }): Promise<unknown>;
  destroy(): Promise<void>;
}

export interface DeleteResult {
  tombstone: string;
  boards_kept: number;
  boards_removed: number;
  owners_promoted: number;
  /** An active Pro plan: the Stripe subscription is NOT cancelled here. Its ids stay in deleted_handles for ops. */
  stripe_followup: boolean;
}

/** `text` with `name` (as a whole handle) swapped for `tomb`. */
export function swapHandle(text: string, name: string, tomb: string): string {
  const re = new RegExp(`(^|[^A-Za-z0-9_.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, "gi");
  return text.replace(re, (_a, pre: string) => pre + tomb);
}

/**
 * Deletes `name`'s account. Every board they're on or wrote on keeps their messages, attributed to the tombstone; boards
 * only they could see (their own agent board, or one no other active member is on) are destroyed. A board left
 * without an owner gets an active member as owner, a contributor first. Every statement binds a fixed handful of
 * values (D1 caps a query at 100).
 */
export async function deleteAccount(env: Env, name: string, stub: (boardId: string) => BoardForget, now = Date.now()): Promise<DeleteResult> {
  const user = await registry.userByName(env, name);
  if (!user) throw new Error("No such account.");
  const hash = await handleHash(name);
  const billing = await env.DB.prepare(`SELECT plan, plan_status, stripe_customer, stripe_subscription FROM users WHERE name = ?`).bind(name).first<{ plan: string | null; plan_status: string | null; stripe_customer: string | null; stripe_subscription: string | null }>();
  const activePro = billing?.plan === "pro" && (!billing.plan_status || ["active", "trialing", "past_due"].includes(billing.plan_status));
  // One tombstone per account, kept across retries.
  const prior = await env.DB.prepare(`SELECT tombstone FROM deleted_handles WHERE hash = ?`).bind(hash).first<{ tombstone: string | null }>();
  const tomb = prior?.tombstone ?? newTombstone();
  if (!prior) {
    await env.DB.prepare(`INSERT INTO deleted_handles (hash, tombstone, started_at, deleted_at, stripe_customer, stripe_subscription) VALUES (?, ?, ?, NULL, ?, ?)`)
      .bind(hash, tomb, now, activePro ? billing?.stripe_customer ?? null : null, activePro ? billing?.stripe_subscription ?? null : null).run();
  }

  // Every board that holds something of theirs: where they're a member, made it, or wrote (boards they left too).
  const rows = (await env.DB.prepare(
    `SELECT b.id AS id, b.kind AS kind, b.created_by AS created_by, b.direct_key AS direct_key, b.title AS title, m.role AS role
     FROM boards b LEFT JOIN members m ON m.board_id = b.id AND m.user = ?1
     WHERE m.user IS NOT NULL OR b.created_by = ?1 OR b.id IN (SELECT DISTINCT board_id FROM tape WHERE author = ?1 OR to_user = ?1)`,
  ).bind(name).all<{ id: string; kind: string | null; created_by: string | null; direct_key: string | null; title: string; role: string | null }>()).results;

  let kept = 0, removed = 0, promoted = 0;
  for (const b of rows) {
    const others = (await env.DB.prepare(`SELECT user, role, expires_at FROM members WHERE board_id = ? AND user != ? ORDER BY joined_at, user`).bind(b.id, name).all<{ user: string; role: string; expires_at: number | null }>()).results
      .filter((o) => !isTombstone(o.user) && (o.expires_at == null || o.expires_at > now));
    if ((b.kind === "agent" && b.created_by === name) || !others.length) {
      // Theirs alone: nothing shared to keep. The row goes only once the board's storage is really gone.
      await stub(b.id).destroy();
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM tape WHERE board_id = ?`).bind(b.id),
        env.DB.prepare(`DELETE FROM notifications WHERE board_id = ?`).bind(b.id),
      ]);
      await registry.deleteBoard(env, b.id);
      removed++;
      continue;
    }
    // A conversation of two ("maya ↔ theo", key "maya|theo") takes the tombstone in its name.
    let title: string | null = null;
    if (b.kind === "direct" && b.direct_key) {
      const key = b.direct_key.split("|").map((u) => (u === name ? tomb : u)).sort().join("|");
      title = swapHandle(b.title, name, tomb);
      await env.DB.prepare(`UPDATE boards SET direct_key = ?, title = ? WHERE id = ?`).bind(key, title, b.id).run();
    }
    await stub(b.id).forgetUser(name, tomb, { title });
    if (b.role) {
      await registry.removeMember(env, b.id, name);
      if (b.role === "owner" && !others.some((o) => o.role === "owner")) {
        const next = others.find((o) => o.role === "contributor") ?? others[0];
        await registry.setMemberAccess(env, b.id, next.user, { role: "owner" });
        await registry.audit(env, b.id, tomb, "owner.promoted", next.user, "the only owner deleted their account");
        promoted++;
      }
      await registry.audit(env, b.id, tomb, "account.deleted", null, null);
    }
    kept++;
  }

  const email = user.email ?? null;
  const n = name, t = tomb;
  const S = (sql: string, ...v: unknown[]) => env.DB.prepare(sql).bind(...v);
  // Audit details name people in free text ("maya: spam", "note by maya"): rewritten a few rows at a time.
  for (let last = 0; ; ) {
    const hits = (await S(`SELECT id, detail FROM audit WHERE detail LIKE ? ESCAPE '\\' AND id > ? ORDER BY id LIMIT 45`, `%${n.replace(/[\\%_]/g, "\\$&")}%`, last).all<{ id: number; detail: string }>()).results;
    const changed = hits.map((h) => ({ id: h.id, detail: swapHandle(h.detail, n, t) })).filter((h, i) => h.detail !== hits[i].detail);
    if (changed.length) await env.DB.batch(changed.map((h) => S(`UPDATE audit SET detail = ? WHERE id = ?`, h.detail, h.id)));
    if (hits.length < 45) break;
    last = hits[hits.length - 1].id;
  }
  // What other people's records say about them: kept, pointing at the tombstone.
  const rename = [
    S(`UPDATE boards SET created_by = ? WHERE created_by = ?`, t, n),
    S(`UPDATE boards SET last_author = ? WHERE last_author = ?`, t, n),
    S(`UPDATE boards SET deleted_by = ? WHERE deleted_by = ?`, t, n),
    S(`UPDATE boards SET member_notes = json_remove(member_notes, '$."' || ? || '"') WHERE member_notes IS NOT NULL AND json_valid(member_notes) AND json_type(member_notes, '$."' || ? || '"') IS NOT NULL`, n, n),
    S(`UPDATE members SET added_by = ? WHERE added_by = ?`, t, n),
    S(`UPDATE invites SET invited_by = ? WHERE invited_by = ?`, t, n),
    S(`UPDATE invite_links SET created_by = ? WHERE created_by = ?`, t, n),
    S(`UPDATE audit SET actor = ? WHERE actor = ?`, t, n),
    S(`UPDATE audit SET target = ? WHERE target = ?`, t, n),
    ...(email ? [S(`UPDATE audit SET target = ? WHERE target = ?`, t, email)] : []),
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
    // Invitations to them, accepted or not: the row would tie the tombstone back to their email.
    S(`DELETE FROM invites WHERE accepted_by = ?`, n),
    ...(email ? [S(`DELETE FROM invites WHERE email = ?`, email), S(`DELETE FROM app_signups WHERE email = ?`, email)] : []),
    S(`UPDATE deleted_handles SET deleted_at = ?, tombstone = NULL WHERE hash = ?`, now, hash),
    S(`DELETE FROM users WHERE name = ?`, n),
  ];
  // D1 runs a batch as one transaction; keep each batch modest.
  for (let i = 0; i < rename.length; i += 20) await env.DB.batch(rename.slice(i, i + 20));
  for (let i = 0; i < drop.length; i += 20) await env.DB.batch(drop.slice(i, i + 20));
  forgetUserTokens(n);
  return { tombstone: tomb, boards_kept: kept, boards_removed: removed, owners_promoted: promoted, stripe_followup: activePro };
}
