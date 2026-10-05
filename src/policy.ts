// Organization policies that apply when someone joins a board: a domain can keep its boards to its own people.
// A row in org_policies also opts that domain into an organization directory (list people who share it).

import type { Env } from "./types";

export interface OrgPolicy {
  domain: string;
  require_sso: number;
  max_retention_days: number | null;
  allow_outside_members: number;
}

/** The domain of a work email (`ada@acme.com` → `acme.com`), or null when it isn't one. */
export function emailDomain(email: string | null | undefined): string | null {
  const d = (email ?? "").split("@")[1]?.trim().toLowerCase();
  return d && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

export async function orgPolicy(env: Env, email: string | null | undefined): Promise<OrgPolicy | null> {
  const domain = emailDomain(email);
  return domain ? env.DB.prepare(`SELECT domain, require_sso, max_retention_days, allow_outside_members FROM org_policies WHERE domain = ?`).bind(domain).first<OrgPolicy>() : null;
}

/**
 * The organization domain `user` belongs to: a verified email whose domain has an org_policies row.
 * No policy (gmail.com, a personal domain, an unverified address) is not an organization.
 */
export async function orgDomainOf(env: Env, user: string): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT p.domain FROM users u JOIN org_policies p ON p.domain = lower(substr(u.email, instr(u.email, '@') + 1))
     WHERE u.name = ? AND u.email_verified = 1 AND u.email IS NOT NULL`,
  )
    .bind(user)
    .first<{ domain: string }>();
  return r?.domain ?? null;
}

export async function checkOutsideMember(env: Env, boardId: string, joinerEmail: string | null): Promise<void> {
  const r = await env.DB.prepare(
    `SELECT u.email AS creator_email, p.domain, p.allow_outside_members FROM boards b JOIN users u ON u.name = b.created_by
     LEFT JOIN org_policies p ON p.domain = lower(substr(u.email, instr(u.email, '@') + 1)) WHERE b.id = ?`,
  )
    .bind(boardId)
    .first<{ creator_email: string | null; domain: string | null; allow_outside_members: number | null }>();
  if (!r?.domain || r.allow_outside_members !== 0) return;
  if (emailDomain(joinerEmail) !== r.domain) throw new Error(`Boards created at ${r.domain} are for ${r.domain} accounts only (organization policy).`);
}
