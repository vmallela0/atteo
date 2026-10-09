// The Atteo app's own sign-in: an email, then the 6-digit code WorkOS emails (Magic Auth), all inside the app.
// The routes are in index.ts (POST /api/app/signin/start, /verify, /name); this file has the pieces they share:
// the WorkOS calls, rate limits, the signup ticket, and the local-only fake code for tests.

import { randomSecret, sha256hex, type WorkosUser } from "./auth";
import type { Env } from "./types";
import { isLocalHost } from "./util";

const WORKOS_API = "https://api.workos.com";
export const SIGNUP_TTL_MS = 15 * 60 * 1000;
const WINDOW_MS = 10 * 60 * 1000;

/** The one answer for a wrong, expired or used code (never says which, or whether the email has an account). */
export const BAD_CODE = "That code didn't work. Check it, or send a new one.";
export const FAKE_CODE = "000000";

export function normalizeEmail(raw: unknown): string | null {
  const e = String(raw ?? "").trim().toLowerCase();
  return e.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z0-9-]{2,}$/i.test(e) ? e : null;
}

/** Addresses that can never receive mail: the only ones the local fake code accepts. */
export function isTestEmail(email: string): boolean {
  return /@(example\.(com|org|net)|[a-z0-9.-]+\.test)$/i.test(email);
}

/**
 * The fake code (000000) is for local runs only: the request must be to this machine (wrangler dev), the email a test
 * address, and either WorkOS isn't configured or DEV_FAKE_MAGIC=1 is set in the local .dev.vars (never in wrangler.jsonc).
 * A deployed Worker is never reached as localhost, so this is false in production whatever the env says.
 */
export function fakeAllowed(env: Pick<Env, "DEV_FAKE_MAGIC" | "WORKOS_API_KEY" | "WORKOS_CLIENT_ID">, url: URL, email: string): boolean {
  if (!isLocalHost(url.hostname) || !isTestEmail(email)) return false;
  return env.DEV_FAKE_MAGIC === "1" || !(env.WORKOS_API_KEY && env.WORKOS_CLIENT_ID);
}

export function workosConfigured(env: Env): boolean {
  return !!(env.WORKOS_API_KEY && env.WORKOS_CLIENT_ID);
}

/** A stand-in WorkOS user for the fake code: stable per email, never a real WorkOS id. */
export async function fakeWorkosUser(email: string): Promise<WorkosUser> {
  return { id: `dev_${(await sha256hex(email)).slice(0, 24)}`, email, email_verified: true, first_name: null, last_name: null, authentication_method: "MagicAuth", organization_id: null };
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

// ---------- rate limits (fixed 10-minute windows in D1) ----------

/** Counts one hit on `key`; true while it's within `limit` for the current window. */
export async function hit(env: Env, key: string, limit: number): Promise<boolean> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, n, reset_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET n = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.n + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END
     RETURNING n`,
  )
    .bind(key, now + WINDOW_MS, now, now)
    .first<{ n: number }>();
  return (row?.n ?? 1) <= limit;
}

export function limits(env: Env) {
  const perIp = Math.max(1, Number(env.SIGNIN_PER_IP) || 30);
  return {
    startPerEmail: 5, // a first send and a few resends
    startPerIp: perIp,
    verifyPerEmail: 10, // ten guesses at a million codes; WorkOS codes also expire in 10 minutes
    verifyPerIp: perIp * 2,
  };
}

export async function emailKey(kind: string, email: string): Promise<string> {
  return `${kind}:email:${(await sha256hex(email)).slice(0, 32)}`;
}

// ---------- WorkOS Magic Auth ----------

/** Asks WorkOS to email a 6-digit code (valid 10 minutes). Errors are returned, never shown to the person. */
export async function sendCode(env: Env, email: string, ip: string, userAgent: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${WORKOS_API}/user_management/magic_auth`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WORKOS_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ email, ...(ip !== "unknown" ? { ip_address: ip } : {}), ...(userAgent ? { user_agent: userAgent.slice(0, 200) } : {}) }),
  });
  if (res.ok) return { ok: true };
  const b = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  return { ok: false, error: `${res.status} ${b.code ?? ""} ${b.message ?? ""}`.trim() };
}

export class CodeError extends Error {
  constructor(message: string, readonly status: number, readonly detail = "") {
    super(message);
  }
}

/** Code → the WorkOS user. A wrong or expired code is a CodeError(BAD_CODE, 400). */
export async function authenticateMagic(env: Env, email: string, code: string, ip: string, userAgent: string | null): Promise<WorkosUser> {
  const res = await fetch(`${WORKOS_API}/user_management/authenticate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.WORKOS_CLIENT_ID,
      client_secret: env.WORKOS_API_KEY,
      grant_type: "urn:workos:oauth:grant-type:magic-auth:code",
      code,
      email,
      ...(ip !== "unknown" ? { ip_address: ip } : {}),
      ...(userAgent ? { user_agent: userAgent.slice(0, 200) } : {}),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { user?: WorkosUser; authentication_method?: string; organization_id?: string; code?: string; error?: string; message?: string; error_description?: string };
  if (res.ok && body.user) return { ...body.user, authentication_method: body.authentication_method ?? "MagicAuth", organization_id: body.organization_id ?? null };
  const why = body.code ?? body.error ?? "";
  if (why === "sso_required" || why === "organization_authentication_methods_required")
    throw new CodeError("Your company requires its own sign-in. Use “Continue with Google, GitHub or SSO” below.", 403, why);
  throw new CodeError(BAD_CODE, 400, `${res.status} ${why} ${body.message ?? body.error_description ?? ""}`.trim());
}

// ---------- signup tickets (proved the email, no name yet) ----------

export interface Signup {
  workos_id: string;
  email: string;
  email_verified: number;
  display_name: string | null;
  device_name: string | null;
  expires_at: number;
}

export async function createSignup(env: Env, s: Omit<Signup, "expires_at">): Promise<string> {
  const ticket = randomSecret("st_", 24);
  await env.DB.prepare(`INSERT INTO app_signups (ticket_hash, workos_id, email, email_verified, display_name, device_name, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(await sha256hex(ticket), s.workos_id, s.email, s.email_verified, s.display_name, s.device_name, Date.now() + SIGNUP_TTL_MS)
    .run();
  return ticket;
}

export async function readSignup(env: Env, ticket: string): Promise<Signup | null> {
  if (!ticket.startsWith("st_")) return null;
  const r = await env.DB.prepare(`SELECT workos_id, email, email_verified, display_name, device_name, expires_at FROM app_signups WHERE ticket_hash = ?`).bind(await sha256hex(ticket)).first<Signup>();
  return r && r.expires_at > Date.now() ? r : null;
}

export async function useSignup(env: Env, ticket: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM app_signups WHERE ticket_hash = ?`).bind(await sha256hex(ticket)).run();
}

/** The device's name for the connection's label ("Atteo app · iPhone"): printable, short. */
export function deviceLabel(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40) : "";
  return s || null;
}

/** Sweeps expired counters and tickets (the cron), and voice sessions past two months (their minutes stay in voice_usage). */
export async function sweep(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM rate_limits WHERE reset_at < ?`).bind(now),
    // Stored client metadata documents (src/cimd.ts) serve for a day at most.
    env.DB.prepare(`DELETE FROM cimd_documents WHERE fetched_at < ?`).bind(now - 24 * 3600_000),
    env.DB.prepare(`DELETE FROM app_signups WHERE expires_at < ?`).bind(now),
    env.DB.prepare(`DELETE FROM voice_sessions WHERE created_at < ?`).bind(now - 62 * 24 * 3600_000),
  ]);
}
