// Shareable invite links: an owner makes a link with a role, an optional end date for the link, a use limit, and
// how long people who join keep access. Only a hash of the link's secret is stored.

import { checkOutsideMember } from "./policy";
import { sha256hex, randomSecret } from "./auth";
import { addMember, audit, memberRole, type Role, ROLES, DEFAULT_GRANT_DAYS, DEFAULT_GRANT_ROLE } from "./registry";
import { checkCanAddMember } from "./billing";
import { noteInviteRedeemed, type Later } from "./observe";
import { checkGrant, type Grant } from "./boardkeys";
import type { Env } from "./types";

export interface InviteLink {
  id: string;
  board_id: string;
  role: Role;
  member_days: number | null;
  created_by: string;
  created_at: number;
  expires_at: number | null;
  max_uses: number | null;
  uses: number;
  revoked_at: number | null;
}

export class AccessError extends Error {}

export function parseRole(v: unknown, fallback: Role = DEFAULT_GRANT_ROLE): Role {
  if (v == null || v === "") return fallback;
  if (typeof v === "string" && (ROLES as string[]).includes(v)) return v as Role;
  throw new AccessError(`role must be one of: ${ROLES.join(", ")}`);
}

/** Email/name invite role: omitted → viewer; viewer/contributor kept; owner and anything else stay contributor (can't invite as owner). */
export function inviteRole(v: unknown): Exclude<Role, "owner"> {
  if (v == null || v === "") return DEFAULT_GRANT_ROLE;
  if (v === "viewer" || v === "contributor") return v;
  return "contributor";
}

const days = (v: unknown, max: number): number | null => {
  if (v == null || v === "" || v === 0 || v === "0") return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1 || n > max) throw new AccessError(`Days must be between 1 and ${max}.`);
  return n;
};

/** Grant length in days: only an explicit 0 means no end; 1–365 as given; anything else (omitted, empty, null, NaN,
 *  negative, garbage such as the CLI's `--days abc` → null) is the 30-day default, never an open-ended grant
 *  (jxn's agent #4399). */
export function grantExpiresDays(v: unknown, fallback = DEFAULT_GRANT_DAYS): number | null {
  if (v === 0 || v === "0") return null;
  const n = typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(365, Math.floor(n));
}

/** An invite link's key for an encrypted board (E2E design §3.3): the invite key's public half and each epoch key the
 *  inviter holds, wrapped to it. The private half travels after the link's "#" and never reaches the server. */
export interface InviteKey {
  public_key: string;
  grants: { epoch: number; epk: string; iv: string; wrapped: string }[];
}

const KEY32 = /^[A-Za-z0-9+/]{43}=$/;

async function checkInviteKey(env: Env, boardId: string, by: string, v: unknown): Promise<InviteKey | null> {
  if (v == null) return null;
  const k = v as Partial<InviteKey>;
  if (typeof k.public_key !== "string" || !KEY32.test(k.public_key)) throw new AccessError("invite_key.public_key must be a base64 X25519 public key.");
  const enc = await env.DB.prepare(`SELECT encrypted FROM boards WHERE id = ?`).bind(boardId).first<{ encrypted: number }>();
  if (!enc?.encrypted) throw new AccessError("Only an end-to-end encrypted board's links carry a key.");
  const grants = (Array.isArray(k.grants) ? k.grants : []).map((g) => {
    try {
      return checkGrant(g as Partial<Grant>, true);
    } catch (e) {
      throw new AccessError(e instanceof Error ? e.message : String(e));
    }
  });
  if (!grants.length || grants.length > 200) throw new AccessError("invite_key.grants: wrap each epoch key you hold (1–200).");
  const held = new Set(
    (await env.DB.prepare(`SELECT DISTINCT epoch FROM key_grants WHERE board_id = ? AND user = ?`).bind(boardId, by).all<{ epoch: number }>()).results.map((r) => r.epoch),
  );
  for (const g of grants) if (!held.has(g.epoch)) throw new AccessError(`You don't hold epoch ${g.epoch}'s key, so a link can't carry it.`);
  return { public_key: k.public_key, grants: grants.map(({ epoch, epk, iv, wrapped }) => ({ epoch, epk, iv, wrapped })) };
}

