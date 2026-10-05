// Signed Agent Cards (A2A 0.3 §8.4, task #3588): the card at /.well-known/agent-card.json carries a detached JWS
// (ES256) over its RFC 8785 (JCS) form without `signatures`, and the public key is at /.well-known/jwks.json, so an A2A
// client can check the card came from Atteo and wasn't changed on the way.
//
// The key is only ever the A2A_SIGNING_KEY secret (a private EC P-256 JWK, from `node scripts/a2a-key.mjs keygen`).
// Never stored in D1: anyone who can read D1 (a backup, an export) could then forge cards. Without the secret the card
// is served unsigned (no `signatures`, header atteo-card-signature: none) and the key set is empty.

import type { Env } from "./types";

type Jwk = JsonWebKey & { kid?: string };
export interface CardSignature {
  protected: string;
  signature: string;
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const utf8 = (s: string) => new TextEncoder().encode(s);
const EC = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIG = { name: "ECDSA", hash: "SHA-256" } as const;

/**
 * RFC 8785 (JCS): object keys sorted by UTF-16 code units, no whitespace; strings and numbers as ECMAScript's
 * JSON.stringify writes them (which is what the RFC specifies). Undefined members are left out, as JSON does.
 */
export function jcs(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error("JCS: numbers must be finite");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : jcs(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`)
    .join(",")}}`;
}

/** RFC 7638 thumbprint of an EC public key (base64url SHA-256): the key's id. */
export async function thumbprint(jwk: Jwk): Promise<string> {
  const canon = `{"crv":${JSON.stringify(jwk.crv)},"kty":${JSON.stringify(jwk.kty)},"x":${JSON.stringify(jwk.x)},"y":${JSON.stringify(jwk.y)}}`;
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(canon))));
}

export const publicJwk = (jwk: Jwk): Jwk => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });

/** A new private key, as a JWK with its kid (what scripts/a2a-key.mjs keygen prints for the secret). */
export async function generateSigningKey(): Promise<Jwk> {
  const kp = (await crypto.subtle.generateKey(EC, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as Jwk;
  const priv: Jwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d };
  return { ...priv, kid: await thumbprint(priv) };
}

// Fields of an A2A 0.3 card that a verifier drops when they hold their default (a2a-sdk 0.3's AgentCard model:
// protocolVersion, preferredTransport, and each security scheme's type).
const CARD_DEFAULTS: Record<string, string> = { protocolVersion: "0.3.0", preferredTransport: "JSONRPC" };
const SCHEME_TYPES = new Set(["http", "apiKey", "oauth2", "openIdConnect", "mutualTLS"]);

/** Empty strings, lists and objects removed, all the way down (what a verifier does before canonicalizing). */
function clean(v: unknown): unknown {
  if (Array.isArray(v)) {
    const a = v.map(clean).filter((x) => x !== undefined);
    return a.length ? a : undefined;
  }
  if (v && typeof v === "object") {
    const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)] as const).filter(([, x]) => x !== undefined));
    return Object.keys(o).length ? o : undefined;
  }
  return v === "" || v === null ? undefined : v;
}

/**
 * The payload a card is signed over (A2A §8.4.1): the card without `signatures`, without fields that hold their
 * default, without empty values, in JCS form. This is byte for byte what the reference verifier (a2a-sdk 0.3's
 * canonicalize_agent_card) rebuilds from the card it fetched, as long as the card's text is ASCII (that one escapes
 * the rest); cardsign.test.ts holds its output for our card.
 */
export const cardPayload = (card: Record<string, unknown>) => {
  const { signatures: _s, ...rest } = card;
  for (const [k, d] of Object.entries(CARD_DEFAULTS)) if (rest[k] === d) delete rest[k];
  if (rest.securitySchemes && typeof rest.securitySchemes === "object") {
    rest.securitySchemes = Object.fromEntries(
      Object.entries(rest.securitySchemes as Record<string, Record<string, unknown>>).map(([name, sc]) => {
        const { type, ...more } = sc;
        return [name, typeof type === "string" && SCHEME_TYPES.has(type) ? more : sc];
      }),
    );
  }
  return jcs(clean(rest) ?? {});
};

export async function signCard<T extends Record<string, unknown>>(card: T, key: Jwk, jku: string): Promise<T & { signatures: CardSignature[] }> {
  const priv = await crypto.subtle.importKey("jwk", { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d }, EC, false, ["sign"]);
  const header = b64url(utf8(JSON.stringify({ alg: "ES256", typ: "JOSE", kid: key.kid ?? (await thumbprint(key)), jku })));
  const input = `${header}.${b64url(utf8(cardPayload(card)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign(SIG, priv, utf8(input))); // r‖s, as JWS ES256 wants
  const { signatures: _s, ...rest } = card;
  return { ...(rest as T), signatures: [{ protected: header, signature: b64url(sig) }] };
}

/** What a client does (§8.4.3): the signature's key from the key set by kid, then the signature over the card. */
export async function verifyCard(card: Record<string, unknown>, keys: { keys: Jwk[] }): Promise<boolean> {
  const sigs = (card.signatures ?? []) as CardSignature[];
  for (const s of sigs) {
    try {
      const h = JSON.parse(new TextDecoder().decode(unb64url(s.protected))) as { alg?: string; kid?: string };
      const k = h.alg === "ES256" ? keys.keys.find((x) => x.kid === h.kid) : undefined;
      if (!k) continue;
      const pub = await crypto.subtle.importKey("jwk", publicJwk(k), EC, false, ["verify"]);
      if (await crypto.subtle.verify(SIG, pub, unb64url(s.signature), utf8(`${s.protected}.${b64url(utf8(cardPayload(card)))}`))) return true;
    } catch {}
  }
  return false;
}

// ---------- the server's key ----------

let cached: { secret: string; key: Jwk } | null = null;

/** The signing key from the A2A_SIGNING_KEY secret, or null when it isn't set (or isn't a P-256 private key). */
export async function signingKey(env: Env): Promise<Jwk | null> {
  const secret = env.A2A_SIGNING_KEY?.trim();
  if (!secret) return null;
  if (cached?.secret === secret) return cached.key;
  try {
    const j = JSON.parse(secret) as Jwk;
    if (j.kty !== "EC" || j.crv !== "P-256" || !j.d || !j.x || !j.y) throw new Error("not an EC P-256 private key");
    const key = { kty: j.kty, crv: j.crv, x: j.x, y: j.y, d: j.d, kid: await thumbprint(j) };
    cached = { secret, key };
    return key;
  } catch (e) {
    console.error(`A2A_SIGNING_KEY: ${e instanceof Error ? e.message : String(e)}; the Agent Card is served unsigned`);
    return null;
  }
}

/** /.well-known/jwks.json: the public half only; no keys when cards aren't signed. */
export async function jwks(env: Env): Promise<{ keys: Jwk[] }> {
  const k = await signingKey(env);
  return { keys: k ? [{ ...publicJwk(k), kid: k.kid, use: "sig", alg: "ES256" }] : [] };
}
