// PACT (docs/PACT.md, openpactprotocol.org): a person's agent on Atteo talking to a business's agent (a Brand) over
// A2A 1.0 HTTP+JSON, signed in as Atteo the personal-agent platform. This is the Identity profile: every request
// carries a short-lived ES256 JWT (iss = Atteo, sub = an opaque id for the person, aud = what the Provider assigned
// us), signed with the A2A_SIGNING_KEY whose public half is already at /.well-known/jwks.json.
//
// Nothing leaves without the person: the first call checks the card and makes an approval that shows the exact
// message and where it goes; only a second call with that approved id sends it, once, exactly as approved.
// Replies are the business's words: untrusted data, posted to the board like any member's text.

import * as approvals from "./approvals";
import { b64url, jcs, signingKey, utf8 } from "./cardsign";
import { egressRefusal, type Later } from "./observe";
import type { Env } from "./types";

export class PactError extends Error {}

export const JWT_TTL_S = 120; // PACT §3.2: at most 300
export const MAX_TEXT = 4000;
const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 10_000;

// ---------- identity ----------

/** One personal-agent JWT (PACT §3.2), signed with the server's key. */
export async function signPaJwt(env: Env, c: { iss: string; sub: string; aud: string; now?: number }): Promise<string> {
  const key = await signingKey(env);
  if (!key) throw new PactError("Atteo has no signing key set (A2A_SIGNING_KEY), so it can't sign in to other agents.");
  const iat = Math.floor((c.now ?? Date.now()) / 1000);
  const header = b64url(utf8(JSON.stringify({ alg: "ES256", typ: "JWT", kid: key.kid })));
  const jti = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const body = b64url(utf8(JSON.stringify({ iss: c.iss, sub: c.sub, aud: c.aud, iat, exp: iat + JWT_TTL_S, jti })));
  const priv = await crypto.subtle.importKey("jwk", { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, utf8(`${header}.${body}`)));
  return `${header}.${body}.${b64url(sig)}`;
}

/** The id a provider sees for this person: random, one per provider (providers can't link people across each other). */
export async function subjectFor(env: Env, user: string, provider: string): Promise<string> {
  const fresh = `u_${b64url(crypto.getRandomValues(new Uint8Array(16)))}`;
  await env.DB.prepare(`INSERT OR IGNORE INTO pact_subjects (user, provider, sub, created_at) VALUES (?, ?, ?, ?)`).bind(user, provider, fresh, Date.now()).run();
  const row = await env.DB.prepare(`SELECT sub FROM pact_subjects WHERE user = ? AND provider = ?`).bind(user, provider).first<{ sub: string }>();
  return row?.sub ?? fresh;
}

export interface Provider {
  origin: string;
  audience: string;
  name: string | null;
}

/** The provider an interface URL belongs to, if we've registered with it (docs/PACT.md: added by hand). */
export async function providerFor(env: Env, interfaceUrl: string): Promise<Provider | null> {
  return (await env.DB.prepare(`SELECT origin, audience, name FROM pact_providers WHERE origin = ?`).bind(new URL(interfaceUrl).origin).first<Provider>()) ?? null;
}

// ---------- the brand's card ----------

/** An outside URL we may fetch: https, a DNS name (no IP literals, no local or internal names), no credentials. */
export function publicUrl(raw: string, what = "URL"): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PactError(`That ${what} isn't a URL: ${raw.slice(0, 200)}`);
  }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== "https:") throw new PactError(`The ${what} must be https.`);
  if (u.username || u.password) throw new PactError(`The ${what} can't carry a username or password.`);
  if (!h.includes(".") || /^[\d.]+$/.test(h) || h.startsWith("[") || /(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(h)) throw new PactError(`The ${what} must be a public host name.`);
  return u;
}