export async function createLink(env: Env, boardId: string, by: string, o: { role?: unknown; link_days?: unknown; member_days?: unknown; max_uses?: unknown; invite_key?: unknown }, origin: string): Promise<{ link: InviteLink; url: string }> {
  const role = parseRole(o.role);
  if (role === "owner") throw new AccessError("Links can't make owners; promote people after they join.");
  const kind = (await env.DB.prepare(`SELECT kind FROM boards WHERE id = ?`).bind(boardId).first<{ kind: string | null }>())?.kind;
  if (kind === "agent") throw new AccessError("This is your private chat with your own agents; no one else can join it.");
  const linkDays = days(o.link_days ?? 7, 90);
  // Omitted member_days → 30-day access (the grant default). Explicit 0 stays open-ended.
  const memberDays = days(o.member_days ?? DEFAULT_GRANT_DAYS, 365);
  const maxUses = o.max_uses == null || o.max_uses === "" ? null : Math.floor(Number(o.max_uses));
  if (maxUses != null && (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 500)) throw new AccessError("Uses must be between 1 and 500.");
  const inviteKey = await checkInviteKey(env, boardId, by, o.invite_key);
  const secret = randomSecret("il_", 24);
  const id = randomSecret("l_", 8);
  const now = Date.now();
  const link: InviteLink = { id, board_id: boardId, role, member_days: memberDays, created_by: by, created_at: now, expires_at: linkDays ? now + linkDays * 86_400_000 : null, max_uses: maxUses, uses: 0, revoked_at: null };
  const insert = env.DB.prepare(
    `INSERT INTO invite_links (id, token_hash, board_id, role, member_days, created_by, created_at, expires_at, max_uses, invite_pub) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, await sha256hex(secret), boardId, role, memberDays, by, now, link.expires_at, maxUses, inviteKey?.public_key ?? null);
  if (!inviteKey) await insert.run();
  else await env.DB.batch([insert, ...inviteKey.grants.map((g) => env.DB.prepare(`INSERT INTO invite_key_grants (link_id, epoch, epk, iv, wrapped) VALUES (?, ?, ?, ?, ?)`).bind(id, g.epoch, g.epk, g.iv, g.wrapped))]);
  await audit(env, boardId, by, "link_created", null, `${role}${memberDays ? `, access for ${memberDays}d` : ""}${linkDays ? `, link valid ${linkDays}d` : ""}${maxUses ? `, ${maxUses} uses` : ""}`);
  return { link, url: `${origin}/i/${secret}` };
}

export async function listLinks(env: Env, boardId: string): Promise<InviteLink[]> {
  return (await env.DB.prepare(`SELECT id, board_id, role, member_days, created_by, created_at, expires_at, max_uses, uses, revoked_at FROM invite_links WHERE board_id = ? ORDER BY created_at DESC`).bind(boardId).all<InviteLink>()).results;
}

export async function revokeLink(env: Env, boardId: string, id: string, by: string): Promise<boolean> {
  const r = await env.DB.prepare(`UPDATE invite_links SET revoked_at = ? WHERE id = ? AND board_id = ? AND revoked_at IS NULL`).bind(Date.now(), id, boardId).run();
  if (r.meta.changes) await env.DB.prepare(`DELETE FROM invite_key_grants WHERE link_id = ?`).bind(id).run(); // the key it carried goes with it
  if (r.meta.changes) await audit(env, boardId, by, "link_revoked", null, id);
  return r.meta.changes > 0;
}

/** Joins the board through a link. Returns the board id (already a member: just the id). */
export async function redeemLink(env: Env, secret: string, user: string, origin: string, later: Later | null = null): Promise<string> {
  const l = await env.DB.prepare(`SELECT id, board_id, role, member_days, expires_at, max_uses, uses, revoked_at FROM invite_links WHERE token_hash = ?`)
    .bind(await sha256hex(secret))
    .first<InviteLink>();
  if (!l || l.revoked_at) throw new AccessError("This invite link doesn't work anymore. Ask for a new one.");
  if (l.expires_at && l.expires_at < Date.now()) throw new AccessError("This invite link has expired. Ask for a new one.");
  if (await memberRole(env, l.board_id, user)) return l.board_id;
  if (l.max_uses != null && l.uses >= l.max_uses) throw new AccessError("This invite link has been used up. Ask for a new one.");
  await checkCanAddMember(env, l.board_id, origin);
  const joiner = await env.DB.prepare(`SELECT email FROM users WHERE name = ?`).bind(user).first<{ email: string | null }>();
  await checkOutsideMember(env, l.board_id, joiner?.email ?? null).catch((e) => {
    throw new AccessError(e instanceof Error ? e.message : String(e));
  });
  // Count the use first (atomically), so a burst can't exceed the limit.
  const used = await env.DB.prepare(`UPDATE invite_links SET uses = uses + 1 WHERE id = ? AND (max_uses IS NULL OR uses < max_uses)`).bind(l.id).run();
  if (!used.meta.changes) throw new AccessError("This invite link has been used up. Ask for a new one.");
  await env.DB.prepare(`DELETE FROM members WHERE board_id = ? AND user = ? AND expires_at IS NOT NULL AND expires_at < ?`).bind(l.board_id, user, Date.now()).run();
  await addMember(env, l.board_id, user, { role: l.role, expires_at: l.member_days ? Date.now() + l.member_days * 86_400_000 : null, added_by: `link ${l.id}` });
  await audit(env, l.board_id, user, "joined", user, `via invite link (${l.role}${l.member_days ? `, ${l.member_days}d` : ""})`);
  void noteInviteRedeemed(env, later, user);
  return l.board_id;
}

/**
 * The board key an invite link carries, for someone who joined with it (E2E design §3.3): the invite key's public half
 * and the wrapped epoch keys. Proof is the link's secret; only members of its board get an answer. Their device unwraps
 * with the private half from the link's "#" and hands the key to itself (boardkeys.addInviteGrants).
 */
export async function inviteKeyFor(env: Env, secret: string, user: string): Promise<{ board: string; link: string; public_key: string; grants: InviteKey["grants"] }> {
  const l = await env.DB.prepare(`SELECT id, board_id, expires_at, revoked_at, invite_pub FROM invite_links WHERE token_hash = ?`)
    .bind(await sha256hex(secret))
    .first<{ id: string; board_id: string; expires_at: number | null; revoked_at: number | null; invite_pub: string | null }>();
  if (!l || l.revoked_at || !l.invite_pub) throw new AccessError("This link carries no board key.");
  if (l.expires_at && l.expires_at < Date.now()) throw new AccessError("This invite link has expired. Ask for a new one.");
  if (!(await memberRole(env, l.board_id, user))) throw new AccessError("Join the board with this link first.");
  const grants = (await env.DB.prepare(`SELECT epoch, epk, iv, wrapped FROM invite_key_grants WHERE link_id = ? ORDER BY epoch`).bind(l.id).all<InviteKey["grants"][number]>()).results;
  return { board: l.board_id, link: l.id, public_key: l.invite_pub, grants };
}

/** Whether a link (by its secret) has a key: its /i/ page then first moves the key out of the address bar. */
export async function linkHasKey(env: Env, secret: string): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT 1 AS x FROM invite_links WHERE token_hash = ? AND invite_pub IS NOT NULL AND revoked_at IS NULL`).bind(await sha256hex(secret)).first());
}
