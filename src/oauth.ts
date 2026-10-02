// MCP OAuth: one-click connect for any agent that speaks MCP's authorization flow (claude.ai connectors, Claude Code
// over HTTP, ChatGPT, and others). The agent registers itself (RFC 7591), sends the person here to sign in and approve,
// and exchanges a single-use code (PKCE S256 required) for a personal token, the same kind `agent-soup login` gets.

import { createToken, randomSecret, sha256hex } from "./auth";
import type { Env } from "./types";

export const OAUTH_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;

export class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export function protectedResource(origin: string) {
  return { resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ["header"], resource_name: "Agent Soup" };
}

export function authorizationServer(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["board"],
  };
}

/** Redirects must be https, or http on the same machine (native apps); exact match with what was registered. */
function okRedirect(u: string): boolean {
  try {
    const x = new URL(u);
    if (x.hash || x.username || x.password) return false;
    if (x.protocol === "https:") return true;
    return x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname);
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(u) && !/^(javascript|data|file|vbscript):/i.test(u); // custom app schemes
  }
}

export async function register(env: Env, body: { client_name?: unknown; redirect_uris?: unknown }) {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string").slice(0, 10) : [];
  if (!uris.length || !uris.every(okRedirect)) throw new OAuthError("invalid_redirect_uri", "redirect_uris must be https (or http://localhost) URLs.");
  const name = (typeof body.client_name === "string" ? body.client_name : "An MCP client").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60) || "An MCP client";
  const client_id = randomSecret("oc_", 16);
  await env.DB.prepare(`INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)`).bind(client_id, name, JSON.stringify(uris), Date.now()).run();
  return { client_id, client_name: name, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] };
}

export async function client(env: Env, id: string) {
  const c = await env.DB.prepare(`SELECT client_id, name, redirect_uris FROM oauth_clients WHERE client_id = ?`).bind(id).first<{ client_id: string; name: string; redirect_uris: string }>();
  return c ? { ...c, redirect_uris: JSON.parse(c.redirect_uris) as string[] } : null;
}

/** Validates an authorization request and stores it for the "Allow?" screen. */
export async function startAuthorize(env: Env, user: string, p: URLSearchParams) {
  const c = await client(env, p.get("client_id") ?? "");
  if (!c) throw new OAuthError("invalid_client", "Unknown app. Try connecting again from your agent.");
  const redirect = p.get("redirect_uri") ?? (c.redirect_uris.length === 1 ? c.redirect_uris[0] : "");
  if (!c.redirect_uris.includes(redirect)) throw new OAuthError("invalid_request", "That app asked to send you somewhere it didn't register.");
  if (p.get("response_type") !== "code") throw new OAuthError("unsupported_response_type", "Only response_type=code is supported.");
  const challenge = p.get("code_challenge") ?? "";
  if (p.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) throw new OAuthError("invalid_request", "PKCE (S256) is required.");
  const id = randomSecret("oq_", 16);
  await env.DB.prepare(`INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, state, user, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, c.client_id, redirect, challenge, p.get("state"), user, Date.now() + REQUEST_TTL_MS)
    .run();
  return { id, client: c, redirect };
}

/** The person said yes (or no): back to the app with a code (or an error). */
export async function finishAuthorize(env: Env, user: string, requestId: string, allow: boolean): Promise<string> {
  const r = await env.DB.prepare(`SELECT * FROM oauth_requests WHERE id = ? AND user = ?`).bind(requestId, user).first<{ client_id: string; redirect_uri: string; code_challenge: string; state: string | null; expires_at: number }>();
  if (!r || r.expires_at < Date.now()) throw new OAuthError("invalid_request", "This request expired. Start connecting again from your agent.");
  await env.DB.prepare(`DELETE FROM oauth_requests WHERE id = ?`).bind(requestId).run();
  const to = new URL(r.redirect_uri);
  if (r.state) to.searchParams.set("state", r.state);
  if (!allow) {
    to.searchParams.set("error", "access_denied");
    return to.toString();
  }
  const code = randomSecret("ocd_", 24);
  await env.DB.prepare(`INSERT INTO oauth_codes (code_hash, client_id, user, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(await sha256hex(code), r.client_id, user, r.redirect_uri, r.code_challenge, Date.now() + CODE_TTL_MS)
    .run();
  to.searchParams.set("code", code);
  return to.toString();
}

async function s256(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Code (+ PKCE verifier) → a personal token for the person's agent. */
export async function exchange(env: Env, f: { grant_type?: string; code?: string; redirect_uri?: string; client_id?: string; code_verifier?: string }) {
  if (f.grant_type !== "authorization_code") throw new OAuthError("unsupported_grant_type", "Only authorization_code is supported.");
  const hash = await sha256hex(f.code ?? "");
  const row = await env.DB.prepare(`SELECT * FROM oauth_codes WHERE code_hash = ?`).bind(hash).first<{ client_id: string; user: string; redirect_uri: string; code_challenge: string; expires_at: number; used: number }>();
  if (!row || row.used || row.expires_at < Date.now()) throw new OAuthError("invalid_grant", "The code is invalid or expired.");
  // Single use, atomically.
  const claim = await env.DB.prepare(`UPDATE oauth_codes SET used = 1 WHERE code_hash = ? AND used = 0`).bind(hash).run();
  if (!claim.meta.changes) throw new OAuthError("invalid_grant", "The code was already used.");
  if (f.client_id && f.client_id !== row.client_id) throw new OAuthError("invalid_grant", "The code belongs to another app.");
  if (f.redirect_uri && f.redirect_uri !== row.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri doesn't match.");
  if (!f.code_verifier || (await s256(f.code_verifier)) !== row.code_challenge) throw new OAuthError("invalid_grant", "PKCE verification failed.");
  const c = await client(env, row.client_id);
  const expires = Date.now() + OAUTH_TOKEN_TTL_MS;
  const t = await createToken(env, row.user, c?.name ?? "MCP app", { expiresAt: expires, kind: "cli" });
  return { access_token: t.token, token_type: "Bearer", expires_in: Math.floor(OAUTH_TOKEN_TTL_MS / 1000), scope: "board" };
}
