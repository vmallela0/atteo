// MCP OAuth: one-click connect for any agent that speaks MCP's authorization flow (claude.ai connectors, Claude Code
// over HTTP, ChatGPT, and others). The agent registers itself (RFC 7591), sends the person here to sign in and approve,
// and exchanges a single-use code (PKCE S256 required) for a personal token, the same kind `atteo login` gets.
// Instead of registering, a client can use an https URL as its client_id (Client ID Metadata Documents, src/cimd.ts):
// we fetch that document, check it and treat it like a registered client; everything after that is the same.

import { record } from "./accountlog";
import { createToken, randomSecret, revokeToken, sha256hex } from "./auth";
import { CimdError, isCimdClientId, resolveCimdClient, type CimdOptions } from "./cimd";
import type { Env } from "./types";

export const OAUTH_TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
// Longer than the access token, and each refresh issues a new one: a bot that runs at least every 90 days stays
// signed in until its person revokes the connection.
const REFRESH_TTL_DAYS = 90;
const REFRESH_TTL_MS = REFRESH_TTL_DAYS * 24 * 3600 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;

export class OAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export function protectedResource(origin: string) {
  return { resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ["header"], resource_name: "Atteo" };
}

export function authorizationServer(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true, // an https client_id URL instead of registering (src/cimd.ts)
    scopes_supported: ["board"], // "person" is the Atteo app's own sign-in; it isn't advertised, so connectors (Codex asks for every advertised scope) never request it
  };
}

/**
 * Redirects must be https, http on the same machine, or an app's own link (cursor://, vscode://: native apps,
 * RFC 8252); exact match with what was registered. PKCE is required, so a code sent to the wrong app is useless.
 */
export function okRedirect(u: string): boolean {
  let x: URL;
  try {
    x = new URL(u);
  } catch {
    return false;
  }
  if (x.hash || x.username || x.password || /\s/.test(u)) return false;
  if (x.protocol === "https:") return true;
  if (x.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname);
  // App links: a real scheme name followed by "://", never one a browser would run or read from disk.
  return /^[a-z][a-z0-9+.-]*:\/\/./i.test(u) && !/^(javascript|data|file|vbscript|blob|about|chrome|ws|wss|ftp):/i.test(u);
}

export async function register(env: Env, body: { client_name?: unknown; redirect_uris?: unknown }) {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string").slice(0, 10) : [];
  if (!uris.length || !uris.every(okRedirect)) throw new OAuthError("invalid_redirect_uri", "redirect_uris must be https, http://localhost or an app link (like cursor://).");
  const name = (typeof body.client_name === "string" ? body.client_name : "An MCP client").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60) || "An MCP client";
  const client_id = randomSecret("oc_", 16);
  await env.DB.prepare(`INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)`).bind(client_id, name, JSON.stringify(uris), Date.now()).run();
  return { client_id, client_name: name, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
}

/** How a request may fetch a client's metadata document (src/cimd.ts). Without it, URL client_ids are refused. */
export type ClientLookup = Omit<CimdOptions, "now">;

/** "<name> · <host>" in at most 80 characters (tokens.label's limit): the name is shortened, never the host. */
export function cimdLabel(name: string, host: string): string {
  const tail = ` · ${host}`;
  return tail.length >= 80 ? host.slice(0, 80) : `${name.slice(0, 80 - tail.length).trimEnd()}${tail}`;
}

/** A client_id URL's document, as a client; CimdError becomes the OAuth error it stands for. */
async function cimdClient(id: string, lookup: ClientLookup | undefined) {
  if (!lookup) throw new OAuthError("invalid_client", "This app's client_id is a URL, which isn't accepted here.");
  try {
    return await resolveCimdClient(id, lookup);
  } catch (e) {
    if (e instanceof CimdError) throw new OAuthError(e.code, e.message, e.status);
    throw e;
  }
}

export async function client(env: Env, id: string) {
  const c = await env.DB.prepare(`SELECT client_id, name, redirect_uris FROM oauth_clients WHERE client_id = ?`).bind(id).first<{ client_id: string; name: string; redirect_uris: string }>();
  return c ? { ...c, redirect_uris: JSON.parse(c.redirect_uris) as string[] } : null;
}

