// Sign-in with WorkOS AuthKit, web sessions, and personal MCP tokens.
// Session cookies and tokens are random secrets; only their SHA-256 hashes are stored.

import type { Env } from "./types";

const WORKOS_API = "https://api.workos.com";
export const SESSION_COOKIE = "ab_session";
export const OAUTH_COOKIE = "ab_oauth";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomSecret(prefix: string, bytes = 24): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function readCookie(request: Request, name: string): string | null {
  const m = (request.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export function cookieHeader(url: URL, name: string, value: string, maxAgeSec: number): string {
  const secure = url.protocol === "https:" ? " Secure;" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAgeSec}`;
}

// ---------- WorkOS ----------

export interface WorkosUser {
  id: string;
  email: string;
  email_verified: boolean;
  first_name: string | null;
  last_name: string | null;
  authentication_method?: string | null; // e.g. "SSO", "Password", "GoogleOAuth"
  organization_id?: string | null;
}

export function authorizeUrl(env: Env, redirectUri: string, state: string, opts: { screenHint?: "sign-in" | "sign-up"; loginHint?: string; organizationId?: string } = {}): string {
  const u = new URL(`${WORKOS_API}/user_management/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", env.WORKOS_CLIENT_ID ?? "");
  u.searchParams.set("redirect_uri", redirectUri);
  // An organization sends people to its own identity provider (SSO); otherwise AuthKit's sign-in page.
  if (opts.organizationId) u.searchParams.set("organization_id", opts.organizationId);
  else u.searchParams.set("provider", "authkit");
  u.searchParams.set("state", state);
  if (opts.screenHint) u.searchParams.set("screen_hint", opts.screenHint);
  if (opts.loginHint) u.searchParams.set("login_hint", opts.loginHint);
  return u.toString();
}

/** The WorkOS organization that owns an email's domain (where SSO is set up), if any. */
export async function ssoOrganizationFor(env: Env, email: string): Promise<{ id: string; name: string } | null> {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain || !env.WORKOS_API_KEY) return null;
  const res = await fetch(`${WORKOS_API}/organizations?domains=${encodeURIComponent(domain)}&limit=1`, { headers: { Authorization: `Bearer ${env.WORKOS_API_KEY}` } });
  if (!res.ok) return null;
  const j = (await res.json().catch(() => ({}))) as { data?: { id: string; name: string }[] };
  return j.data?.[0] ?? null;
}

