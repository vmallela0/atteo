// OAuth Client ID Metadata Documents (CIMD; vedu #6575): an MCP client (Smithery Connect, and others) can skip
// registration and use an https URL as its client_id. That URL serves a JSON document naming the client and its
// redirect_uris; we fetch it server-side, check it, and cache it briefly.
//
// Spec: MCP 2026-07-28, basic/authorization/client-registration (CIMD section) and its security considerations;
// draft-ietf-oauth-client-id-metadata-document-02 for the fetch and validation rules.
//
// The fetch is the risky part (it runs inside our Worker, on a URL someone else picked), so:
// - the URL must be canonical https on a public host name: no IP literal, no localhost or private suffix, no
//   credentials, port, query or fragment, a real path, and never our own host (a document there would show our own
//   domain on the consent page);
// - redirects are never followed, the timeout is short, at most CIMD_MAX_BYTES are read (before parsing), the answer
//   must be 200 with a JSON content type, and the request carries no cookies or credentials;
// - only good documents are cached, per URL, for what Cache-Control allows, capped at an hour.
// Workers can't resolve DNS before a fetch, so a public name that resolves to a private address can't be refused by
// address here; Workers' own egress can't reach private networks, which is what covers that case.

import { stripInvisible } from "./util";

export const CIMD_MAX_BYTES = 5 * 1024; // the draft's recommended maximum
export const CIMD_TIMEOUT_MS = 5000;
export const CIMD_DEFAULT_TTL_S = 300; // no Cache-Control (Smithery sends none): five minutes
export const CIMD_MAX_TTL_S = 3600;
const CACHE_MAX = 500;
const MAX_REDIRECTS = 20;

export interface CimdClient {
  client_id: string;
  name: string;
  /** The client_id URL's host: what the consent page shows, so a lookalike name can't pass for someone else. */
  host: string;
  redirect_uris: string[];
}

export class CimdError extends Error {
  constructor(readonly code: "invalid_client" | "temporarily_unavailable", message: string, readonly status = 400) {
    super(message);
  }
}

export interface CimdOptions {
  /** Our own host names (the public origin's and the request's): a client_id there is refused. */
  ownHosts: string[];
  /** Local test servers only (ALLOW_LOCAL_WEBHOOKS=1 on a loopback origin): http(s)://localhost client_ids. */
  allowLocal?: boolean;
  /** Asked before each fetch the cache can't answer, with the client_id URL (oauth.ts cimdFetchCap: per client_id
   *  everywhere, and per person at /authorize); false refuses with a 429 and nothing is fetched. */
  beforeFetch?: (clientId: string) => Promise<boolean>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** A client_id with a scheme (anything with a colon) takes the CIMD path, and is checked strictly there. DCR ids are `oc_…`. */
export const isCimdClientId = (id: string): boolean => id.includes(":");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Names that are local, private or reserved, never a public client's home (RFC 6761, RFC 6762, RFC 8375 and common
// private suffixes).
const PRIVATE_SUFFIX = /(^|\.)(localhost|localdomain|local|internal|intranet|lan|home|corp|private|arpa|test|example|invalid|onion)$/;

/** Checks the client_id URL itself, before anything is fetched. Returns the parsed URL. */
export function checkClientIdUrl(raw: string, o: Pick<CimdOptions, "ownHosts" | "allowLocal">): URL {
  const bad = (why: string) => new CimdError("invalid_client", `The app's client_id ${why}.`);
  if (raw.length > 2048) throw bad("is too long");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw bad("isn't a URL");
  }
  const h = u.hostname.toLowerCase();
  const local = !!o.allowLocal && LOOPBACK.has(h) && (u.protocol === "http:" || u.protocol === "https:");
  if (u.protocol !== "https:" && !local) throw bad("must be an https URL");
  if (u.username || u.password) throw bad("can't contain a username or password");
  if (raw.includes("#")) throw bad("can't contain a fragment");
  if (raw.includes("?")) throw bad("can't contain a query");
  if (u.port && !local) throw bad("can't name a port");
  if (u.pathname === "/" || !u.pathname) throw bad("needs a path, like https://example.com/client.json");
  // Simple string comparison is the rule, so only the canonical spelling is accepted: no dot segments (also
  // percent-encoded), no upper-case or Unicode host (punycode only), no default port, no stray characters.
  if (u.href !== raw) throw bad("must be written in canonical form");
  if (!local) {
    if (!h.includes(".") || h.endsWith(".") || /^[\d.]+$/.test(h) || h.startsWith("[") || h.includes(":") || PRIVATE_SUFFIX.test(h)) throw bad("must be on a public host name (not an IP address or a local name)");
    for (const own of o.ownHosts.map((x) => x.toLowerCase()).filter(Boolean)) if (h === own || h.endsWith(`.${own}`)) throw bad("can't be on Atteo's own host");
  }
  return u;
}

/** CIMD redirect URIs: https, or http on the same machine (MCP: "either localhost or HTTPS"). No app links: those are
 *  for registered native apps, and a document anyone can host must not be able to name the Atteo app's own. */
export function cimdRedirectOk(r: string): boolean {
  let x: URL;
  try {
    x = new URL(r);
  } catch {
    return false;
  }
  if (x.hash || x.username || x.password || /\s/.test(r) || r.includes("#")) return false;
  if (x.protocol === "https:") return true;
  return x.protocol === "http:" && LOOPBACK.has(x.hostname);
}

/** client_name as display text: no control, bidi, zero-width or tag characters (util.ts stripInvisible), collapsed,
 *  at most 60 characters. Escaped where shown. Registered (DCR) clients' names go through here too. */
