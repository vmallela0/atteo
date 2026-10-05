// Organization policies that apply when someone joins a board: a domain can keep its boards to its own people.
// A row can also opt that domain into an organization directory (list people who share it), but only with its own
// `directory` flag (off by default, migration 0067) and never for a free or public mail provider (jxn's agent #4398).

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

// Free and public mail providers: anyone can sign up, so sharing one is not sharing an organization. A name here is
// that provider at any country domain too (outlook.com, outlook.co.uk), and any subdomain of it.
const PUBLIC_MAIL_EXACT = ["gmail.com", "googlemail.com", "msn.com", "icloud.com", "me.com", "mac.com", "ymail.com", "aol.com", "proton.me", "pm.me", "mail.com", "zoho.com", "hey.com", "qq.com", "163.com", "126.com"];
const PUBLIC_MAIL_ANY_TLD = ["outlook", "hotmail", "live", "yahoo", "protonmail", "gmx", "yandex", "fastmail"];
const PUBLIC_MAIL_TLD = new RegExp(`^(?:[a-z0-9-]+\\.)*(?:${PUBLIC_MAIL_ANY_TLD.join("|")})\\.(?:[a-z]{2,}|(?:co|com|org|net)\\.[a-z]{2})$`);

/** A free or public mail provider's domain (gmail.com, outlook.co.uk, mail.yahoo.com…): never an organization. */
export function isPublicMailDomain(domain: string | null | undefined): boolean {
  const d = (domain ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!d) return false;
  return PUBLIC_MAIL_EXACT.some((p) => d === p || d.endsWith(`.${p}`)) || PUBLIC_MAIL_TLD.test(d);
}

/**
 * The organization domain `user` belongs to: a verified email whose domain has an org_policies row with `directory`
 * on. A row kept only for retention, SSO or outside members isn't a directory; a public mail provider never is, even
 * if a row exists for it.
 */
export async function orgDomainOf(env: Env, user: string): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT p.domain FROM users u JOIN org_policies p ON p.domain = lower(substr(u.email, instr(u.email, '@') + 1))
     WHERE u.name = ? AND u.email_verified = 1 AND u.email IS NOT NULL AND p.directory = 1`,
  )
    .bind(user)
    .first<{ domain: string }>();
  return r?.domain && !isPublicMailDomain(r.domain) ? r.domain : null;
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