export async function authenticateCode(env: Env, code: string): Promise<WorkosUser> {
  const res = await fetch(`${WORKOS_API}/user_management/authenticate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.WORKOS_CLIENT_ID,
      client_secret: env.WORKOS_API_KEY,
      grant_type: "authorization_code",
      code,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { user?: WorkosUser; authentication_method?: string; organization_id?: string; message?: string; error_description?: string };
  if (!res.ok || !body.user) throw new Error(`WorkOS sign-in failed (${res.status}): ${body.message ?? body.error_description ?? "unknown error"}`);
  return { ...body.user, authentication_method: body.authentication_method ?? null, organization_id: body.organization_id ?? null };
}

/** Asks WorkOS to email an app-wide invitation. WorkOS sends the email from its own domain. */
export async function sendWorkosInvitation(env: Env, email: string, inviterWorkosId: string | null): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!env.WORKOS_API_KEY) return { ok: false, error: "WORKOS_API_KEY not configured" };
  const res = await fetch(`${WORKOS_API}/user_management/invitations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WORKOS_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ email, expires_in_days: 30, ...(inviterWorkosId ? { inviter_user_id: inviterWorkosId } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; code?: string };
  if (res.ok && body.id) return { ok: true, id: body.id };
  return { ok: false, error: `${res.status} ${body.code ?? ""} ${body.message ?? ""}`.trim() };
}

// ---------- sessions ----------

export interface Session {
  id_hash: string;
  user: string | null;
  workos_id: string;
  email: string;
  email_verified: number; // 0/1 — WorkOS says this person controls the email
  display_name: string | null;
  expires_at: number;
  // The signed-in member's row, fetched in the same query (one D1 round trip per request instead of two).
  u_name?: string | null;
  u_email?: string | null;
  u_display_name?: string | null;
}

export async function createSession(
  env: Env,
  s: { user: string | null; workos_id: string; email: string; email_verified: boolean; display_name: string | null },
): Promise<string> {
  const secret = randomSecret("s_", 32);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (id_hash, user, workos_id, email, email_verified, display_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(await sha256hex(secret), s.user, s.workos_id, s.email, s.email_verified ? 1 : 0, s.display_name, now, now + SESSION_TTL_MS)
    .run();
  return secret;
}

export async function getSession(request: Request, env: Env): Promise<Session | null> {
  const secret = readCookie(request, SESSION_COOKIE);
  if (!secret) return null;
  const row = await env.DB.prepare(
    `SELECT s.id_hash, s.user, s.workos_id, s.email, s.email_verified, s.display_name, s.expires_at, u.name AS u_name, u.email AS u_email, u.display_name AS u_display_name
     FROM sessions s LEFT JOIN users u ON u.name = s.user WHERE s.id_hash = ?`,
  )
    .bind(await sha256hex(secret))
    .first<Session>();
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}

export async function setSessionUser(env: Env, idHash: string, user: string) {
  await env.DB.prepare(`UPDATE sessions SET user = ? WHERE id_hash = ?`).bind(user, idHash).run();
}

export async function deleteSession(request: Request, env: Env) {
  const secret = readCookie(request, SESSION_COOKIE);
  if (secret) await env.DB.prepare(`DELETE FROM sessions WHERE id_hash = ?`).bind(await sha256hex(secret)).run();
}

// ---------- personal MCP tokens ----------

export interface TokenRow {
  id: string;
  user: string;
  label: string;
  created_at: number;
  last_used: number | null;
  revoked_at: number | null;
  expires_at: number | null;
  kind: string;
}

export async function createToken(
  env: Env,
  user: string,
  label: string,
  opts: { expiresAt?: number | null; kind?: "manual" | "cli" } = {},
): Promise<{ id: string; token: string }> {
  const token = randomSecret("ab_", 32);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO tokens (id, hash, user, label, created_at, expires_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, await sha256hex(token), user, label.slice(0, 80), Date.now(), opts.expiresAt ?? null, opts.kind ?? "manual")
    .run();
  return { id, token };
}

/** Resolves a bearer token: its user, or why it can't be used. */
// Token lookups are cached briefly per isolate: agents call several tools a second, and each D1 round trip adds
// tens of milliseconds. A revoked token stops working everywhere within TOKEN_CACHE_MS (immediately where it was revoked).
const TOKEN_CACHE_MS = 10_000;
const tokenCache = new Map<string, { id: string; user: string; expires_at: number | null; at: number; touched: number }>();

async function lookupToken(env: Env, token: string, ctx?: ExecutionContext) {
  const hash = await sha256hex(token);
  const now = Date.now();
  let row = tokenCache.get(hash);
  if (!row || now - row.at > TOKEN_CACHE_MS) {
    const r = await env.DB.prepare(`SELECT id, user, expires_at FROM tokens WHERE hash = ? AND revoked_at IS NULL`).bind(hash).first<{ id: string; user: string; expires_at: number | null }>();
    if (!r) {
      tokenCache.delete(hash);
      return null;
    }
    row = { ...r, at: now, touched: row?.touched ?? 0 };
    if (tokenCache.size > 5000) tokenCache.clear();
    tokenCache.set(hash, row);
  }
  // "Last used" is good to a minute; don't write it on every call.
  if (now - row.touched > 60_000) {
    row.touched = now;
    const touch = env.DB.prepare(`UPDATE tokens SET last_used = ? WHERE id = ?`).bind(now, row.id).run();
    if (ctx) ctx.waitUntil(touch.catch(() => {}));
    else await touch;
  }
  return row;
}

export function forgetToken(id: string) {
  for (const [k, v] of tokenCache) if (v.id === id) tokenCache.delete(k);
}

export async function resolveToken(env: Env, token: string, ctx?: ExecutionContext): Promise<{ user: string | null; expired: boolean }> {
  if (!token.startsWith("ab_")) return { user: null, expired: false };
  const row = await lookupToken(env, token, ctx);
  if (!row) return { user: null, expired: false };
  if (row.expires_at != null && row.expires_at < Date.now()) return { user: null, expired: true };
  return { user: row.user, expired: false };
}

/** Resolves a bearer token to its user, or null if unknown, revoked or expired. */
export async function userForToken(env: Env, token: string, ctx?: ExecutionContext): Promise<string | null> {
  if (!token.startsWith("ab_")) return null;
  const row = await lookupToken(env, token, ctx);
  if (!row || (row.expires_at != null && row.expires_at < Date.now())) return null;
  return row.user;
}

export async function listTokens(env: Env, user: string): Promise<TokenRow[]> {
  const r = await env.DB.prepare(
    `SELECT id, user, label, created_at, last_used, revoked_at, expires_at, kind FROM tokens WHERE user = ? ORDER BY revoked_at IS NOT NULL, created_at DESC`,
  )
    .bind(user)
    .all<TokenRow>();
  return r.results;
}

export async function revokeToken(env: Env, user: string, id: string): Promise<boolean> {
  const r = await env.DB.prepare(`UPDATE tokens SET revoked_at = ? WHERE id = ? AND user = ? AND revoked_at IS NULL`).bind(Date.now(), id, user).run();
  forgetToken(id);
  return (r.meta.changes ?? 0) > 0;
}

export function bearer(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

export function isAdminEmail(env: Env, email: string | null | undefined): boolean {
  const admins = (env.ADMIN_EMAIL ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return !!email && admins.includes(email.toLowerCase());
}