export function cleanName(v: unknown, fallback: string): string {
  if (typeof v !== "string") return fallback;
  const s = stripInvisible(v.replace(/\s+/g, " ")).replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return s || fallback;
}

/** Seconds to cache a good document for: Cache-Control max-age within [0, an hour]; no-store/no-cache: not at all. */
export function cacheSeconds(cc: string | null): number {
  const v = (cc ?? "").toLowerCase();
  if (/(^|[\s,])(no-store|no-cache)\b/.test(v)) return 0;
  const m = /(^|[\s,])max-age\s*=\s*"?(\d+)/.exec(v);
  const n = m ? Number(m[2]) : CIMD_DEFAULT_TTL_S;
  return Math.max(0, Math.min(CIMD_MAX_TTL_S, Number.isFinite(n) ? n : 0));
}

const cache = new Map<string, { client: CimdClient; until: number }>();
/** Tests only. */
export function clearCimdCache(): void {
  cache.clear();
}

/** The body, read a chunk at a time and dropped past `max` bytes: a missing or false content-length can't make us hold more. */
async function readCapped(r: Response, max: number): Promise<string> {
  const big = () => new CimdError("invalid_client", `The app's metadata document is larger than ${max / 1024} KB.`);
  if (Number(r.headers.get("content-length") ?? 0) > max) {
    await r.body?.cancel().catch(() => {});
    throw big();
  }
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw big();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(all);
}

/** Checks a fetched document against the URL it came from. */
export function validateDocument(url: string, host: string, doc: unknown): CimdClient {
  const bad = (why: string) => new CimdError("invalid_client", `The app's metadata document ${why}.`);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw bad("isn't a JSON object");
  const d = doc as Record<string, unknown>;
  if (d.client_id !== url) throw bad("names a different client_id than its own URL");
  // Shared secrets can't exist without registration; a document that carries one is broken or hostile.
  if ("client_secret" in d || "client_secret_expires_at" in d) throw bad("must not contain a client_secret");
  const auth = d.token_endpoint_auth_method;
  if (auth === "private_key_jwt") throw bad("asks for private_key_jwt client authentication, which Atteo doesn't support (use \"none\" with PKCE)");
  if (auth !== undefined && auth !== "none") throw bad(`asks for token_endpoint_auth_method ${JSON.stringify(String(auth)).slice(0, 40)}; Atteo supports only "none" (public clients, PKCE)`);
  if (d.grant_types !== undefined && !(Array.isArray(d.grant_types) && d.grant_types.includes("authorization_code"))) throw bad("doesn't allow the authorization_code grant");
  if (d.response_types !== undefined && !(Array.isArray(d.response_types) && d.response_types.includes("code"))) throw bad("doesn't allow response_type code");
  if (!Array.isArray(d.redirect_uris)) throw bad("has no redirect_uris");
  const redirect_uris = d.redirect_uris.filter((r): r is string => typeof r === "string" && r.length <= 2048 && cimdRedirectOk(r)).slice(0, MAX_REDIRECTS);
  if (!redirect_uris.length) throw bad("has no usable redirect_uris (https, or http://localhost)");
  return { client_id: url, name: cleanName(d.client_name, host), host, redirect_uris };
}

/** The client behind a URL client_id: from the cache, or fetched and checked now. Throws CimdError. */
export async function resolveCimdClient(raw: string, o: CimdOptions): Promise<CimdClient> {
  const u = checkClientIdUrl(raw, o);
  const now = (o.now ?? Date.now)();
  const hit = cache.get(raw);
  if (hit && hit.until > now) return hit.client;
  if (hit) cache.delete(raw);
  const host = u.host;
  if (o.beforeFetch && !(await o.beforeFetch(raw))) throw new CimdError("temporarily_unavailable", "Too many app lookups in a row. Try again in a few minutes.", 429);
  const down = (why: string) => new CimdError("temporarily_unavailable", `Couldn't read the app's metadata document at ${host} (${why}). Try again in a minute.`, 503);
  let r: Response;
  try {
    // No cookies, no credentials, no Authorization: a plain GET. Redirects are returned, not followed.
    r = await (o.fetch ?? fetch)(raw, { method: "GET", redirect: "manual", headers: { accept: "application/json" }, signal: AbortSignal.timeout(o.timeoutMs ?? CIMD_TIMEOUT_MS) });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw down(timeout ? "it took too long" : "it couldn't be reached");
  }
  try {
    if (r.status >= 300 && r.status < 400) throw new CimdError("invalid_client", `The app's metadata document at ${host} redirects; redirects aren't followed.`);
    if (r.status >= 500) throw down(`HTTP ${r.status}`);
    if (r.status !== 200) throw new CimdError("invalid_client", `The app's metadata document at ${host} answered HTTP ${r.status}.`);
    const type = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json" && !/^application\/[a-z0-9.+-]+\+json$/.test(type)) throw new CimdError("invalid_client", `The app's metadata document at ${host} isn't JSON (content-type ${type || "missing"}).`);
    let text: string;
    try {
      text = await readCapped(r, CIMD_MAX_BYTES);
    } catch (e) {
      if (e instanceof CimdError) throw e;
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw timeout ? down("it took too long") : new CimdError("invalid_client", `The app's metadata document at ${host} couldn't be read.`);
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new CimdError("invalid_client", `The app's metadata document at ${host} isn't valid JSON.`);
    }
    const client = validateDocument(raw, host, doc);
    const ttl = cacheSeconds(r.headers.get("cache-control"));
    if (ttl > 0) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(raw, { client, until: now + ttl * 1000 });
    }
    return client;
  } finally {
    await r.body?.cancel().catch(() => {});
  }
}
