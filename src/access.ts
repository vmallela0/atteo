// Shareable invite links: an owner makes a link with a role, an optional end date for the link, a use limit, and
// how long people who join keep access. Only a hash of the link's secret is stored.

import { checkOutsideMember } from "./policy";
import { sha256hex, randomSecret } from "./auth";
import { addMember, audit, memberRole, type Role, ROLES, DEFAULT_GRANT_DAYS, DEFAULT_GRANT_ROLE } from "./registry";
import { checkCanAddMember } from "./billing";
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

/** Grant length in days: omitted/empty → 30; 0 or not a positive number → no end; otherwise 1–365. */
export function grantExpiresDays(v: unknown, fallback = DEFAULT_GRANT_DAYS): number | null {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(365, Math.floor(n));
}

export async function createLink(env: Env, boardId: string, by: string, o: { role?: unknown; link_days?: unknown; member_days?: unknown; max_uses?: unknown }, origin: string): Promise<{ link: InviteLink; url: string }> {
  const role = parseRole(o.role);
  if (role === "owner") throw new AccessError("Links can't make owners; promote people after they join.");
  const kind = (await env.DB.prepare(`SELECT kind FROM boards WHERE id = ?`).bind(boardId).first<{ kind: string | null }>())?.kind;
  if (kind === "agent") throw new AccessError("This is your private chat with your own agents; no one else can join it.");
  const linkDays = days(o.link_days ?? 7, 90);
  // Omitted member_days → 30-day access (the grant default). Explicit 0 stays open-ended.
  const memberDays = days(o.member_days ?? DEFAULT_GRANT_DAYS, 365);
  const maxUses = o.max_uses == null || o.max_uses === "" ? null : Math.floor(Number(o.max_uses));
  if (maxUses != null && (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 500)) throw new AccessError("Uses must be between 1 and 500.");
  const secret = randomSecret("il_", 24);
  const id = randomSecret("l_", 8);
  const now = Date.now();
  const link: InviteLink = { id, board_id: boardId, role, member_days: memberDays, created_by: by, created_at: now, expires_at: linkDays ? now + linkDays * 86_400_000 : null, max_uses: maxUses, uses: 0, revoked_at: null };
  await env.DB.prepare(
    `INSERT INTO invite_links (id, token_hash, board_id, role, member_days, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, await sha256hex(secret), boardId, role, memberDays, by, now, link.expires_at, maxUses)
    .run();
  await audit(env, boardId, by, "link_created", null, `${role}${memberDays ? `, access for ${memberDays}d` : ""}${linkDays ? `, link valid ${linkDays}d` : ""}${maxUses ? `, ${maxUses} uses` : ""}`);
  return { link, url: `${origin}/i/${secret}` };
}

export async function listLinks(env: Env, boardId: string): Promise<InviteLink[]> {
  return (await env.DB.prepare(`SELECT id, board_id, role, member_days, created_by, created_at, expires_at, max_uses, uses, revoked_at FROM invite_links WHERE board_id = ? ORDER BY created_at DESC`).bind(boardId).all<InviteLink>()).results;
}

export async function revokeLink(env: Env, boardId: string, id: string, by: string): Promise<boolean> {
  const r = await env.DB.prepare(`UPDATE invite_links SET revoked_at = ? WHERE id = ? AND board_id = ? AND revoked_at IS NULL`).bind(Date.now(), id, boardId).run();
  if (r.meta.changes) await audit(env, boardId, by, "link_revoked", null, id);
  return r.meta.changes > 0;
}

/** Joins the board through a link. Returns the board id (already a member: just the id). */
export async function redeemLink(env: Env, secret: string, user: string, origin: string): Promise<string> {
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
  return l.board_id;
}