/** Validates an authorization request and stores it for the "Allow?" screen. */
export async function startAuthorize(env: Env, user: string, p: URLSearchParams, lookup?: ClientLookup) {
  const clientId = p.get("client_id") ?? "";
  const cimd = isCimdClientId(clientId);
  // A URL client_id: its metadata document, fetched (or cached) and checked, stands in for registration. Only a
  // signed-in person reaches this (the route asks for sign-in first), so a signed-out caller can't make us fetch.
  const c: { client_id: string; name: string; redirect_uris: string[]; host?: string } | null = cimd ? await cimdClient(clientId, lookup) : await client(env, clientId);
  // Unknown client_id: connectors cache the id from DCR and do not re-register when this page says
  // invalid_client — the person has to remove and re-add the connector. Prune keeps any client that
  // ever got a token, and unused DCR for 120 days, instead of trying to recover here.
  if (!c) throw new OAuthError("invalid_client", "Unknown app. Remove Atteo from the connector and add it again.");
  const redirect = p.get("redirect_uri") ?? (c.redirect_uris.length === 1 ? c.redirect_uris[0] : "");
  if (!c.redirect_uris.includes(redirect)) throw new OAuthError("invalid_request", "That app asked to send you somewhere it didn't register.");
  if (p.get("response_type") !== "code") throw new OAuthError("unsupported_response_type", "Only response_type=code is supported.");
  const challenge = p.get("code_challenge") ?? "";
  if (p.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) throw new OAuthError("invalid_request", "PKCE (S256) is required.");
  // scope "person": the Atteo app signing in as you (not your agent). Only for the app's own link, atteo:// (or
  // agentsoup://, the app's scheme before the rename, until every installed app has moved), so no agent connector can ask for it.
  // Anything else asking for it (Codex once asked for "board person") just gets an agent connection: no error page, no escalation.
  // Never for a URL client_id: anyone can host a document (and its redirects can't be app links anyway).
  const person = !cimd && (p.get("scope") ?? "").split(/\s+/).includes("person") && /^(atteo|agentsoup):\/\//.test(redirect);
  const id = randomSecret("oq_", 16);
  await env.DB.prepare(`INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, state, user, expires_at, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, c.client_id, redirect, challenge, p.get("state"), user, Date.now() + REQUEST_TTL_MS, person ? "person" : null)
    .run();
  return { id, client: c, redirect, person, host: c.host ?? null };
}

/** The person said yes (or no): back to the app with a code (or an error). */
export async function finishAuthorize(env: Env, user: string, requestId: string, allow: boolean): Promise<string> {
  const r = await env.DB.prepare(`SELECT * FROM oauth_requests WHERE id = ? AND user = ?`).bind(requestId, user).first<{ client_id: string; redirect_uri: string; code_challenge: string; state: string | null; expires_at: number; scope: string | null }>();
  if (!r || r.expires_at < Date.now()) throw new OAuthError("invalid_request", "This request expired. Start connecting again from your agent.");
  await env.DB.prepare(`DELETE FROM oauth_requests WHERE id = ?`).bind(requestId).run();
  const to = new URL(r.redirect_uri);
  if (r.state) to.searchParams.set("state", r.state);
  if (!allow) {
    to.searchParams.set("error", "access_denied");
    return to.toString();
  }
  const code = randomSecret("ocd_", 24);
  await env.DB.prepare(`INSERT INTO oauth_codes (code_hash, client_id, user, redirect_uri, code_challenge, expires_at, scope) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(await sha256hex(code), r.client_id, user, r.redirect_uri, r.code_challenge, Date.now() + CODE_TTL_MS, r.scope ?? null)
    .run();
  to.searchParams.set("code", code);
  return to.toString();
}

async function s256(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An access token plus a refresh token tied to it (only its hash is stored). */
async function issue(env: Env, user: string, clientId: string, scope: string | null, label: string, kind: "cli" | "app") {
  const now = Date.now();
  const t = await createToken(env, user, label, { expiresAt: now + OAUTH_TOKEN_TTL_MS, kind });
  const refresh = randomSecret("ort_", 32);
  await env.DB.prepare(`INSERT INTO oauth_refresh_tokens (hash, user, client_id, scope, token_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(await sha256hex(refresh), user, clientId, scope, t.id, now, now + REFRESH_TTL_MS)
    .run();
  return { access_token: t.token, token_type: "Bearer", expires_in: Math.floor(OAUTH_TOKEN_TTL_MS / 1000), refresh_token: refresh, scope: scope === "person" ? "person" : "board" };
}

/**
 * Refresh token → a new access token and refresh token: same person, app, label and scope. The old refresh token is
 * used up and the old access token revoked (one live token per connection). Refused once the connection's token was
 * revoked (Disconnect, the kill switch), so revoking still ends the connection for good.
 */
async function refresh(env: Env, f: { refresh_token?: string; client_id?: string }, lookup?: ClientLookup) {
  const hash = await sha256hex(f.refresh_token ?? "");
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT r.user, r.client_id, r.scope, r.token_id, r.expires_at, r.used_at, t.label, t.kind, t.revoked_at FROM oauth_refresh_tokens r LEFT JOIN tokens t ON t.id = r.token_id WHERE r.hash = ?`,
  )
    .bind(hash)
    .first<{ user: string; client_id: string; scope: string | null; token_id: string; expires_at: number; used_at: number | null; label: string | null; kind: string | null; revoked_at: number | null }>();
  if (!row || row.used_at || row.expires_at < now) throw new OAuthError("invalid_grant", "The refresh token is invalid, expired or already used.");
  // A URL client_id must be sent, and match exactly (public clients identify themselves by client_id).
  if (isCimdClientId(row.client_id) ? f.client_id !== row.client_id : f.client_id && f.client_id !== row.client_id) throw new OAuthError("invalid_grant", "The refresh token belongs to another app.");
  if (!row.label || row.revoked_at) throw new OAuthError("invalid_grant", "This connection was revoked. Sign in again.");
  // Its document must still be good (cached up to an hour), before the refresh token is used up: one that now asks
  // for client authentication we don't do, or is gone, ends the connection; a fetch that fails for now (503) doesn't.
  if (isCimdClientId(row.client_id)) await cimdClient(row.client_id, lookup);
  // Single use, atomically.
  const claim = await env.DB.prepare(`UPDATE oauth_refresh_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL`).bind(now, hash).run();
  if (!claim.meta.changes) throw new OAuthError("invalid_grant", "The refresh token was already used.");
  const out = await issue(env, row.user, row.client_id, row.scope, row.label, row.kind === "app" ? "app" : "cli");
  await revokeToken(env, row.user, row.token_id);
  return out;
}

/** Code (+ PKCE verifier) → a personal token for the person's agent; or a refresh token → a fresh pair. */
export async function exchange(
  env: Env,
  f: { grant_type?: string; code?: string; redirect_uri?: string; client_id?: string; code_verifier?: string; refresh_token?: string },
  request: Request | null = null,
  lookup?: ClientLookup,
) {
  if (f.grant_type === "refresh_token") return refresh(env, f, lookup);
  if (f.grant_type !== "authorization_code") throw new OAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
  const hash = await sha256hex(f.code ?? "");
  const row = await env.DB.prepare(`SELECT * FROM oauth_codes WHERE code_hash = ?`).bind(hash).first<{ client_id: string; user: string; redirect_uri: string; code_challenge: string; expires_at: number; used: number; scope: string | null }>();
  if (!row || row.used || row.expires_at < Date.now()) throw new OAuthError("invalid_grant", "The code is invalid or expired.");
  // A URL client_id: only now, with a real code in hand, is its document looked at (never the client_id in the body:
  // this endpoint is open to anyone). Still good and still listing the redirect? Checked before the code is used up,
  // so a document host that's briefly down (503) doesn't cost the person their sign-in.
  const cimd = isCimdClientId(row.client_id) ? await cimdClient(row.client_id, lookup) : null;
  if (cimd && !cimd.redirect_uris.includes(row.redirect_uri)) throw new OAuthError("invalid_grant", "The app no longer lists that redirect_uri.");
  // Single use, atomically.
  const claim = await env.DB.prepare(`UPDATE oauth_codes SET used = 1 WHERE code_hash = ? AND used = 0`).bind(hash).run();
  if (!claim.meta.changes) throw new OAuthError("invalid_grant", "The code was already used.");
  // A URL client_id must be sent, and match exactly; a registered one is checked when sent (as before).
  if (cimd ? f.client_id !== row.client_id : f.client_id && f.client_id !== row.client_id) throw new OAuthError("invalid_grant", "The code belongs to another app.");
  if (f.redirect_uri && f.redirect_uri !== row.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri doesn't match.");
  if (!f.code_verifier || (await s256(f.code_verifier)) !== row.code_challenge) throw new OAuthError("invalid_grant", "PKCE verification failed.");
  const c = cimd ?? (await client(env, row.client_id));
  const person = row.scope === "person";
  // A URL client's connection carries its domain, so Agent connections shows who it really is. Labels are kept to 80
  // characters, so the name gives way and the domain always fits whole.
  const label = person ? "Atteo app" : cimd ? cimdLabel(cimd.name, cimd.host) : (c?.name ?? "MCP app");
  const out = await issue(env, row.user, row.client_id, person ? "person" : null, label, person ? "app" : "cli");
  // A refresh carries the same connection on, so only the first exchange is logged.
  await record(env, row.user, person ? "signin.app" : "oauth.connected", request, { label, kind: person ? "app" : "cli" });
  return out;
}

/** Window for a recent authorize request or code (those rows live minutes; expiry still in this window means "tried recently"). */
export const OAUTH_CLIENT_GRACE_DAYS = 30;
/** Unused DCR rows: connectors cache `client_id` at register, and many never re-register on invalid_client.
 *  Keep them for a refresh lifetime plus the reconnect grace, as if a token had been issued at registration. */
export const OAUTH_CLIENT_DCR_DAYS = REFRESH_TTL_DAYS + OAUTH_CLIENT_GRACE_DAYS;

/**
 * Cron sweep: delete leftover OAuth clients (shared with test/queryPlans.test.ts).
 * Fail-safe for cached DCR (jxn's agent #5290): claude.ai / ChatGPT / Cursor store the client_id and do not
 * re-register when /authorize shows invalid_client (an HTML error page, not a DCR hint). So:
 * a client that was ever issued a refresh token is kept for good (refresh-token rows are never deleted);
 * unused DCR is kept for a refresh lifetime plus 30 days (120 days), as if a token had been issued at register.
 *
 * Binds, in order: dcrFloor, grace, grace. `dcrFloor` is `now - 120d`; `grace` is `now - 30d`.
 * Keep when any of: registered in the last 120 days; an authorize request or code whose expiry is still
 * within 30 days; any refresh token, used, unused or expired.
 */
export const PRUNE_OAUTH_CLIENTS_SQL = `DELETE FROM oauth_clients
WHERE created_at < ?
  AND NOT EXISTS (SELECT 1 FROM oauth_requests r WHERE r.client_id = oauth_clients.client_id AND r.expires_at >= ?)
  AND NOT EXISTS (SELECT 1 FROM oauth_codes k WHERE k.client_id = oauth_clients.client_id AND k.expires_at >= ?)
  AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens rt WHERE rt.client_id = oauth_clients.client_id)`;

/** Deletes leftover unused DCR rows; a client that ever got a token, or a recent authorize attempt, stays. */
export async function pruneUnusedClients(env: Env, now = Date.now()): Promise<number> {
  const grace = now - OAUTH_CLIENT_GRACE_DAYS * 86_400_000;
  const dcrFloor = now - OAUTH_CLIENT_DCR_DAYS * 86_400_000;
  const r = await env.DB.prepare(PRUNE_OAUTH_CLIENTS_SQL).bind(dcrFloor, grace, grace).run();
  const n = r.meta.changes ?? 0;
  if (n) {
    const day = new Date(now).toISOString().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO usage_daily (day, metric, key, count) VALUES (?, 'oauth_clients_pruned', 'cron', ?) ON CONFLICT(day, metric, key) DO UPDATE SET count = count + excluded.count`,
    )
      .bind(day, n)
      .run();
  }
  return n;
}