/** GET or POST to an outside agent: no redirects (they could point anywhere), a timeout, a size cap. */
async function outbound(url: string, init: RequestInit = {}): Promise<{ status: number; headers: Headers; body: unknown; text: string }> {
  let r: Response;
  try {
    r = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new PactError(`Couldn't reach ${new URL(url).host}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (r.status >= 300 && r.status < 400) throw new PactError(`${new URL(url).host} answered with a redirect; PACT agents don't redirect, so nothing was followed.`);
  if (Number(r.headers.get("content-length") ?? 0) > MAX_BODY) throw new PactError(`${new URL(url).host} sent more than ${MAX_BODY / 1024} KB.`);
  const text = await r.text();
  if (text.length > MAX_BODY) throw new PactError(`${new URL(url).host} sent more than ${MAX_BODY / 1024} KB.`);
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, headers: r.headers, body, text };
}

export interface Card {
  name?: string;
  supportedInterfaces?: { url?: string; protocolBinding?: string; protocolVersion?: string }[];
  securitySchemes?: Record<string, { httpAuthSecurityScheme?: { scheme?: string; bearerFormat?: string } }>;
}

/** The card URL people give: a brand domain, or the card's full URL. */
export function cardUrl(raw: string): string {
  const s = raw.trim();
  const u = publicUrl(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`, "Agent Card URL");
  if (u.pathname === "/" && !u.search) u.pathname = "/.well-known/agent-card.json";
  return u.toString();
}

export async function fetchCard(url: string): Promise<Card> {
  const r = await outbound(url, { headers: { accept: "application/json" } });
  if (r.status === 404) throw new PactError(`No Agent Card at ${url} (404): that business isn't on a PACT provider, or the address is wrong.`);
  if (r.status !== 200 || !r.body || typeof r.body !== "object") throw new PactError(`${new URL(url).host} didn't return an Agent Card (HTTP ${r.status}).`);
  return r.body as Card;
}

/** The interface PACT speaks (HTTP+JSON, A2A 1.0), and that it takes a personal-agent JWT. */
export function interfaceOf(card: Card): string {
  const i = (card.supportedInterfaces ?? []).find((x) => x?.protocolBinding === "HTTP+JSON" && x?.protocolVersion === "1.0" && typeof x.url === "string");
  if (!i?.url) throw new PactError(`${card.name ?? "That agent"} doesn't offer an A2A 1.0 HTTP+JSON interface, so it isn't a PACT agent.`);
  const pa = Object.values(card.securitySchemes ?? {}).some((s) => s?.httpAuthSecurityScheme?.scheme?.toLowerCase() === "bearer" && s.httpAuthSecurityScheme.bearerFormat === "JWT");
  if (!pa) throw new PactError(`${card.name ?? "That agent"} doesn't accept a personal-agent JWT (no Bearer JWT security scheme).`);
  return publicUrl(i.url.replace(/\/+$/, ""), "interface URL").toString().replace(/\/+$/, "");
}

// ---------- messages ----------

export interface Reply {
  text: string;
  contextId: string | null;
  needsAuth?: { scopes: string[]; link: string | null }; // §5.5 step-up: delegated authority, not built yet
}

/** Why a send failed, in words (PACT §6), and whether starting a new conversation would help. */
export function failure(status: number, headers: Headers, body: unknown): { message: string; fresh: boolean } {
  const host = "The business's agent";
  if (status === 401) return { message: `${host} didn't accept Atteo's sign-in (401). Atteo may not be registered with this provider yet.`, fresh: false };
  if (status === 429) return { message: `${host} is rate-limiting us; try again in ${headers.get("retry-after") ?? "a minute"}s.`, fresh: false };
  const e = (body as { error?: { message?: string; details?: { reason?: string }[] } } | null)?.error;
  const reason = e?.details?.[0]?.reason;
  const said = e?.message ? `: ${String(e.message).slice(0, 200)}` : "";
  if (reason === "UNSUPPORTED_OPERATION") return { message: `${host} closed that conversation${said}.`, fresh: true };
  if (reason === "INVALID_PARAMS") return { message: `${host} refused the message${said}.`, fresh: true };
  if (reason === "CONTENT_TYPE_NOT_SUPPORTED") return { message: `${host} only takes text${said}.`, fresh: false };
  if (reason) return { message: `${host} failed (${reason})${said}.`, fresh: false };
  if (status === 404) return { message: `${host} doesn't know that business (404). Check the card address.`, fresh: false };
  return { message: `${host} answered HTTP ${status}.`, fresh: false };
}

const textOf = (m: { parts?: { text?: unknown }[] } | undefined) => (m?.parts ?? []).map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n");

/** POST {interface}/message:send (PACT §4). Retries once in a new conversation when the old one is closed or unknown. */
export async function sendMessage(interfaceUrl: string, token: () => Promise<string>, text: string, contextId: string | null, messageId: string): Promise<Reply> {
  const once = async (ctx: string | null) => {
    const message = { messageId, role: "ROLE_USER", parts: [{ text }], ...(ctx ? { contextId: ctx } : {}) };
    return outbound(`${interfaceUrl}/message:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token()}`, "a2a-version": "1.0", "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ message }),
    });
  };
  let r = await once(contextId);
  if (r.status !== 200 && contextId && failure(r.status, r.headers, r.body).fresh) r = await once(null);
  if (r.status !== 200) throw new PactError(failure(r.status, r.headers, r.body).message);
  const b = r.body as { message?: { role?: string; contextId?: string; parts?: { text?: unknown }[] }; task?: { contextId?: string; status?: { state?: string; message?: { parts?: { text?: unknown }[] } }; metadata?: Record<string, unknown> } } | null;
  if (b?.message) return { text: textOf(b.message), contextId: b.message.contextId ?? null };
  if (b?.task) {
    const t = b.task;
    const out: Reply = { text: textOf(t.status?.message), contextId: t.contextId ?? null };
    if (t.status?.state === "TASK_STATE_AUTH_REQUIRED") {
      const scopes = t.metadata?.["pact.missingScopes"];
      const link = t.metadata?.["pact.verificationUriComplete"];
      out.needsAuth = { scopes: Array.isArray(scopes) ? scopes.map(String) : [], link: typeof link === "string" ? link : null };
    }
    return out;
  }
  throw new PactError("The business's agent answered without a message.");
}

// ---------- approval-gated sending ----------

/** What the person approves, verbatim: where it goes and exactly what it says. */
export interface Outbound {
  pact: 1;
  to: string; // the brand's name from its card
  card: string;
  interface: string;
  text: string;
  board: string | null;
}

export function approvalFields(o: Outbound): { title: string; details: string; tool: string; command: string; risk: "medium" } {
  return {
    title: `Send a message to ${o.to.slice(0, 80)}'s agent`,
    details: `Your agent wants to message ${o.to}'s agent (${new URL(o.interface).host}) as you. They'll see an anonymous id for you, not your name or email, and only this text:\n\n${o.text}`,
    tool: "pact",
    command: jcs(o),
    risk: "medium",
  };
}

/** Step 1: find the brand's PACT interface, check we can sign in there, and describe the send for the person. */
export async function prepare(env: Env, later: Later | null, r: { card: string; text: string; board: string | null }): Promise<Outbound> {
  const text = r.text.trim();
  if (!text) throw new PactError("Nothing to send: text is empty.");
  if (text.length > MAX_TEXT) throw new PactError(`Keep it under ${MAX_TEXT} characters.`);
  const blocked = egressRefusal(env, later, { text });
  if (blocked) throw new PactError(blocked);
  const card = cardUrl(r.card);
  const c = await fetchCard(card);
  const iface = interfaceOf(c);
  if (!(await providerFor(env, iface))) throw new PactError(`Atteo isn't registered with ${new URL(iface).host} yet, so it can't sign in there. (docs/PACT.md: registering with a provider.)`);
  const to = (typeof c.name === "string" && c.name.trim() ? c.name.trim() : new URL(card).hostname).replace(/\s+/g, " ").slice(0, 120);
  return { pact: 1, to, card, interface: iface, text, board: r.board };
}

/** Step 2: send exactly what the person approved, once. */
export async function sendApproved(env: Env, user: string, issuer: string, approvalId: string): Promise<{ o: Outbound; reply: Reply }> {
  const a = await approvals.getApproval(env, user, approvalId);
  if (!a || a.tool !== "pact" || !a.command) throw new PactError("No such PACT approval.");
  let o: Outbound;
  try {
    o = JSON.parse(a.command) as Outbound;
  } catch {
    throw new PactError("That approval isn't a PACT send.");
  }
  const f = o?.pact === 1 && typeof o.interface === "string" && typeof o.text === "string" ? approvalFields(o) : null;
  // The approval must be exactly one this module made: the command, title and details the person saw all match.
  if (!f || f.command !== a.command || f.title !== a.title || f.details !== a.details) throw new PactError("That approval isn't a PACT send Atteo prepared; ask again with agents {action: \"call\"}.");
  const d = approvals.decision(a);
  if (d.decision !== "approved") throw new PactError(d.decision === "pending" ? `Not approved yet: wait with approval {id: "${a.id}", action: "wait"}.` : `Denied (${d.reason}). Don't send it.`);
  publicUrl(o.interface, "interface URL");
  const p = await providerFor(env, o.interface);
  if (!p) throw new PactError(`Atteo isn't registered with ${new URL(o.interface).host} any more.`);
  const spent = await env.DB.prepare(`INSERT OR IGNORE INTO pact_sends (approval_id, user, interface_url, sent_at) VALUES (?, ?, ?, ?)`).bind(a.id, user, o.interface, Date.now()).run();
  if (!spent.meta?.changes) throw new PactError(`Already sent with ${a.id}; each approval sends once.`);
  const sub = await subjectFor(env, user, p.origin);
  const prev = await env.DB.prepare(`SELECT context_id FROM pact_contexts WHERE user = ? AND interface_url = ?`).bind(user, o.interface).first<{ context_id: string }>();
  let reply: Reply;
  try {
    reply = await sendMessage(o.interface, () => signPaJwt(env, { iss: issuer, sub, aud: p.audience }), o.text, prev?.context_id ?? null, `atteo-${a.id}`);
  } catch (e) {
    await env.DB.prepare(`UPDATE pact_sends SET status = 0 WHERE approval_id = ?`).bind(a.id).run();
    throw e;
  }
  await env.DB.prepare(`UPDATE pact_sends SET status = 1 WHERE approval_id = ?`).bind(a.id).run();
  if (reply.contextId) {
    await env.DB.prepare(`INSERT INTO pact_contexts (user, interface_url, context_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user, interface_url) DO UPDATE SET context_id = excluded.context_id, updated_at = excluded.updated_at`)
      .bind(user, o.interface, reply.contextId, Date.now())
      .run();
  }
  return { o, reply };
}
