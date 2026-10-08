// Deleting an account (Apple 5.1.1(v); jxn #4329): the person's messages stay on the boards they shared, under a
// tombstone shown as "Deleted user"; everything that is theirs alone goes. The tombstone is random, not a hash of the
// handle, so it can't be walked back to who it was. The handle itself is never given out again: only its SHA-256 is
// kept (deleted_handles), so nobody can later post as the name old messages and links still point at.
//
// A run can stop part way (a board's Durable Object fails): the users row goes last, so the person can sign in and
// try again, and the retry reuses the same tombstone (deleted_handles.tombstone, cleared once it's done), so one
// account never ends up split across two (jxn's agent #4389).

import * as registry from "./registry";
import { forgetUserTokens, sha256hex } from "./auth";
import type { Env } from "./types";

/** Tombstones look like "deleted-3f9a1c2b7e": a handle no one can register (bugBoard.isReservedUser). */
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

const handleHash = (name: string) => sha256hex(name.toLowerCase());

/** Has this handle belonged to a deleted account? (Then it stays taken, forever.) */
export async function isDeletedHandle(env: Env, name: string): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT 1 AS x FROM deleted_handles WHERE hash = ?`).bind(await handleHash(name)).first());
}

// ---------- the emailed code that confirms a deletion (jxn's agent #4414) ----------
// A stolen session or token can't delete an account on its own: DELETE /api/me also needs the 6-digit code WorkOS
// emails to the account's own address (POST /api/me/delete-code), checked server-side, good for 10 minutes and once.

export const DELETE_CODE_TTL_MS = 10 * 60_000;

/** Records that a code was just sent to `user` (a new one replaces the last). */
export async function noteDeleteCodeSent(env: Env, user: string, now = Date.now()): Promise<void> {
  await env.DB.prepare(`INSERT INTO delete_codes (user, sent_at, used_at) VALUES (?, ?, NULL) ON CONFLICT(user) DO UPDATE SET sent_at = excluded.sent_at, used_at = NULL`).bind(user, now).run();
}

export type CodeCheck = "ok" | "none" | "expired" | "bad";

/**
 * Checks `code` for `user` against the code sent to `email`. `verify` asks WorkOS (or, on a local run, the fake code);
 * it throws for a wrong or expired code, and returns the email it authenticated. A good code is used up here, at most
 * once (the update only wins if it wasn't used already).
 */
export async function checkDeleteCode(env: Env, user: string, email: string, code: string, verify: (email: string, code: string) => Promise<{ email: string }>, now = Date.now()): Promise<CodeCheck> {
  const row = await env.DB.prepare(`SELECT sent_at, used_at FROM delete_codes WHERE user = ?`).bind(user).first<{ sent_at: number; used_at: number | null }>();
  if (!row || row.used_at != null) return "none";
  if (now - row.sent_at > DELETE_CODE_TTL_MS) return "expired";
  if (!/^\d{6}$/.test(code)) return "bad";
  let who: { email: string };
  try {
    who = await verify(email, code);
  } catch {
    return "bad";
  }
  if (who.email.toLowerCase() !== email.toLowerCase()) return "bad";
  const used = await env.DB.prepare(`UPDATE delete_codes SET used_at = ? WHERE user = ? AND used_at IS NULL AND sent_at = ?`).bind(now, user, row.sent_at).run();
  return (used.meta?.changes ?? 0) === 1 ? "ok" : "none";
}

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
     WHERE m.user IS NOT NULL OR b.created_by = ?1
       OR b.id IN (SELECT DISTINCT board_id FROM tape WHERE author = ?1 OR to_user = ?1)
       OR b.id IN (SELECT board_id FROM audit WHERE actor = ?1 OR target = ?1)`,
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
  // Only reports and purges embed an author. Use the original board set (membership has changed above),
  // one board at a time to keep binds fixed; leave titles, reasons and other people's history alone.
  for (const b of rows) {
    for (let last = 0; ; ) {
      const hits = (await S(`SELECT id, action, detail FROM audit WHERE board_id = ? AND action IN ('reported', 'purge') AND detail IS NOT NULL AND id > ? ORDER BY id LIMIT 45`, b.id, last).all<{ id: number; action: string; detail: string }>()).results;
      const changed = hits.map((h) => {
        let detail = h.detail;
        if (h.action === "reported" && detail.startsWith(`${n}: `)) {
          detail = t + detail.slice(n.length);
        } else if (h.action === "purge") {
          const author = /^(\S+ by )(\S+)(, purged by their agent)?$/.exec(detail);
          if (author?.[2] === n) detail = author[1] + t + (author[3] ?? "");
        }
        return { id: h.id, detail };
      }).filter((h, i) => h.detail !== hits[i].detail);
      if (changed.length) await env.DB.batch(changed.map((h) => S(`UPDATE audit SET detail = ? WHERE id = ?`, h.detail, h.id)));
      if (hits.length < 45) break;
      last = hits[hits.length - 1].id;
    }
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
    // Calls (src/calls.ts): who joined others' calls reads as the tombstone; the Atteo questions they asked go (a call's
    // summary was already posted on the board, where their messages are handled like any others).
    S(`UPDATE calls SET started_by = ? WHERE started_by = ?`, t, n),
    S(`UPDATE calls SET atteo_holder = NULL, atteo_until = NULL, atteo_session = NULL WHERE atteo_holder = ?`, n),
    S(`UPDATE calls SET atteo_log = NULL WHERE atteo_log LIKE ?`, `%"${n}"%`),
    S(`UPDATE call_members SET user = ? WHERE user = ?`, t, n),
    // Slack (src/slack.ts): a workspace they installed the app in stays installed for the others, under the tombstone.
    S(`UPDATE slack_installs SET created_by = ? WHERE created_by = ?`, t, n),
    S(`UPDATE audit SET target = ? WHERE target = ?`, t, n),
    ...(email ? [S(`UPDATE audit SET target = ? WHERE target = ?`, t, email)] : []),
    S(`UPDATE reports SET reporter = ? WHERE reporter = ?`, t, n),
    S(`UPDATE reports SET author = ? WHERE author = ?`, t, n),
    S(`UPDATE tape SET author = ? WHERE author = ?`, t, n),
    S(`UPDATE tape SET to_user = ? WHERE to_user = ?`, t, n),
    S(`UPDATE notifications SET actor = ? WHERE actor = ?`, t, n),
    S(`UPDATE mutes SET muted = ? WHERE muted = ?`, t, n),
    S(`UPDATE approvals SET requested_by = ? WHERE requested_by = ?`, t, n),
    S(`UPDATE host_runs SET requested_by = ? WHERE requested_by = ?`, t, n),
    S(`UPDATE hosts SET stopped_by = ? WHERE stopped_by = ?`, t, n),
    S(`UPDATE key_grants SET granted_by = ? WHERE granted_by = ?`, t, n),
    S(`UPDATE board_epochs SET created_by = ? WHERE created_by = ?`, t, n),
  ];
  // What is theirs alone: gone.
  const drop = [
    S(`DELETE FROM device_logins WHERE approved_by = ? OR agent_login_id IN (SELECT id FROM agent_logins WHERE user = ?)`, n, n),
    S(`DELETE FROM agent_email_alerts WHERE user = ?`, n),
    S(`DELETE FROM agent_web_sessions WHERE login_id IN (SELECT id FROM agent_logins WHERE user = ?)`, n),
    S(`DELETE FROM agent_logins WHERE user = ?`, n),
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
    S(`DELETE FROM pact_subjects WHERE user = ?`, n),
    S(`DELETE FROM pact_contexts WHERE user = ?`, n),
    S(`DELETE FROM pact_sends WHERE user = ?`, n),
    S(`DELETE FROM pact_prepared WHERE user = ?`, n),
    S(`DELETE FROM oauth_refresh_tokens WHERE user = ?`, n),
    S(`DELETE FROM oauth_requests WHERE user = ?`, n),
    S(`DELETE FROM mcp_sessions WHERE user = ?`, n),
    S(`DELETE FROM mailbox_leases WHERE user = ?`, n),
    S(`DELETE FROM machines WHERE user = ?`, n), // atteo agents: machine labels and counts (#5722)
    S(`DELETE FROM standing_rules WHERE user = ?`, n),
    S(`DELETE FROM standing_rules WHERE scope = 'person' AND scope_id = ?`, n),
    S(`DELETE FROM voice_sessions WHERE user = ?`, n),
    S(`DELETE FROM voice_usage WHERE user = ?`, n),
    S(`DELETE FROM tts_usage WHERE user = ?`, n),
    S(`DELETE FROM reaction_usage WHERE user = ?`, n),
    S(`DELETE FROM webhooks WHERE user = ?`, n),
    // Slack: their Slack identity links, open link nonces, and the channel bridges they made (a bridge ends with its maker).
    S(`DELETE FROM slack_people WHERE user = ?`, n),
    S(`DELETE FROM slack_nonces WHERE user = ?`, n),
    S(`DELETE FROM slack_links WHERE created_by = ?`, n),
    S(`DELETE FROM account_audit WHERE user = ?`, n),
    S(`DELETE FROM approval_terminal_confirms WHERE user = ?`, n),
    S(`DELETE FROM approval_confirm_starts WHERE user = ?`, n),
    S(`DELETE FROM approval_pins WHERE user = ?`, n),
    S(`DELETE FROM approval_pin_daily WHERE user = ?`, n),
    S(`DELETE FROM approvals WHERE user = ?`, n),
    // Their machines (atteo host) go with them, and what ran on them: a host can't outlive its owner.
    S(`DELETE FROM host_runs WHERE host_id IN (SELECT id FROM hosts WHERE owner = ?)`, n),
    S(`DELETE FROM hosts WHERE owner = ?`, n),
    S(`DELETE FROM host_confirms WHERE owner = ?`, n),
    S(`DELETE FROM mutes WHERE user = ?`, n),
    S(`DELETE FROM delete_codes WHERE user = ?`, n),
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
